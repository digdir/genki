import { InMemoryBlobStore } from '@genai/port-blob';
import { describe, expect, it } from 'vitest';
import { platformModules } from './composition.js';
import { platformScope } from './config-store.js';
import { createDemosModule, demosModule } from './demo-routes.js';
import { demoKind, readDemo, recorderKeyDigest, recordingBlobPath } from './demos.js';
import { maskinportenClientsModule } from './maskinporten-clients.js';
import { onboardingModule } from './onboarding.js';
import { bootPlatform, digdir, principals, readJson } from './testkit.js';

const recorderKey = 'opptaker-nøkkel-for-test';

const demoYaml = `title: Prøv en tjeneste
description: For kommuner som vurderer genki.
audience: [municipality]
language: nb-NO
voice: nb-NO-PernilleNeural
app: portal
path: /#/playground
steps:
  - say: Først velger vi hva vi vil prøve.
  - say: Så stiller vi et spørsmål.
`;

interface Recording {
  id: string;
  status: string;
  demoVersion: number;
  files: { name: string }[];
  failure?: { step: number };
}

const booted = async (
  sendRecording?: (recording: string) => Promise<void>,
  wiring: { demoRecorder?: 'scheduled'; withKey?: boolean; digest?: string } = {},
) => {
  let second = 0;
  const now = () => new Date(Date.UTC(2026, 10, 17, 10, 0, second++));
  const blobs = new InMemoryBlobStore();
  const platform = await bootPlatform({
    people: principals,
    blobStore: blobs,
    ...(wiring.withKey === false
      ? {}
      : { demoRecorderKeyDigest: wiring.digest ?? recorderKeyDigest(recorderKey) }),
    ...(wiring.demoRecorder ? { demoRecorder: wiring.demoRecorder } : {}),
    modules: [
      ...platformModules.filter((m) => m !== demosModule),
      createDemosModule({ now, ...(sendRecording ? { sendRecording } : {}) }),
      onboardingModule,
      maskinportenClientsModule,
    ],
  });
  const read = readDemo(demoYaml);
  if (!read.ok) throw new Error('fixture is invalid');
  await platform.configEntries.append({
    kind: demoKind,
    scope: platformScope,
    id: 'playground',
    version: 1,
    spec: read.spec,
    deleted: false,
    by: 'platform:seed',
    at: '2026-11-17T10:00:00.000Z',
    reason: 'demos/*.yaml in the repository',
  });
  const record = (path: string, init: { method?: string; body?: BodyInit; json?: unknown } = {}) =>
    platform.app.request(path, {
      method: init.method ?? 'POST',
      headers: {
        'x-recorder-key': recorderKey,
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json),
    });
  const start = async () =>
    readJson<Recording>(
      await record('/recorder/demos/playground/recordings', {
        json: { genkiVersion: '0.43.0', narrated: true },
      }),
    );
  return { ...platform, blobs, record, start };
};

