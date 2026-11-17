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

const booted = async () => {
  let second = 0;
  const now = () => new Date(Date.UTC(2026, 10, 17, 10, 0, second++));
  const blobs = new InMemoryBlobStore();
  const platform = await bootPlatform({
    people: principals,
    blobStore: blobs,
    demoRecorderKeyDigest: recorderKeyDigest(recorderKey),
    modules: [
      ...platformModules.filter((m) => m !== demosModule),
      createDemosModule({ now }),
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

  it('lists each demo with its newest recording and its newest finished one', async () => {
    const { send, record, start } = await booted();
    const good = await start();
    await record(`/recorder/recordings/${good.id}/files/demo.mp4`, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    await record(`/recorder/recordings/${good.id}/finish`, {
      json: { status: 'recorded', seconds: 64 },
    });
    const broken = await start();
    await record(`/recorder/recordings/${broken.id}/finish`, {
      json: { status: 'failed', failure: { step: 2, message: 'fant ikke knappen Send' } },
    });

    const library = await readJson<{
      data: { id: string; latest?: Recording; recorded?: Recording }[];
    }>(await send('/operator/demos', 'operator'));

    expect(library.data).toMatchObject([
      {
        id: 'playground',
        latest: { id: broken.id, status: 'failed', failure: { step: 2 } },
        recorded: { id: good.id, status: 'recorded', demoVersion: 1 },
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
