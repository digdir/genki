import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  createAuthenticator,
  createMockAltinnPdp,
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  type IdentityTestDataInput,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { createAdmin } from './admin.js';
import { withPdpActions } from './altinn-pdp.js';
import { createApp } from './app.js';
import { createPlatform, platformCaller } from './composition.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { demoKind, latestRecordings, readDemo, recorderKeyDigest } from './demos.js';
import { lockedEnvironmentType } from './lockdown.js';
import { operatorDirectory, splitOperators } from './operators.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir } from './testkit.js';

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';
const operatorPid = '02027012345';
const recorderKey = 'opptaker-nøkkel-for-test';

const demoYaml = `title: Prøv en tjeneste
language: nb-NO
voice: nb-NO-PernilleNeural
app: portal
path: /#/playground
steps:
  - say: Først velger vi hva vi vil prøve.
`;

const boot = async () => {
  const raw = parseYaml(
    readFileSync(join(import.meta.dirname, '..', 'config', 'local', 'identity.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  delete raw.devLogin;
  const { testData, operatorPids } = splitOperators(raw);
  const key = await createSigningKey();
  const mock = createMockAnsattporten({ issuer, key, testData: testData as IdentityTestDataInput });
  const operators = operatorDirectory({ pids: operatorPids, mockIssuer: issuer });
  const verifier = operators.watch(
    withPdpActions(
      createTokenVerifier({
        issuers: [
          {
            kind: 'ansattporten',
            issuer,
            audience: 'digdir:genai',
            keys: createLocalJWKSet({ keys: [key.publicJwk] }),
          },
        ],
      }),
      createMockAltinnPdp(testData as IdentityTestDataInput),
      resource,
    ),
  );
  const authenticator = createAuthenticator({ verifier, apiKeys: new InMemoryTenantApiKeys() });
  const settings = new SettingsRegistry(platformSettings);
  const configEntries = new InMemoryConfigEntryStore();
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    configurables: { store: configEntries, scheduleIntervalMs: 0 },
    policy: { decide: async () => ({ allow: true }) },
    blobStore: new InMemoryBlobStore(),
    demoRecorderKeyDigest: recorderKeyDigest(recorderKey),
    lockdown: { configuredKeys: new Set() },
    authenticate: platformCaller(authenticator, { isOperator: operators.isOperator }),
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
    models: platform.models,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      tenantGate: platform.tenantGate,
      registered: platform.registered,
      caller: platform.caller,
      lockdown: true,
      loginRefusal: async (request) => {
        const checked = await authenticator.check(request);
        return checked.ok ? undefined : checked.code;
      },
    },
  });
  platform.mount(app, admin);
  const read = readDemo(demoYaml);
  if (!read.ok) throw new Error('fixture is invalid');
  await configEntries.append({
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
  const operatorToken = (await mock.testTokens(operatorPid, 'local-console', [resource]))
    .access_token;
  const start = (headers: Record<string, string>) =>
    app.request('/recorder/demos/playground/recordings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ genkiVersion: '0.43.0', narrated: false }),
    });
  const recordings = async () => (await latestRecordings(configEntries)).length;
  return { app, start, recordings, operatorToken };
};

describe('the recorder routes in the locked test environment', () => {
  it('accept a recorder call with the recorder key and no bearer token', async () => {
    const { app, start, recordings } = await boot();

    const started = await start({ 'x-recorder-key': recorderKey });
    const { id } = (await started.json()) as { id: string };
    const upload = await app.request(`/recorder/recordings/${id}/files/demo.mp4`, {
      method: 'PUT',
      headers: { 'x-recorder-key': recorderKey },
      body: new Uint8Array([1, 2, 3]),
    });
    const finish = await app.request(`/recorder/recordings/${id}/finish`, {
      method: 'POST',
      headers: { 'x-recorder-key': recorderKey, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'recorded', seconds: 12 }),
    });

    expect([started.status, upload.status, finish.status]).toEqual([201, 200, 200]);
    expect(await recordings()).toBe(1);
  });

  it('refuse a recorder call without the key or with a wrong key', async () => {
    const { start, recordings } = await boot();

    const without = await start({});
    const wrong = await start({ 'x-recorder-key': 'gjettet-nøkkel' });

    expect([without.status, wrong.status]).toEqual([401, 401]);
    expect(await without.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
    expect(await wrong.json()).toMatchObject({ type: 'urn:genai:problem:recorder-key' });
    expect(await recordings()).toBe(0);
  });

  it('open no other route with the recorder key alone', async () => {
    const { app } = await boot();
    const headers = { 'x-recorder-key': recorderKey };

    const library = await app.request('/operator/demos', { headers });
    const tenant = await app.request(`/tenants/${digdir}/definitions`, { headers });
    const save = await app.request('/operator/demos/playground', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/yaml', 'change-reason': 'ny versjon' },
      body: demoYaml,
    });

    expect(library.status).toBe(401);
    expect(tenant.status).toBe(401);
    expect(save.status).toBe(401);
  });

  it('refuse an operator bearer token on the recorder routes', async () => {
    const { app, start, recordings, operatorToken } = await boot();
    const bearer = { authorization: `Bearer ${operatorToken}` };

    const library = await app.request('/operator/demos', { headers: bearer });
    const response = await start({ ...bearer, 'change-reason': 'tar opp demoen for hånd' });

    expect(library.status).toBe(200);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ type: lockedEnvironmentType });
    expect(await recordings()).toBe(0);
  });
});
