import type { Principal } from '@genai/contracts';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { actorOf, AdminRefused, routeOnlyActions } from './admin.js';
import {
  appendVersion,
  platformScope,
  serialized,
  VersionConflict,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import {
  demoIdPattern,
  demoKind,
  demoSettings,
  demoSpec,
  isOpen,
  isRecorderKey,
  latestSettings,
  latestDemo,
  latestDemos,
  latestRecording,
  latestRecordings,
  mayEditDemos,
  mayViewDemos,
  problemsOf,
  readDemo,
  recorderPrincipal,
  recordingBlobPath,
  recordingFileType,
  recordingFinish,
  recordingKind,
  recordingRequest,
  recordingStart,
  settingsId,
  settingsKind,
  settingsOf,
  type DemoProblem,
  type DemoSettings,
  type DemoSpec,
  type RecordingSpec,
} from './demos.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { documentDemoRoutes } from './openapi/demos.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const demoActions = [
  'platform.demo.save',
  'platform.demo.recording.start',
  'platform.demo.recording.finish',
] as const;

const titles = {
  400: 'Invalid request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  503: 'Service unavailable',
} as const;

type Status = keyof typeof titles;

export const recorderKeyType = 'urn:genai:problem:recorder-key';
export const recordingFinishedType = 'urn:genai:problem:recording-finished';
export const fileTooLargeType = 'urn:genai:problem:file-too-large';
export const recorderNotSetUpType = 'urn:genai:problem:recorder-not-set-up';
export const recordingOpenType = 'urn:genai:problem:recording-open';

export type RecorderMode = 'job' | 'workflow';

class DemoRefused extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const problem = (c: Context, status: Status, errors: DemoProblem[] = [], type = 'about:blank') =>
  c.json({ type, title: titles[status], status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const recordingView = (entry: ConfigEntry<RecordingSpec>) => ({ id: entry.id, ...entry.spec });

const demoView = (entry: ConfigEntry<DemoSpec>) => ({
  id: entry.id,
  version: entry.version,
  updatedBy: entry.by,
  updatedAt: entry.at,
  ...entry.spec,
});

const newestFirst = (a: ConfigEntry<RecordingSpec>, b: ConfigEntry<RecordingSpec>) =>
  b.spec.startedAt.localeCompare(a.spec.startedAt);

const isTrial = (r: ConfigEntry<RecordingSpec>) => r.spec.upTo !== undefined;

const recordingsOf = async (store: ConfigEntryStore, demo?: string) =>
  (await latestRecordings(store))
    .filter((r) => demo === undefined || r.spec.demo === demo)
    .sort(newestFirst);

const bodyOf = async (c: Context) => {
  if ((c.req.header('content-type') ?? '').includes('yaml')) {
    const read = readDemo(await c.req.text());
    return read.ok ? { ok: true as const, spec: read.spec } : read;
  }
  const parsed = demoSpec.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success
    ? { ok: true as const, spec: parsed.data }
    : { ok: false as const, errors: problemsOf(parsed.error) };
};

export interface DemosOptions {
  now?: () => Date;
  /** Hands a queued recording to the recorder job; without it recordings come from the workflow. */
  sendRecording?: (recording: string) => Promise<void>;
}

export const createDemosModule =
  (options: DemosOptions = {}): PlatformModuleFactory =>
  (deps) => {
    const now = options.now ?? (() => new Date());
    const store = deps.configEntries;
    const tenant = deps.platformTenant;
    const one = serialized();
    const mode: RecorderMode = options.sendRecording ? 'job' : 'workflow';

    const viewer = async (c: Context, mounted: MountDeps, edit = false) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return { response: problem(c, 401) };
      if (!(edit ? mayEditDemos(principal) : mayViewDemos(principal)))
        return { response: problem(c, 403) };
      return { principal };
    };

    const recorder = (c: Context) =>
      isRecorderKey(c.req.header('x-recorder-key'), deps.demoRecorderKeyDigest)
        ? recorderPrincipal(tenant)
        : undefined;

    const update = (
      current: ConfigEntry<RecordingSpec>,
      spec: RecordingSpec,
      by: string,
      reason: string,
    ) =>
      appendVersion<RecordingSpec>(store, {
        kind: recordingKind,
        scope: platformScope,
        id: current.id,
        spec,
        deleted: false,
        by,
        reason,
        ifVersion: current.version,
      });

    const finished = (c: Context) =>
      problem(
        c,
        409,
        [{ path: 'status', message: 'the recording has finished' }],
        recordingFinishedType,
      );

    const running = async (c: Context) => {
      const found = await latestRecording(store, c.req.param('id') ?? '');
      if (!found) return { response: problem(c, 404) };
      if (found.spec.status !== 'running') return { response: finished(c) };
      return { found };
    };

    const conflictOr = (c: Context, error: unknown) => {
      if (error instanceof VersionConflict)
        return problem(c, 409, [{ path: 'version', message: error.message }]);
      if (error instanceof AdminRefused)
        return problem(c, error.status === 403 ? 403 : 400, error.errors);
      throw error;
    };

    return {
      id: 'demos',
      handlers: routeOnlyActions(demoActions),
      mount: (app, mounted) => {
        const audited = <T>(
          principal: Principal,
          action: (typeof demoActions)[number],
          reason: string,
          target: string,
          work: () => Promise<T>,
        ) =>
          mounted.admin.within(
            { ...principal, tenant },
            action,
            { tenant, reason, target },
            async () => ({ value: await work(), target }),
          );

        app.get('/operator/demos', async (c) => {
          const g = await viewer(c, mounted);
          if ('response' in g) return g.response;
          const recordings = await recordingsOf(store);
          const data = (await latestDemos(store))
            .sort((a, b) => a.spec.title.localeCompare(b.spec.title, 'nb'))
            .map((demo) => {
              const own = recordings.filter((r) => r.spec.demo === demo.id);
              const full = own.filter((r) => !isTrial(r) && r.spec.status !== 'cancelled');
              const latest = full.find((r) => !isOpen(r.spec));
              const recorded = full.find((r) => r.spec.status === 'recorded');
              const open = own.find((r) => isOpen(r.spec));
              return {
                ...demoView(demo),
                ...(latest ? { latest: recordingView(latest) } : {}),
                ...(recorded ? { recorded: recordingView(recorded) } : {}),
                ...(open ? { open: recordingView(open) } : {}),
              };
            });
          return c.json({ genkiVersion: deps.appVersion ?? null, recorder: mode, data });
        });

        app.get('/operator/demos/:id', async (c) => {
          const g = await viewer(c, mounted);
          if ('response' in g) return g.response;
          const demo = await latestDemo(store, c.req.param('id') ?? '');
          if (!demo) return problem(c, 404);
          return c.json({
            ...demoView(demo),
            genkiVersion: deps.appVersion ?? null,
            recorder: mode,
            recordings: (await recordingsOf(store, demo.id)).map(recordingView),
          });
        });

        app.put('/operator/demos/:id', async (c) => {
          const g = await viewer(c, mounted, true);
          if ('response' in g) return g.response;
          const id = c.req.param('id') ?? '';
          if (!demoIdPattern.test(id))
            return problem(c, 400, [{ path: 'id', message: 'a demo id is a lowercase slug' }]);
          const reason = changeReasonOf(c) ?? '';
          if (!isReasonLongEnough(reason))
            return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
          const body = await bodyOf(c);
          if (!body.ok) return problem(c, 400, body.errors);
          const ifMatch = c.req.header('if-match')?.replace(/"/g, '');
          const expected = ifMatch === undefined ? undefined : Number(ifMatch);
          if (expected !== undefined && !Number.isInteger(expected))
            return problem(c, 400, [{ path: 'if-match', message: 'if-match is a version number' }]);
          const existed = (await store.history(demoKind, platformScope, id)).length > 0;
          try {
            const done = await audited(
              g.principal,
              'platform.demo.save',
              reason,
              `demo:${id}`,
              () =>
                one(() =>
                  appendVersion<DemoSpec>(store, {
                    kind: demoKind,
                    scope: platformScope,
                    id,
                    spec: body.spec,
                    deleted: false,
                    by: actorOf(g.principal),
                    reason,
                    ...(expected !== undefined ? { ifVersion: expected } : {}),
                  }),
                ),
            );
            c.header('genai-task', done.task);
            return c.json(demoView(done.value), existed ? 200 : 201);
          } catch (error) {
            return conflictOr(c, error);
          }
        });

        app.get('/operator/recordings/:id', async (c) => {
          const g = await viewer(c, mounted);
          if ('response' in g) return g.response;
          const found = await latestRecording(store, c.req.param('id') ?? '');
          return found ? c.json(recordingView(found)) : problem(c, 404);
        });

        app.get('/operator/recordings/:id/files/:name', async (c) => {
          const g = await viewer(c, mounted);
          if ('response' in g) return g.response;
          const found = await latestRecording(store, c.req.param('id') ?? '');
          const name = c.req.param('name') ?? '';
          const file = found?.spec.files.find((f) => f.name === name);
          if (!found || !file) return problem(c, 404);
          const blob = await deps.blobs.get({
            tenant,
            path: recordingBlobPath(found.id, file.name),
          });
          if (!blob) return problem(c, 404);
          return c.body(blob.body as Uint8Array<ArrayBuffer>, 200, {
            'content-type': file.contentType,
            'content-length': String(blob.body.byteLength),
            'content-disposition': `inline; filename="${found.spec.demo}-${file.name}"`,
            'cache-control': 'private, max-age=300',
          });
        });

        app.post('/operator/demos/:id/recordings', async (c) => {
          const g = await viewer(c, mounted, true);
          if ('response' in g) return g.response;
          const reason = changeReasonOf(c) ?? '';
          if (!isReasonLongEnough(reason))
            return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
          const demo = await latestDemo(store, c.req.param('id') ?? '');
          if (!demo) return problem(c, 404);
          const body = recordingRequest.safeParse(await c.req.json().catch(() => ({})));
          if (!body.success) return problem(c, 400, problemsOf(body.error));
          const upTo = body.data.upTo;
          if (upTo !== undefined && upTo > demo.spec.steps.length)
            return problem(c, 400, [
              { path: 'upTo', message: `the demo has ${demo.spec.steps.length} steps` },
            ]);
          const send = options.sendRecording;
          if (!send)
            return problem(
              c,
              503,
              [{ path: 'recorder', message: 'recordings are made by the demos workflow' }],
              recorderNotSetUpType,
            );
          const id = crypto.randomUUID();
          try {
            const done = await audited(
              g.principal,
              'platform.demo.recording.start',
              reason,
              `demo-recording:${id}`,
              () =>
                one(async () => {
                  const open = (await recordingsOf(store, demo.id)).find((r) => isOpen(r.spec));
                  if (open)
                    throw new DemoRefused('recording', `recording ${open.id} has not finished`);
                  const settings = await settingsOf(store);
                  return appendVersion<RecordingSpec>(store, {
                    kind: recordingKind,
                    scope: platformScope,
                    id,
                    spec: {
                      demo: demo.id,
                      demoVersion: demo.version,
                      genkiVersion: deps.appVersion ?? 'unknown',
                      status: 'queued',
                      steps: upTo ?? demo.spec.steps.length,
                      narrated: upTo === undefined,
                      ...(upTo === undefined ? { voice: demo.spec.voice ?? settings.voice } : {}),
                      startedAt: now().toISOString(),
                      files: [],
                      requestedBy: actorOf(g.principal),
                      ...(upTo !== undefined ? { upTo } : {}),
                    },
                    deleted: false,
                    by: actorOf(g.principal),
                    reason,
                  });
                }),
            );
            try {
              await send(id);
            } catch {
              await one(async () => {
                const current = await latestRecording(store, id);
                if (current?.spec.status === 'queued')
                  await update(
                    current,
                    {
                      ...current.spec,
                      status: 'failed',
                      finishedAt: now().toISOString(),
                      failure: { step: 0, message: 'the recording could not be handed to the job' },
                    },
                    actorOf(g.principal),
                    'not queued',
                  );
              });
              return problem(
                c,
                503,
                [{ path: 'recorder', message: 'the recording could not be queued' }],
                recorderNotSetUpType,
              );
            }
            c.header('genai-task', done.task);
            return c.json(recordingView(done.value), 202);
          } catch (error) {
            if (error instanceof DemoRefused)
              return problem(
                c,
                409,
                [{ path: error.path, message: error.message }],
                recordingOpenType,
              );
            return conflictOr(c, error);
          }
        });

        app.post('/operator/recordings/:id/cancel', async (c) => {
          const g = await viewer(c, mounted, true);
          if ('response' in g) return g.response;
          const reason = changeReasonOf(c) ?? '';
          if (!isReasonLongEnough(reason))
            return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
          const found = await latestRecording(store, c.req.param('id') ?? '');
          if (!found) return problem(c, 404);
          if (!isOpen(found.spec)) return finished(c);
          try {
            const done = await audited(
              g.principal,
              'platform.demo.recording.finish',
              reason,
              `demo-recording:${found.id}`,
              () =>
                one(async () => {
                  const current = (await latestRecording(store, found.id)) ?? found;
                  if (!isOpen(current.spec))
                    throw new DemoRefused('status', 'the recording has finished');
                  return update(
                    current,
                    {
                      ...current.spec,
                      status: 'cancelled',
                      finishedAt: now().toISOString(),
                      cancelledBy: actorOf(g.principal),
                    },
                    actorOf(g.principal),
                    reason,
                  );
                }),
            );
            c.header('genai-task', done.task);
            return c.json(recordingView(done.value));
          } catch (error) {
            if (error instanceof DemoRefused) return finished(c);
            return conflictOr(c, error);
          }
        });

        const settingsView = async () => {
          const entry = await latestSettings(store);
          const settings = await settingsOf(store);
          const sample = (await recordingsOf(store)).find(
            (r) =>
              r.spec.voice === settings.voice && r.spec.files.some((f) => f.name === 'sample.mp3'),
          );
          return {
            ...settings,
            version: entry?.version ?? 0,
            ...(entry ? { updatedBy: entry.by, updatedAt: entry.at } : {}),
            recorder: mode,
            ...(sample ? { sample: { recording: sample.id, file: 'sample.mp3' } } : {}),
          };
        };

        app.get('/operator/demo-settings', async (c) => {
          const g = await viewer(c, mounted);
          if ('response' in g) return g.response;
          return c.json(await settingsView());
        });

        app.put('/operator/demo-settings', async (c) => {
          const g = await viewer(c, mounted, true);
          if ('response' in g) return g.response;
          const reason = changeReasonOf(c) ?? '';
          if (!isReasonLongEnough(reason))
            return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
          const body = demoSettings.safeParse(await c.req.json().catch(() => undefined));
          if (!body.success) return problem(c, 400, problemsOf(body.error));
          const ifMatch = c.req.header('if-match')?.replace(/"/g, '');
          const expected = ifMatch === undefined ? undefined : Number(ifMatch);
          if (expected !== undefined && !Number.isInteger(expected))
            return problem(c, 400, [{ path: 'if-match', message: 'if-match is a version number' }]);
          try {
            const done = await audited(
              g.principal,
              'platform.demo.save',
              reason,
              'demo-settings',
              () =>
                one(() =>
                  appendVersion<DemoSettings>(store, {
                    kind: settingsKind,
                    scope: platformScope,
                    id: settingsId,
                    spec: body.data,
                    deleted: false,
                    by: actorOf(g.principal),
                    reason,
                    ...(expected !== undefined ? { ifVersion: expected } : {}),
                  }),
                ),
            );
            c.header('genai-task', done.task);
            return c.json(await settingsView());
          } catch (error) {
            return conflictOr(c, error);
          }
        });

        app.get('/recorder/recordings/:id', async (c) => {
          const principal = recorder(c);
          if (!principal) return problem(c, 401, [], recorderKeyType);
          const found = await latestRecording(store, c.req.param('id') ?? '');
          if (!found) return problem(c, 404);
          const version = (await store.history(demoKind, platformScope, found.spec.demo)).find(
            (v) => v.version === found.spec.demoVersion,
          ) as ConfigEntry<DemoSpec> | undefined;
          if (!version) return problem(c, 404);
          const settings = await settingsOf(store);
          return c.json({
            ...recordingView(found),
            demoSpec: version.spec,
            settings: {
              voice: settings.voice,
              viewport: settings.viewport,
              tenant: settings.tenant,
              login: settings.login,
            },
          });
        });

        app.post('/recorder/demos/:id/recordings', async (c) => {
          const principal = recorder(c);
          if (!principal) return problem(c, 401, [], recorderKeyType);
          const demo = await latestDemo(store, c.req.param('id') ?? '');
          if (!demo) return problem(c, 404);
          const body = recordingStart.safeParse(await c.req.json().catch(() => undefined));
          if (!body.success) return problem(c, 400, problemsOf(body.error));
          const claimed = body.data.recording
            ? await latestRecording(store, body.data.recording)
            : undefined;
          if (body.data.recording && (!claimed || claimed.spec.demo !== demo.id))
            return problem(c, 404);
          if (claimed && claimed.spec.status !== 'queued') return finished(c);
          const id = claimed?.id ?? crypto.randomUUID();
          const narrated = body.data.narrated && claimed?.spec.upTo === undefined;
          const spec: RecordingSpec = {
            ...(claimed?.spec ?? {
              demo: demo.id,
              demoVersion: demo.version,
              steps: demo.spec.steps.length,
              files: [],
            }),
            genkiVersion: body.data.genkiVersion,
            status: 'running',
            narrated,
            ...(narrated
              ? {
                  voice: claimed ? (claimed.spec.voice ?? demo.spec.voice) : demo.spec.voice,
                }
              : {}),
            startedAt: now().toISOString(),
          };
          if (!narrated) delete spec.voice;
          try {
            const done = await audited(
              principal,
              'platform.demo.recording.start',
              'recorded by the demo recorder',
              `demo-recording:${id}`,
              () =>
                one(async () => {
                  if (claimed) {
                    const current = (await latestRecording(store, id)) ?? claimed;
                    if (current.spec.status !== 'queued')
                      throw new DemoRefused('status', 'the recording has finished');
                    return update(current, spec, `platform:${principal.subject}`, 'started');
                  }
                  return appendVersion<RecordingSpec>(store, {
                    kind: recordingKind,
                    scope: platformScope,
                    id,
                    spec,
                    deleted: false,
                    by: `platform:${principal.subject}`,
                    reason: `recording of ${demo.id}`,
                  });
                }),
            );
            c.header('genai-task', done.task);
            return c.json(recordingView(done.value), 201);
          } catch (error) {
            if (error instanceof DemoRefused) return finished(c);
            return conflictOr(c, error);
          }
        });

        app.put('/recorder/recordings/:id/files/:name', async (c) => {
          const principal = recorder(c);
          if (!principal) return problem(c, 401, [], recorderKeyType);
          const name = c.req.param('name') ?? '';
          const type = recordingFileType(name);
          if (!type) return problem(c, 404, [{ path: 'name', message: `no file ${name}` }]);
          const tooLarge = (ctx: Context) =>
            problem(
              ctx,
              413,
              [{ path: 'body', message: `${name} is at most ${type.maxBytes} bytes` }],
              fileTooLargeType,
            );
          if (Number(c.req.header('content-length')) > type.maxBytes) return tooLarge(c);
          const g = await running(c);
          if ('response' in g) return g.response;
          let answer: Response | undefined;
          const refused = await bodyLimit({ maxSize: type.maxBytes, onError: tooLarge })(
            c,
            async () => {
              const bytes = new Uint8Array(await c.req.arrayBuffer());
              if (bytes.byteLength === 0) {
                answer = problem(c, 400, [{ path: 'body', message: 'the file is empty' }]);
                return;
              }
              try {
                answer = await one(async () => {
                  const current = (await latestRecording(store, g.found.id)) ?? g.found;
                  if (current.spec.status !== 'running') return finished(c);
                  const info = await deps.blobs.put(
                    { tenant, path: recordingBlobPath(g.found.id, name) },
                    bytes,
                    type.contentType,
                  );
                  const file = { name, size: info.size, contentType: type.contentType };
                  await update(
                    current,
                    {
                      ...current.spec,
                      files: [...current.spec.files.filter((f) => f.name !== name), file],
                    },
                    `platform:${principal.subject}`,
                    `file ${name}`,
                  );
                  return c.json(file, 200);
                });
              } catch (error) {
                answer = conflictOr(c, error);
              }
            },
          );
          return refused ?? answer ?? problem(c, 400);
        });

        app.post('/recorder/recordings/:id/finish', async (c) => {
          const principal = recorder(c);
          if (!principal) return problem(c, 401, [], recorderKeyType);
          const g = await running(c);
          if ('response' in g) return g.response;
          const body = recordingFinish.safeParse(await c.req.json().catch(() => undefined));
          if (!body.success) return problem(c, 400, problemsOf(body.error));
          const { status, seconds, failure } = body.data;
          if (status === 'recorded' && !g.found.spec.files.some((f) => f.name === 'demo.mp4'))
            return problem(c, 400, [
              { path: 'status', message: 'upload demo.mp4 before finishing as recorded' },
            ]);
          if (status === 'failed' && !failure)
            return problem(c, 400, [{ path: 'failure', message: 'a failed recording says why' }]);
          try {
            const done = await audited(
              principal,
              'platform.demo.recording.finish',
              'recorded by the demo recorder',
              `demo-recording:${g.found.id}`,
              () =>
                one(() =>
                  update(
                    g.found,
                    {
                      ...g.found.spec,
                      status,
                      finishedAt: now().toISOString(),
                      ...(seconds !== undefined ? { seconds } : {}),
                      ...(status === 'failed' && failure ? { failure } : {}),
                    },
                    `platform:${principal.subject}`,
                    status,
                  ),
                ),
            );
            c.header('genai-task', done.task);
            return c.json(recordingView(done.value));
          } catch (error) {
            return conflictOr(c, error);
          }
        });

        documentDemoRoutes(app);
      },
    };
  };

export const demosModule: PlatformModuleFactory = createDemosModule();
