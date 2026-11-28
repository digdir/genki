import { createLocalJWKSet, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createSigningKey } from '@genai/identity';
import { InMemoryBlobStore } from '@genai/port-blob';
import { platformScope } from './config-store.js';
import { recorderJobFrom } from './demo-recorder-job.js';
import { demoKind, latestRecordings, readDemo } from './demos.js';
import { bootPlatform, digdir, principals, readJson } from './testkit.js';

const job =
  '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-genki-test-weu/providers/Microsoft.App/jobs/genai-test-demo-recorder';
const recorderId = '6f1c2a4e-8d3b-4f5a-9e7c-1b2d3e4f5a6b';
const binderId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const entraTenant = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const audience = 'api://genki-test-api';

const demoYaml = `title: Prøv en tjeneste
language: nb-NO
voice: nb-NO-PernilleNeural
app: portal
path: /#/playground
steps:
  - say: Først velger vi hva vi vil prøve.
`;

const armValue = ['arm', String(Date.now())].join('-');
const armToken = async () => ({ token: armValue });

describe('the recorder job starter', () => {
  it('is off unless GENAI_DEMO_RECORDER is job and the job is an Azure job id', () => {
    expect(recorderJobFrom({ GENAI_DEMO_RECORDER_JOB: job }, armToken)).toBeUndefined();
    expect(
      recorderJobFrom({ GENAI_DEMO_RECORDER: 'scheduled', GENAI_DEMO_RECORDER_JOB: job }, armToken),
    ).toBeUndefined();
    for (const wrong of [
      '',
      'genai-test-demo-recorder',
      `${job}/../../containerApps/genai-test-api`,
      job.replace('Microsoft.App/jobs', 'Microsoft.App/containerApps'),
      `https://management.azure.com${job}`,
    ])
      expect(
        recorderJobFrom({ GENAI_DEMO_RECORDER: 'job', GENAI_DEMO_RECORDER_JOB: wrong }, armToken),
      ).toBeUndefined();
  });

  it('starts the one job by its id with the API identity token and no template override', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const scopes: string[] = [];
    const start = recorderJobFrom(
      { GENAI_DEMO_RECORDER: 'job', GENAI_DEMO_RECORDER_JOB: job },
      async (scope) => {
        scopes.push(scope);
        return { token: armValue };
      },
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    );

    await start?.('3c0a2b9e-1f4d-4b8a-9c7e-2d1f0e3b4a5c');

    expect(scopes).toEqual(['https://management.azure.com/.default']);
    expect(calls.map((c) => c.url)).toEqual([
      `https://management.azure.com${job}/start?api-version=2024-03-01`,
    ]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.headers).toEqual({ authorization: `Bearer ${armValue}` });
  });

  it('fails when Azure refuses the start, without the token in the error', async () => {
    const start = recorderJobFrom(
      { GENAI_DEMO_RECORDER: 'job', GENAI_DEMO_RECORDER_JOB: job },
      armToken,
      (async () => new Response('denied', { status: 403 })) as typeof fetch,
    );

    await expect(start?.('x')).rejects.toThrow('the recorder job did not start: 403');
    await expect(start?.('x')).rejects.not.toThrow(armValue);
  });
});

const boot = async (
  options: { job?: (recording: string) => Promise<void>; lockdown?: boolean } = {},
) => {
  const key = await createSigningKey();
  const platform = await bootPlatform({
    people: principals,
    blobStore: new InMemoryBlobStore(),
    demoRecorderTrust: {
      principalId: recorderId,
      tenantId: entraTenant,
      audience,
      keys: createLocalJWKSet({ keys: [key.publicJwk] }),
    },
    ...(options.job ? { demoRecorderJob: options.job } : {}),
    ...(options.lockdown ? { lockdown: true, appLockdown: true } : {}),
  });
  const read = readDemo(demoYaml);
  if (!read.ok) throw new Error('fixture is invalid');
  for (const id of ['playground', 'catalog'])
    await platform.configEntries.append({
      kind: demoKind,
      scope: platformScope,
      id,
      version: 1,
      spec: read.spec,
      deleted: false,
      by: 'platform:seed',
      at: '2026-11-17T10:00:00.000Z',
      reason: 'demos/*.yaml in the repository',
    });
  const token = (claims: Record<string, unknown> = {}, aud = audience) =>
    new SignJWT({ tid: entraTenant, oid: recorderId, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(`https://sts.windows.net/${entraTenant}/`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key.privateKey);
  const call = (
    path: string,
    bearer: string | undefined,
    init: { method?: string; json?: unknown; body?: BodyInit } = {},
  ) =>
    platform.app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json),
    });
  const queue = (demo = 'playground') =>
    platform.send(`/operator/demos/${demo}/recordings`, 'operator', {
      method: 'POST',
      body: {},
      reason: 'ny innspilling til biblioteket',
    });
  return { ...platform, token, call, queue };
};