describe('the demo library', () => {
  it('shows the library to operators only', async () => {
    const { app, send } = await booted();

    expect((await app.request('/operator/demos')).status).toBe(401);
    expect((await send('/operator/demos', 'kari')).status).toBe(403);
    expect((await send('/operator/demos', 'operator')).status).toBe(200);
  });

  it('lists each demo with its newest recording, its newest finished one and how many films finished', async () => {
    const { send, record, start } = await booted();
    const good = await start();
    await record(`/recorder/recordings/${good.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    await record(`/recorder/recordings/${good.id}/finish`, {
      json: { status: 'recorded', seconds: 64 },
    });
    const again = await start();
    await record(`/recorder/recordings/${again.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([4]),
    });
    await record(`/recorder/recordings/${again.id}/finish`, {
      json: { status: 'recorded', seconds: 62 },
    });
    const broken = await start();
    await record(`/recorder/recordings/${broken.id}/finish`, {
      json: { status: 'failed', failure: { step: 2, message: 'fant ikke knappen Send' } },
    });

    const library = await readJson<{
      data: { id: string; latest?: Recording; recorded?: Recording; editions: number }[];
    }>(await send('/operator/demos', 'operator'));

    expect(library.data).toMatchObject([
      {
        id: 'playground',
        editions: 2,
        latest: { id: broken.id, status: 'failed', failure: { step: 2 } },
        recorded: { id: again.id, status: 'recorded', demoVersion: 1 },
      },
    ]);
  });

  it('gives a viewer the file of a recording, and nothing outside its files', async () => {
    const { send, record, start } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.srt`, {
      method: 'PUT',
      body: '1\n00:00:00,000 --> 00:00:02,000\nFørst velger vi.\n',
    });

    const srt = await send(`/operator/recordings/${recording.id}/files/demo.srt`, 'operator');
    const missing = await send(`/operator/recordings/${recording.id}/files/demo.mp4`, 'operator');
    const outside = await send(
      `/operator/recordings/${recording.id}/files/..%2Fsecret`,
      'operator',
    );

    expect(srt.status).toBe(200);
    expect(srt.headers.get('content-type')).toBe('application/x-subrip');
    expect(await srt.text()).toContain('Først velger vi.');
    expect(missing.status).toBe(404);
    expect(outside.status).toBe(404);
  });
});

describe('the recorder routes', () => {
  it('refuse a caller without the recorder key, an operator included', async () => {
    const { app, send } = await booted();

    const anonymous = await app.request('/recorder/demos/playground/recordings', {
      method: 'POST',
      headers: { 'x-recorder-key': 'gjettet', 'content-type': 'application/json' },
      body: JSON.stringify({ genkiVersion: '0.43.0', narrated: true }),
    });
    const operator = await send('/recorder/demos/playground/recordings', 'operator', {
      body: { genkiVersion: '0.43.0', narrated: true },
      reason: 'tar opp demoen for hånd',
    });

    expect(anonymous.status).toBe(401);
    expect(operator.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
    expect(await operator.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
  });

  it('refuse every recorder call when no recorder key is configured', async () => {
    const platform = await bootPlatform({ people: principals });

    const response = await platform.app.request('/recorder/demos/playground/recordings', {
      method: 'POST',
      headers: { 'x-recorder-key': recorderKey, 'content-type': 'application/json' },
      body: JSON.stringify({ genkiVersion: '0.43.0', narrated: true }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
  });

  it('take only the file names a recording has', async () => {
    const { record, start } = await booted();
    const recording = await start();

    const script = await record(`/recorder/recordings/${recording.id}/files/run.sh`, {
      method: 'PUT',
      body: 'echo',
    });

    expect(script.status).toBe(404);
  });

  it('refuse a file larger than its limit', async () => {
    const { record, start } = await booted();
    const recording = await start();

    const response = await record(`/recorder/recordings/${recording.id}/files/demo.srt`, {
      method: 'PUT',
      body: new Uint8Array(256 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:file-too-large' });
  });

  it('stop reading a file without a length once it passes its limit', async () => {
    const { app, start } = await booted();
    const recording = await start();
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (sent >= 1024 * 1024) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const response = await app.request(`/recorder/recordings/${recording.id}/files/demo.srt`, {
      method: 'PUT',
      headers: { 'x-recorder-key': recorderKey },
      body,
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:file-too-large' });
    expect(sent).toBeLessThan(1024 * 1024);
  });

  it('finish a recording as recorded only once its video is uploaded', async () => {
    const { record, start } = await booted();
    const recording = await start();

    const response = await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'recorded' },
    });

    expect(response.status).toBe(400);
  });

  it('take no files after a recording has finished', async () => {
    const { record, start } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'failed', failure: { step: 0, message: 'siden lastet ikke' } },
    });

    const late = await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ type: 'urn:genai:problem:recording-finished' });
  });

  it('refuse a file whose upload ends after the recording has finished, and keep the file it had', async () => {
    const { app, blobs, record, start } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    let reading = () => {};
    const readStarted = new Promise<void>((resolve) => (reading = resolve));
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        reading();
        await released;
        controller.enqueue(new Uint8Array([9]));
        controller.close();
      },
    });
    const late = app.request(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      headers: { 'x-recorder-key': recorderKey },
      body,
      duplex: 'half',
    } as RequestInit);
    await readStarted;
    const finished = await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'recorded', seconds: 3 },
    });
    release();

    expect(finished.status).toBe(200);
    const refused = await late;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ type: 'urn:genai:problem:recording-finished' });
    const kept = await blobs.get({
      tenant: digdir,
      path: recordingBlobPath(recording.id, 'demo.mp4'),
    });
    expect([...(kept?.body ?? [])]).toEqual([1, 2, 3]);
  });

  it('audit the start and the end of a recording as the recorder', async () => {
    const { admin, record, start } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'failed', failure: { step: 1, message: 'tidsavbrudd' } },
    });

    const entries = (await admin.audit(digdir)).filter((a) => a.action.startsWith('platform.demo'));

    expect(entries.map((a) => [a.action, a.actor, a.target])).toEqual([
      ['platform.demo.recording.start', 'platform:recorder', `demo-recording:${recording.id}`],
      ['platform.demo.recording.finish', 'platform:recorder', `demo-recording:${recording.id}`],
    ]);
  });
});

describe('saving a demo', () => {
  it('saves a new version from the YAML of demos/*.yaml with a reason, as a demo editor', async () => {
    const { app } = await booted();

    const response = await app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/yaml',
        'change-reason': 'kortere fortelling i steg to',
        'if-match': '1',
      },
      body: demoYaml.replace('Så stiller vi et spørsmål.', 'Så spør vi.'),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'playground', version: 2 });
  });

  it('refuses a save from someone who is not a demo editor', async () => {
    const { send } = await booted();

    const response = await send('/operator/demos/playground', 'kari', {
      method: 'PUT',
      body: readDemo(demoYaml),
      reason: 'kortere fortelling i steg to',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a save over a version that has moved', async () => {
    const { app } = await booted();

    const response = await app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/yaml',
        'change-reason': 'kortere fortelling i steg to',
        'if-match': '7',
      },
      body: demoYaml,
    });

    expect(response.status).toBe(409);
  });
});

const reasonText = 'ny versjon av portalen';

describe('recording from the console', () => {
  const queued = async (sent: string[] = []) => {
    const platform = await booted(async (id) => {
      sent.push(id);
    });
    const request = (body: unknown = {}) =>
      platform.send('/operator/demos/playground/recordings', 'operator', {
        body,
        reason: reasonText,
      });
    return { ...platform, request, sent };
  };

  it('refuses to queue a recording where no recorder job is set up', async () => {
    const { send } = await booted();

    const response = await send('/operator/demos/playground/recordings', 'operator', {
      body: {},
      reason: reasonText,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:recorder-not-set-up' });
    expect(
      await readJson<{ recorder: string }>(await send('/operator/demos', 'operator')),
    ).toMatchObject({ recorder: 'workflow' });
  });

  it('queues a recording, hands it to the job and audits it as the person who asked', async () => {
    const { request, sent, admin, send } = await queued();

    const response = await request();
    const recording = await readJson<Recording & { requestedBy: string }>(response);

    expect(response.status).toBe(202);
    expect(recording).toMatchObject({
      status: 'queued',
      requestedBy: expect.stringContaining('operator'),
    });
    expect(sent).toEqual([recording.id]);
    expect(
      (await admin.audit(digdir))
        .filter((a) => a.target === `demo-recording:${recording.id}`)
        .map((a) => [a.action, a.reason]),
    ).toEqual([['platform.demo.recording.start', reasonText]]);
    const library = await readJson<{ recorder: string; data: { open?: Recording }[] }>(
      await send('/operator/demos', 'operator'),
    );
    expect(library).toMatchObject({ recorder: 'job', data: [{ open: { id: recording.id } }] });
  });

  it('refuses a second recording while the first has not ended', async () => {
    const { request } = await queued();
    await request();

    const second = await request();

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ type: 'urn:genai:problem:recording-open' });
  });

  it('refuses the recorder a new recording while one queued from the console is open', async () => {
    const { request, record, send } = await queued();
    const recording = await readJson<Recording>(await request());

    const started = await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true },
    });
    const detail = await readJson<{ recordings: Recording[] }>(
      await send('/operator/demos/playground', 'operator'),
    );

    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({ type: 'urn:genai:problem:recording-open' });
    expect(detail.recordings).toMatchObject([{ id: recording.id, status: 'queued' }]);
  });

  it('refuses the recorder a second recording while its first is running', async () => {
    const { start, record } = await queued();
    await start();

    const second = await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true },
    });

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ type: 'urn:genai:problem:recording-open' });
  });

  it.each(['console', 'recorder'])(
    'keeps one open recording when the console and the recorder start at once, %s first',
    async (first) => {
      const { request, record, send } = await queued();
      const fromConsole = () => request();
      const fromRecorder = () =>
        record('/recorder/demos/playground/recordings', {
          json: { genkiVersion: '0.44.0', narrated: true },
        });

      const [lead, follow] =
        first === 'console' ? [fromConsole, fromRecorder] : [fromRecorder, fromConsole];

      const leading = lead();
      await new Promise((resolve) => setImmediate(resolve));
      const answers = await Promise.all([leading, follow()]);
      const detail = await readJson<{ recordings: Recording[] }>(
        await send('/operator/demos/playground', 'operator'),
      );

      const refused = answers.filter((a) => a.status === 409);
      expect(refused).toHaveLength(1);
      expect(answers.every((a) => [201, 202, 409].includes(a.status))).toBe(true);
      expect(await refused[0]?.json()).toMatchObject({ type: 'urn:genai:problem:recording-open' });
      expect(
        detail.recordings.filter((r) => ['queued', 'running'].includes(r.status)),
      ).toHaveLength(1);
    },
  );

  it('refuses to queue without a reason, and from someone who is not a demo editor', async () => {
    const { send } = await queued();

    expect(
      (await send('/operator/demos/playground/recordings', 'operator', { body: {} })).status,
    ).toBe(400);
    expect(
      (
        await send('/operator/demos/playground/recordings', 'kari', {
          body: {},
          reason: reasonText,
        })
      ).status,
    ).toBe(403);
  });

  it('marks a recording the job could not take as failed', async () => {
    const { send } = await booted(async () => {
      throw new Error('queue down');
    });

    const response = await send('/operator/demos/playground/recordings', 'operator', {
      body: {},
      reason: reasonText,
    });
    const detail = await readJson<{ recordings: Recording[] }>(
      await send('/operator/demos/playground', 'operator'),
    );

    expect(response.status).toBe(503);
    expect(detail.recordings).toMatchObject([{ status: 'failed', failure: { step: 0 } }]);
  });

  it('lets the recorder take up a queued recording with the demo version and settings it records', async () => {
    const { request, record } = await queued();
    const recording = await readJson<Recording>(await request());

    const read = await readJson<{ demoSpec: { title: string }; settings: { voice: string } }>(
      await record(`/recorder/recordings/${recording.id}`, { method: 'GET' }),
    );
    const started = await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: recording.id },
    });

    expect(read).toMatchObject({
      demoSpec: { title: 'Prøv en tjeneste' },
      settings: { voice: 'nb-NO-PernilleNeural' },
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      id: recording.id,
      status: 'running',
      genkiVersion: '0.44.0',
    });
  });

  it('keeps a trial of the first steps silent and out of the library', async () => {
    const { request, record, send } = await queued();
    const trial = await readJson<Recording & { upTo: number; steps: number }>(
      await request({ upTo: 1 }),
    );
    await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: trial.id },
    });
    await record(`/recorder/recordings/${trial.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    const finished = await readJson<Recording & { narrated: boolean }>(
      await record(`/recorder/recordings/${trial.id}/finish`, { json: { status: 'recorded' } }),
    );

    const library = await readJson<{
      data: { latest?: Recording; recorded?: Recording; editions: number }[];
    }>(await send('/operator/demos', 'operator'));
    expect(library.data[0]?.editions).toBe(0);
    expect(trial).toMatchObject({ upTo: 1, steps: 1 });
    expect(finished).toMatchObject({ narrated: false });
    expect(library.data[0]?.latest).toBeUndefined();
    expect(library.data[0]?.recorded).toBeUndefined();
  });

  it('refuses a trial past the last step', async () => {
    const { request } = await queued();

    expect((await request({ upTo: 3 })).status).toBe(400);
  });

  it('cancels a running recording, after which the recorder can upload nothing', async () => {
    const { request, record, send, admin } = await queued();
    const recording = await readJson<Recording>(await request());
    await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: false, recording: recording.id },
    });

    const cancelled = await send(`/operator/recordings/${recording.id}/cancel`, 'operator', {
      body: {},
      reason: 'feil versjon av demoen',
    });
    const upload = await record(`/recorder/recordings/${recording.id}/files/step-1.png`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    const again = await send(`/operator/recordings/${recording.id}/cancel`, 'operator', {
      body: {},
      reason: 'feil versjon av demoen',
    });

    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(upload.status).toBe(409);
    expect(again.status).toBe(409);
    expect(
      (await admin.audit(digdir)).filter(
        (a) =>
          a.action === 'platform.demo.recording.finish' && a.reason === 'feil versjon av demoen',
      ),
    ).toHaveLength(1);
  });

  it('does not let the recorder take up a cancelled recording', async () => {
    const { request, record, send } = await queued();
    const recording = await readJson<Recording>(await request());
    await send(`/operator/recordings/${recording.id}/cancel`, 'operator', {
      body: {},
      reason: 'feil versjon av demoen',
    });

    const started = await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: recording.id },
    });

    expect(started.status).toBe(409);
  });

  it('takes a screenshot after each step as the progress of a running recording', async () => {
    const { record, start, send } = await booted();
    const recording = await start();

    await record(`/recorder/recordings/${recording.id}/files/step-1.png`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    const read = await readJson<Recording>(
      await send(`/operator/recordings/${recording.id}`, 'operator'),
    );
    expect(read.files.map((f) => f.name)).toEqual(['step-1.png']);
  });
});

