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
  demoSpec,
  isRecorderKey,
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
  recordingStart,
  type DemoProblem,
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
} as const;

type Status = keyof typeof titles;

const problem = (c: Context, status: Status, errors: DemoProblem[] = []) =>
  c.json({ type: 'about:blank', title: titles[status], status, errors }, status, {
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

export const demosModule: PlatformModuleFactory = (deps) => {
  const store = deps.configEntries;
  const tenant = deps.platformTenant;
  const one = serialized();

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

  const running = async (c: Context) => {
    const found = await latestRecording(store, c.req.param('id') ?? '');
    if (!found) return { response: problem(c, 404) };
    if (found.spec.status !== 'running')
      return {
        response: problem(c, 409, [{ path: 'status', message: 'the recording has finished' }]),
      };
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
            const latest = own[0];
            const recorded = own.find((r) => r.spec.status === 'recorded');
            return {
              ...demoView(demo),
              ...(latest ? { latest: recordingView(latest) } : {}),
              ...(recorded ? { recorded: recordingView(recorded) } : {}),
            };
          });
        return c.json({ genkiVersion: deps.appVersion ?? null, data });
      });

      app.get('/operator/demos/:id', async (c) => {
        const g = await viewer(c, mounted);
        if ('response' in g) return g.response;
        const demo = await latestDemo(store, c.req.param('id') ?? '');
        if (!demo) return problem(c, 404);
        return c.json({
          ...demoView(demo),
          genkiVersion: deps.appVersion ?? null,
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
          const done = await audited(g.principal, 'platform.demo.save', reason, `demo:${id}`, () =>
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
        const blob = await deps.blobs.get({ tenant, path: recordingBlobPath(found.id, file.name) });
        if (!blob) return problem(c, 404);
        return c.body(blob.body as Uint8Array<ArrayBuffer>, 200, {
          'content-type': file.contentType,
          'content-length': String(blob.body.byteLength),
          'content-disposition': `inline; filename="${found.spec.demo}-${file.name}"`,
          'cache-control': 'private, max-age=300',
        });
      });

      app.post('/recorder/demos/:id/recordings', async (c) => {
        const principal = recorder(c);
        if (!principal) return problem(c, 401);
        const demo = await latestDemo(store, c.req.param('id') ?? '');
        if (!demo) return problem(c, 404);
        const body = recordingStart.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) return problem(c, 400, problemsOf(body.error));
        const id = crypto.randomUUID();
        const spec: RecordingSpec = {
          demo: demo.id,
          demoVersion: demo.version,
          genkiVersion: body.data.genkiVersion,
          status: 'running',
          steps: demo.spec.steps.length,
          narrated: body.data.narrated,
          ...(body.data.narrated ? { voice: demo.spec.voice } : {}),
          startedAt: new Date().toISOString(),
          files: [],
        };
        const done = await audited(
          principal,
          'platform.demo.recording.start',
          'recorded by the demo recorder',
          `demo-recording:${id}`,
          () =>
            appendVersion<RecordingSpec>(store, {
              kind: recordingKind,
              scope: platformScope,
              id,
              spec,
              deleted: false,
              by: `platform:${principal.subject}`,
              reason: `recording of ${demo.id}`,
            }),
        );
        c.header('genai-task', done.task);
        return c.json(recordingView(done.value), 201);
      });

      app.put('/recorder/recordings/:id/files/:name', async (c) => {
        const principal = recorder(c);
        if (!principal) return problem(c, 401);
        const name = c.req.param('name') ?? '';
        const type = recordingFileType(name);
        if (!type) return problem(c, 404, [{ path: 'name', message: `no file ${name}` }]);
        const tooLarge = (ctx: Context) =>
          problem(ctx, 413, [
            { path: 'body', message: `${name} is at most ${type.maxBytes} bytes` },
          ]);
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
            const info = await deps.blobs.put(
              { tenant, path: recordingBlobPath(g.found.id, name) },
              bytes,
              type.contentType,
            );
            const file = { name, size: info.size, contentType: type.contentType };
            try {
              await one(async () => {
                const current = (await latestRecording(store, g.found.id)) ?? g.found;
                await update(
                  current,
                  {
                    ...current.spec,
                    files: [...current.spec.files.filter((f) => f.name !== name), file],
                  },
                  `platform:${principal.subject}`,
                  `file ${name}`,
                );
              });
              answer = c.json(file, 200);
            } catch (error) {
              answer = conflictOr(c, error);
            }
          },
        );
        return refused ?? answer ?? problem(c, 400);
      });

      app.post('/recorder/recordings/:id/finish', async (c) => {
        const principal = recorder(c);
        if (!principal) return problem(c, 401);
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
                    finishedAt: new Date().toISOString(),
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