describe('recording in the recorder job', () => {
  it('says the job takes queued recordings, and hands each queued recording to it', async () => {
    const started: string[] = [];
    const { send, queue } = await boot({
      job: async (recording) => {
        started.push(recording);
      },
    });

    const library = await readJson<{ recorder: string }>(await send('/operator/demos', 'operator'));
    const queued = await queue();

    expect(library.recorder).toBe('job');
    expect(queued.status).toBe(202);
    expect(started).toEqual([(await readJson<{ id: string }>(queued)).id]);
  });

  it('marks a recording failed and answers 503 when the job does not start', async () => {
    const { queue, configEntries } = await boot({
      job: async () => {
        throw new Error('the recorder job did not start: 403');
      },
    });

    const queued = await queue();

    expect(queued.status).toBe(503);
    expect((await latestRecordings(configEntries)).map((r) => r.spec.status)).toEqual(['failed']);
  });

  it('lets the recorder take up, upload to and finish a queued recording with its Entra token', async () => {
    const { call, queue, token, admin } = await boot({ job: async () => undefined });
    const { id } = await readJson<{ id: string }>(await queue());
    const bearer = await token();

    const listed = await readJson<{ data: { id: string }[] }>(
      await call('/recorder/recordings?status=queued', bearer),
    );
    const started = await call('/recorder/demos/playground/recordings', bearer, {
      method: 'POST',
      json: { genkiVersion: '0.43.0', narrated: false, recording: id },
    });
    const upload = await call(`/recorder/recordings/${id}/files/demo.mp4`, bearer, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    const finish = await call(`/recorder/recordings/${id}/finish`, bearer, {
      method: 'POST',
      json: { status: 'recorded', seconds: 12 },
    });

    expect(listed.data.map((r) => r.id)).toEqual([id]);
    expect([started.status, upload.status, finish.status]).toEqual([201, 200, 200]);
    expect(
      (await admin.audit(digdir))
        .filter((a) => a.target === `demo-recording:${id}`)
        .map((a) => [a.action, a.actor]),
    ).toEqual([
      ['platform.demo.recording.start', expect.any(String)],
      ['platform.demo.recording.start', 'platform:recorder'],
      ['platform.demo.recording.finish', 'platform:recorder'],
    ]);
  });

  it('refuses a token of another identity, a delegated token, another audience and an operator', async () => {
    const { call, token } = await boot({ job: async () => undefined });
    const wrong = [
      await token({ oid: binderId }),
      await token({ scp: 'user_impersonation' }),
      await token({ tid: '11111111-2222-3333-4444-555555555555' }),
      await token({}, 'api://annen'),
      'operator',
      undefined,
    ];

    for (const bearer of wrong) {
      const listed = await call('/recorder/recordings?status=queued', bearer);
      const started = await call('/recorder/demos/playground/recordings', bearer, {
        method: 'POST',
        json: { genkiVersion: '0.43.0', narrated: false },
      });
      expect([listed.status, started.status]).toEqual([401, 401]);
    }
  });

  it('queues one recording at a time across demos, since each job run records the whole queue', async () => {
    const { send, queue } = await boot({ job: async () => undefined });
    const { id } = await readJson<{ id: string }>(await queue());

    const second = await queue('catalog');
    const cancelled = await send(`/operator/recordings/${id}/cancel`, 'operator', {
      method: 'POST',
      body: {},
      reason: 'feil demo i køen',
    });
    const afterCancel = await queue('catalog');

    expect([second.status, cancelled.status, afterCancel.status]).toEqual([409, 200, 202]);
  });

  it('opens no route but the recorder routes with the recorder’s Entra token', async () => {
    const { call, token } = await boot({ job: async () => undefined });
    const bearer = await token();

    const responses = [
      await call('/operator/demos', bearer),
      await call(`/tenants/${digdir}/definitions`, bearer),
      await call('/operator/demos/playground/recordings', bearer, { method: 'POST', json: {} }),
    ];

    expect(responses.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it('lets the recorder start and finish with its Entra token in the locked test environment', async () => {
    const { call, token, configEntries } = await boot({ lockdown: true });
    const bearer = await token();

    const started = await call('/recorder/demos/playground/recordings', bearer, {
      method: 'POST',
      json: { genkiVersion: '0.43.0', narrated: false },
    });
    const { id } = await readJson<{ id: string }>(started);
    const upload = await call(`/recorder/recordings/${id}/files/demo.mp4`, bearer, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });
    const finish = await call(`/recorder/recordings/${id}/finish`, bearer, {
      method: 'POST',
      json: { status: 'recorded', seconds: 12 },
    });

    expect([started.status, upload.status, finish.status]).toEqual([201, 200, 200]);
    expect((await latestRecordings(configEntries)).map((r) => r.spec.status)).toEqual(['recorded']);
  });
});