describe('the demo settings', () => {
  it('shows the defaults until someone saves them', async () => {
    const { send } = await booted();

    const settings = await readJson<Record<string, unknown>>(
      await send('/operator/demo-settings', 'operator'),
    );

    expect(settings).toMatchObject({
      version: 0,
      voice: 'nb-NO-PernilleNeural',
      viewport: [1920, 1080],
      tenant: null,
      retentionDays: 90,
      recorder: 'workflow',
    });
  });

  it('saves the settings with a reason as a demo editor, audited', async () => {
    const { send, admin } = await booted();
    const body = {
      voice: 'nb-NO-FinnNeural',
      viewport: [1440, 900],
      tenant: '310000001',
      login: 'Demo-opptaker i Eksempel kommune',
      retentionDays: 30,
      writerDailyTokens: 50000,
    };

    const saved = await send('/operator/demo-settings', 'operator', {
      method: 'PUT',
      body,
      reason: 'ny stemme for demoene',
    });
    const refused = await send('/operator/demo-settings', 'kari', {
      method: 'PUT',
      body,
      reason: 'ny stemme for demoene',
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ...body, version: 1 });
    expect(refused.status).toBe(403);
    expect(
      (await admin.audit(digdir)).filter((a) => a.target === 'demo-settings').map((a) => a.action),
    ).toEqual(['platform.demo.save']);
  });

  it('refuses a retention shorter than a week', async () => {
    const { send } = await booted();

    const response = await send('/operator/demo-settings', 'operator', {
      method: 'PUT',
      body: {
        voice: 'nb-NO-PernilleNeural',
        viewport: [1280, 720],
        tenant: null,
        login: 'recorder',
        retentionDays: 1,
        writerDailyTokens: 0,
      },
      reason: 'kortere lagringstid',
    });

    expect(response.status).toBe(400);
  });

  it('points at a sample of the default voice from the newest recording that has one', async () => {
    const { send, record, start } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/sample.mp3`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    const settings = await readJson<{ sample?: { recording: string } }>(
      await send('/operator/demo-settings', 'operator'),
    );

    expect(settings.sample).toEqual({ recording: recording.id, file: 'sample.mp3' });
  });
});

describe('the scheduled recorder', () => {
  const scheduled = async (withKey = true, digest?: string) => {
    const platform = await booted(undefined, {
      demoRecorder: 'scheduled',
      withKey,
      ...(digest ? { digest } : {}),
    });
    const second = readDemo(demoYaml.replace('Prøv en tjeneste', 'Finn en tjeneste'));
    if (!second.ok) throw new Error('fixture is invalid');
    await platform.configEntries.append({
      kind: demoKind,
      scope: platformScope,
      id: 'catalogue',
      version: 1,
      spec: second.spec,
      deleted: false,
      by: 'platform:seed',
      at: '2026-11-17T10:00:00.000Z',
      reason: 'demos/*.yaml in the repository',
    });
    const request = (demo: string) =>
      platform.send(`/operator/demos/${demo}/recordings`, 'operator', {
        body: {},
        reason: reasonText,
      });
    return { ...platform, request };
  };

  it('queues a recording from the console when the scheduled recorder is wired with a recorder key', async () => {
    const { request, send } = await scheduled();

    const response = await request('playground');

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'queued' });
    expect(
      await readJson<{ recorder: string }>(await send('/operator/demos', 'operator')),
    ).toMatchObject({ recorder: 'scheduled' });
    expect(
      await readJson<{ recorder: string }>(await send('/operator/demo-settings', 'operator')),
    ).toMatchObject({ recorder: 'scheduled' });
  });

  it('still answers 503 when the scheduled recorder is set but no recorder key is', async () => {
    const { request, send } = await scheduled(false);

    const response = await request('playground');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ type: 'urn:genai:problem:recorder-not-set-up' });
    expect(
      await readJson<{ recorder: string }>(await send('/operator/demos', 'operator')),
    ).toMatchObject({ recorder: 'workflow' });
  });

  it('still answers 503 when the recorder key digest is not a SHA-256 hex digest', async () => {
    const { request } = await scheduled(true, recorderKeyDigest(recorderKey).toUpperCase());

    const response = await request('playground');

    expect(response.status).toBe(503);
  });

  it('lists the queued recordings oldest first, with only their id and demo, to the recorder key', async () => {
    const { request, record } = await scheduled();
    const first = await readJson<Recording>(await request('playground'));
    const second = await readJson<Recording>(await request('catalogue'));

    const listed = await record('/recorder/recordings?status=queued', { method: 'GET' });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      data: [
        { id: first.id, demo: 'playground' },
        { id: second.id, demo: 'catalogue' },
      ],
    });
  });

  it('leaves a recording out of the queued list once the recorder has taken it up', async () => {
    const { request, record } = await scheduled();
    const taken = await readJson<Recording>(await request('playground'));
    await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: taken.id },
    });

    const listed = await readJson<{ data: unknown[] }>(
      await record('/recorder/recordings?status=queued', { method: 'GET' }),
    );

    expect(listed.data).toEqual([]);
  });

  it('refuses the queued list without the recorder key, an operator included, or without status=queued', async () => {
    const { app, send, record, request } = await scheduled();
    await request('playground');

    const wrong = await app.request('/recorder/recordings?status=queued', {
      headers: { 'x-recorder-key': 'gjettet' },
    });
    const operator = await send('/recorder/recordings?status=queued', 'operator', {
      method: 'GET',
    });
    const unfiltered = await record('/recorder/recordings', { method: 'GET' });

    expect([wrong.status, operator.status, unfiltered.status]).toEqual([401, 401, 400]);
    expect(await wrong.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
  });
});

describe('the studio', () => {
  const sourceFiles = ['capture.mp4', 'events.json', 'edl.json', 'demo.mp4'];

  const withFilm = async (files = sourceFiles) => {
    const platform = await booted(async () => undefined);
    const film = await platform.start();
    for (const name of files)
      await platform.record(`/recorder/recordings/${film.id}/files/${name}`, {
        method: 'PUT',
        body: name.endsWith('.json') ? '{"version":1}' : new Uint8Array([1, 2, 3]),
      });
    await platform.record(`/recorder/recordings/${film.id}/finish`, {
      json: { status: 'recorded', seconds: 40 },
    });
    const edit = (body: unknown, who = 'operator', reason: string | undefined = reasonText) =>
      platform.send('/operator/demos/playground/recordings', who, {
        body,
        ...(reason ? { reason } : {}),
      });
    return { ...platform, film, edit };
  };

  const instruction = 'Gjør zoomen på Statistikk roligere';
  const costCapUsd = 2;

  it('takes the capture, the events, the edit list and the director rounds a film is made from', async () => {
    const { record, start } = await booted();
    const recording = await start();
    const names = [
      'capture.mp4',
      'events.json',
      'edl.json',
      'edl-round-0.json',
      'edl-round-3.json',
      'review-round-1.json',
      'review-round-3.json',
    ];

    const answers = await Promise.all(
      names.map((name) =>
        record(`/recorder/recordings/${recording.id}/files/${name}`, {
          method: 'PUT',
          body: name.endsWith('.mp4') ? new Uint8Array([1]) : '{}',
        }),
      ),
    );
    const outOfRange = await record(`/recorder/recordings/${recording.id}/files/edl-round-4.json`, {
      method: 'PUT',
      body: '{}',
    });

    expect(answers.map((a) => a.status)).toEqual(names.map(() => 200));
    expect(await answers[1]?.json()).toMatchObject({ contentType: 'application/json' });
    expect(outOfRange.status).toBe(404);
  });

  it('refuses a director file larger than 2 MB', async () => {
    const { record, start } = await booted();
    const recording = await start();

    const response = await record(`/recorder/recordings/${recording.id}/files/edl.json`, {
      method: 'PUT',
      body: new Uint8Array(2 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
  });

  it('queues an edit of a recorded film with its instruction, the film it edits and its demo version, audited', async () => {
    const { edit, film, admin, record, app } = await withFilm();
    const saved = await app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/yaml',
        'change-reason': reasonText,
      },
      body: demoYaml.replace('Så stiller vi', 'Nå stiller vi'),
    });

    const response = await edit({ editOf: film.id, instruction, costCapUsd });
    const queued = await readJson<Recording & { editOf: string; instruction: string }>(response);

    expect(saved.status).toBe(200);
    expect(response.status).toBe(202);
    expect(queued).toMatchObject({
      status: 'queued',
      editOf: film.id,
      instruction,
      demoVersion: 1,
      narrated: true,
    });
    expect(
      (await admin.audit(digdir))
        .filter((a) => a.target === `demo-recording:${queued.id}`)
        .map((a) => [a.action, a.reason]),
    ).toEqual([['platform.demo.recording.start', reasonText]]);
    expect(
      await readJson(await record(`/recorder/recordings/${queued.id}`, { method: 'GET' })),
    ).toMatchObject({ editOf: film.id, instruction, costCapUsd });
    expect(
      await readJson(await record('/recorder/recordings?status=queued', { method: 'GET' })),
    ).toEqual({ data: [{ id: queued.id, demo: 'playground', editOf: film.id, instruction }] });
  });

  it('refuses an edit without a reason, and from someone who is not a demo editor', async () => {
    const { edit, film } = await withFilm();

    expect((await edit({ editOf: film.id, instruction, costCapUsd }, 'operator', '')).status).toBe(
      400,
    );
    expect((await edit({ editOf: film.id, instruction, costCapUsd }, 'kari')).status).toBe(403);
  });

  it('refuses an edit while another recording of the demo is open', async () => {
    const { edit, film } = await withFilm();
    await edit({ editOf: film.id, instruction, costCapUsd });

    const second = await edit({ editOf: film.id, instruction: 'Kortere pauser', costCapUsd });

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ type: 'urn:genai:problem:recording-open' });
  });

  it('refuses an edit without an instruction, an instruction without an edit, and an edit cut short with upTo', async () => {
    const { edit, film } = await withFilm();

    const answers = await Promise.all([
      edit({ editOf: film.id, costCapUsd }),
      edit({ instruction, costCapUsd }),
      edit({ editOf: film.id, instruction: ' ', costCapUsd }),
      edit({ editOf: film.id, instruction: 'x'.repeat(2001), costCapUsd }),
      edit({ editOf: film.id, instruction, upTo: 1 }),
    ]);
    const paths = await Promise.all(
      answers.map(async (a) =>
        ((await a.json()) as { errors: { path: string }[] }).errors.map((e) => e.path),
      ),
    );

    expect(answers.map((a) => a.status)).toEqual([400, 400, 400, 400, 400]);
    expect(paths.map((p) => p[0])).toEqual([
      'instruction',
      'instruction',
      'instruction',
      'instruction',
      'upTo',
    ]);
  });

  it('refuses an edit of a recorded trial, which is not a whole film', async () => {
    const platform = await booted(async () => undefined);
    const trial = await readJson<Recording>(
      await platform.send('/operator/demos/playground/recordings', 'operator', {
        body: { upTo: 1 },
        reason: reasonText,
      }),
    );
    await platform.record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: false, recording: trial.id },
    });
    for (const name of sourceFiles)
      await platform.record(`/recorder/recordings/${trial.id}/files/${name}`, {
        method: 'PUT',
        body: name.endsWith('.json') ? '{}' : new Uint8Array([1]),
      });
    await platform.record(`/recorder/recordings/${trial.id}/finish`, {
      json: { status: 'recorded', seconds: 5 },
    });

    const response = await platform.send('/operator/demos/playground/recordings', 'operator', {
      body: { editOf: trial.id, instruction, costCapUsd },
      reason: reasonText,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'editOf' }] });
  });

  it('refuses an edit of a film that lacks its capture, events or edit list', async () => {
    const { edit, film } = await withFilm(['demo.mp4', 'events.json', 'edl.json']);

    const response = await edit({ editOf: film.id, instruction, costCapUsd });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'editOf' }] });
  });

  it('refuses an edit of a recording that has not been recorded, or that does not exist', async () => {
    const { edit, start, record } = await withFilm();
    const failed = await start();
    await record(`/recorder/recordings/${failed.id}/finish`, {
      json: { status: 'failed', failure: { step: 1, message: 'fant ikke knappen' } },
    });

    expect((await edit({ editOf: failed.id, instruction, costCapUsd })).status).toBe(400);
    expect((await edit({ editOf: crypto.randomUUID(), instruction, costCapUsd })).status).toBe(400);
  });

  it('keeps the edit and its instruction when the recorder takes it up', async () => {
    const { edit, film, record } = await withFilm();
    const queued = await readJson<Recording>(
      await edit({ editOf: film.id, instruction, costCapUsd }),
    );

    const started = await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: queued.id },
    });

    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ status: 'running', editOf: film.id, instruction });
  });

  it('gives the recorder the files of a film only while an open edit points at it', async () => {
    const { edit, film, record } = await withFilm();
    const file = () => record(`/recorder/recordings/${film.id}/files/edl.json`, { method: 'GET' });

    const before = await file();
    const queued = await readJson<Recording>(
      await edit({ editOf: film.id, instruction, costCapUsd }),
    );
    const during = await file();
    const missing = await record(`/recorder/recordings/${film.id}/files/poster.jpg`, {
      method: 'GET',
    });
    await record('/recorder/demos/playground/recordings', {
      json: { genkiVersion: '0.44.0', narrated: true, recording: queued.id },
    });
    await record(`/recorder/recordings/${queued.id}/finish`, {
      json: { status: 'failed', failure: { step: 0, message: 'ingen regissør' } },
    });
    const after = await file();

    expect(before.status).toBe(404);
    expect(during.status).toBe(200);
    expect(during.headers.get('content-type')).toBe('application/json');
    expect(await during.text()).toBe('{"version":1}');
    expect(missing.status).toBe(404);
    expect(after.status).toBe(404);
  });

  it('refuses the files of a film to a caller without the recorder key, an operator included', async () => {
    const { app, edit, film, send } = await withFilm();
    await edit({ editOf: film.id, instruction, costCapUsd });

    const wrong = await app.request(`/recorder/recordings/${film.id}/files/edl.json`, {
      headers: { 'x-recorder-key': 'gjettet' },
    });
    const operator = await send(`/recorder/recordings/${film.id}/files/edl.json`, 'operator', {
      method: 'GET',
    });

    expect([wrong.status, operator.status]).toEqual([401, 401]);
  });

  it('refuses an edit without an approved cost, and a cost over the platform cap', async () => {
    const { edit, film } = await withFilm();

    const unapproved = await edit({ editOf: film.id, instruction });
    const tooMuch = await edit({ editOf: film.id, instruction, costCapUsd: 26 });

    expect([unapproved.status, tooMuch.status]).toEqual([400, 400]);
    expect(await unapproved.json()).toMatchObject({ errors: [{ path: 'costCapUsd' }] });
  });

  it('takes the voice clips and their word timings a film was cut to, so an edit never voices again', async () => {
    const { record, start } = await booted();
    const recording = await start();

    const clip = await record(
      `/recorder/recordings/${recording.id}/files/voice-0123456789abcdef.mp3`,
      {
        method: 'PUT',
        body: new Uint8Array([1]),
      },
    );
    const words = await record(
      `/recorder/recordings/${recording.id}/files/voice-0123456789abcdef.words.json`,
      { method: 'PUT', body: '[]' },
    );
    const named = await record(`/recorder/recordings/${recording.id}/files/voice-../x.mp3`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    expect([clip.status, words.status]).toEqual([200, 200]);
    expect(await clip.json()).toMatchObject({ contentType: 'audio/mpeg' });
    expect(named.status).toBe(404);
  });
});

describe('approving the cost of a recording', () => {
  const cedarYaml = demoYaml.replace('voice: nb-NO-PernilleNeural', 'voice: cedar');

  const withCedar = async () => {
    const platform = await booted(async () => undefined);
    const saved = await platform.app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/yaml',
        'change-reason': reasonText,
      },
      body: cedarYaml,
    });
    expect(saved.status).toBe(200);
    const ask = (body: unknown) =>
      platform.send('/operator/demos/playground/recordings', 'operator', {
        body,
        reason: reasonText,
      });
    return { ...platform, ask };
  };

  it('refuses a recording read by a model voice until someone approves a cost cap', async () => {
    const { ask } = await withCedar();

    const response = await ask({});

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'costCapUsd' }] });
  });

  it('queues a recording with its approved cost cap, and gives the cap to the recorder', async () => {
    const { ask, record } = await withCedar();

    const queued = await readJson<Recording & { costCapUsd: number }>(await ask({ costCapUsd: 5 }));
    const read = await readJson(
      await record(`/recorder/recordings/${queued.id}`, { method: 'GET' }),
    );

    expect(queued).toMatchObject({ status: 'queued', costCapUsd: 5, voice: 'cedar' });
    expect(read).toMatchObject({ costCapUsd: 5 });
  });

  it('lets a silent trial of a model voice run without a cap', async () => {
    const { ask } = await withCedar();

    const trial = await ask({ upTo: 1 });

    expect(trial.status).toBe(202);
  });

  it('refuses a cost cap on a trial', async () => {
    const { ask } = await withCedar();

    expect((await ask({ upTo: 1, costCapUsd: 1 })).status).toBe(400);
  });

  it('accepts a cost cap of 25 dollars and refuses one of 0', async () => {
    const { ask } = await withCedar();

    expect((await ask({ costCapUsd: 0 })).status).toBe(400);
    expect((await ask({ costCapUsd: 25 })).status).toBe(202);
  });

  it('refuses a negative model cost when the recorder finishes', async () => {
    const { start, record } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    const finished = await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'recorded', seconds: 12, costUsd: -1 },
    });

    expect(finished.status).toBe(400);
  });

  it('keeps what the recorder spent on models when it finishes', async () => {
    const { start, record } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });

    const finished = await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'recorded', seconds: 12, costUsd: 1.27 },
    });

    expect(await finished.json()).toMatchObject({ status: 'recorded', costUsd: 1.27 });
  });
});

describe('how a film was voiced and mixed', () => {
  const putYaml = (app: Awaited<ReturnType<typeof booted>>['app'], body: string) =>
    app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/yaml',
        'change-reason': 'stemme, uttale og musikk',
      },
      body,
    });

  it('saves respellings, spoken lines, music, example data and words to hide with a demo', async () => {
    const { app } = await booted();

    const saved = await putYaml(
      app,
      demoYaml
        .replace('voice: nb-NO-PernilleNeural', 'voice: elevenlabs-film')
        .replace(
          'steps:',
          'respell:\n  elevenlabs:\n    Digdir: Digg-dir\nmusic: pulse\nexampleData: true\nscrub: [Intern]\nsteps:',
        )
        .replace(
          '  - say: Først velger vi hva vi vil prøve.',
          '  - say: Genki er her.\n    spoken:\n      elevenlabs: Genn-ki er her.',
        ),
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      respell: { elevenlabs: { Digdir: 'Digg-dir' } },
      music: 'pulse',
      exampleData: true,
      scrub: ['Intern'],
      steps: [{ say: 'Genki er her.', spoken: { elevenlabs: 'Genn-ki er her.' } }, {}],
    });
  });

  it('refuses a demo with a key-like value, and says where it is', async () => {
    const { app } = await booted();

    const refused = await putYaml(
      app,
      demoYaml.replace(
        'Så stiller vi et spørsmål.',
        'Nøkkelen er sk_0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
    );

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      errors: [{ path: 'steps.1.say', message: expect.stringMatching(/Key Vault/) as string }],
    });
  });

  it('refuses a respelling for a voice provider it does not know', async () => {
    const { app } = await booted();

    const refused = await putYaml(
      app,
      demoYaml.replace('steps:', 'respell:\n  polly:\n    Genki: Genn-ki\nsteps:'),
    );

    expect(refused.status).toBe(400);
  });

  it('keeps the score of each voiced line and the measured loudness when the recorder finishes', async () => {
    const { start, record, send } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    const lines = [
      {
        step: 2,
        takes: 4,
        score: 3,
        missing: ['spørsmål'],
        extra: ['spørre'],
        keyTermsMissing: [],
        wordsPerSecond: 2.4,
      },
    ];
    const sound = { voice: -15.1, music: -37.2, mix: -15.4, peak: -1.6 };

    const finished = await record(`/recorder/recordings/${recording.id}/finish`, {
      json: { status: 'recorded', seconds: 12, lines, sound },
    });
    const shown = await readJson(
      await send(`/operator/recordings/${recording.id}`, 'operator', { method: 'GET' }),
    );

    expect(finished.status).toBe(200);
    expect(shown).toMatchObject({ lines, sound });
  });

  it('refuses a line score with more than four takes or a loudness outside what can be measured', async () => {
    const { start, record } = await booted();
    const recording = await start();
    await record(`/recorder/recordings/${recording.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    const line = { step: 1, takes: 5, score: 0, missing: [], extra: [], keyTermsMissing: [] };

    for (const json of [
      { status: 'recorded', lines: [line] },
      { status: 'recorded', sound: { mix: 40, peak: 0 } },
    ])
      expect((await record(`/recorder/recordings/${recording.id}/finish`, { json })).status).toBe(
        400,
      );
  });
});
