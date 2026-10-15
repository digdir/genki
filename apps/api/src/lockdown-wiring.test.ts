import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  createMockAltinnPdp,
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  type IdentityTestDataInput,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { withPdpActions } from './altinn-pdp.js';
import { createApp } from './app.js';
import { createPlatform, platformCaller } from './composition.js';
import { lockedEnvironmentType, refuseLockedRoutes } from './lockdown.js';
import { operatorDirectory, splitOperators } from './operators.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, testService } from './testkit.js';

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';
const manager = '01017012345';
const reason = 'Endring i testen';
const serviceKey = 'gp_service-key';
const tenantKey = 'gp_tenant-key';

const boot = async () => {
  const raw = parseYaml(
    readFileSync(join(import.meta.dirname, '..', 'config', 'local', 'identity.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  delete raw.devLogin;
  const { testData, operatorPids } = splitOperators(raw);
  const key = await createSigningKey();
  const mock = createMockAnsattporten({ issuer, key, testData: testData as IdentityTestDataInput });
  const operators = operatorDirectory(operatorPids);
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
  const keys = new InMemoryTenantApiKeys();
  await keys.add({
    id: 'service-key',
    name: 'Service key',
    digest: apiKeyDigest(serviceKey),
    tenant: digdir,
    scopes: ['query'],
    datasets: [],
    agents: [],
    service: 'klarsprak',
  });
  await keys.add({
    id: 'tenant-key',
    name: 'Tenant key',
    digest: apiKeyDigest(tenantKey),
    tenant: digdir,
    scopes: ['query'],
    datasets: ['*'],
    agents: ['*'],
  });
  const authenticator = createAuthenticator({ verifier, apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
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
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    lockdown: { configuredKeys: new Set() },
    authenticate: platformCaller(authenticator, { isOperator: operators.isOperator }),
  });
  await platform.definitions.publish(testService('klarsprak'), 'test', 'test', files);
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
  const token = (await mock.testTokens(manager, 'local-portal', [resource])).access_token;
  const send = (path: string, method: string, body: unknown, headers: Record<string, string>) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'change-reason': reason, ...headers },
      body: JSON.stringify(body),
    });
  const version = async () =>
    (await platform.definitions.get('Service', digdir, 'klarsprak'))?.version;
  return { send, token, version, settings };
};

describe('lockdown with the production authenticator', () => {
  it('refuses a TestID change in lockdown even with an extra API key header', async () => {
    const { send, token, version } = await boot();
    const before = await version();
    const publish = (headers: Record<string, string>) =>
      send(
        '/definitions',
        'POST',
        { definition: { ...testService('klarsprak') }, files },
        { authorization: `Bearer ${token}`, ...headers },
      );

    const plain = await publish({});
    const withKey = await publish({ 'x-api-key': 'x' });
    const withServiceKey = await publish({ 'x-api-key': serviceKey });

    expect(plain.status).toBe(403);
    expect(await plain.json()).toMatchObject({ type: lockedEnvironmentType });
    expect(withKey.status).toBe(401);
    expect(withServiceKey.status).toBe(401);
    expect(await version()).toBe(before);
  });

  it('refuses a TestID tenant setting in lockdown even with an extra API key header', async () => {
    const { send, token, settings } = await boot();
    const path = `/tenants/${digdir}/settings/usage.tenantCallsPerMinute`;

    const plain = await send(path, 'PUT', { value: 1 }, { authorization: `Bearer ${token}` });
    const withKey = await send(
      path,
      'PUT',
      { value: 1 },
      { authorization: `Bearer ${token}`, 'x-api-key': 'x' },
    );

    expect(plain.status).toBe(403);
    expect(withKey.status).toBe(401);
    expect(settings.effective(digdir)['usage.tenantCallsPerMinute']?.value).not.toBe(1);
  });

  it('does not accept an API key as a person on the definition routes', async () => {
    const { send, version } = await boot();
    const before = await version();

    const res = await send(
      '/definitions',
      'POST',
      { definition: testService('klarsprak'), files },
      { 'x-api-key': tenantKey },
    );

    expect(res.status).toBe(401);
    expect(await version()).toBe(before);
  });
});

describe('the lockdown gate', () => {
  const gated = () => {
    const app = new Hono();
    app.use(
      '*',
      refuseLockedRoutes(async () => undefined),
    );
    app.post('/definitions', (c) => c.text('published'));
    return app;
  };

  it('answers 401 when a presented credential resolves to nobody', async () => {
    const app = gated();

    const bearer = await app.request('/definitions', {
      method: 'POST',
      headers: { authorization: 'Bearer unknown' },
    });
    const key = await app.request('/definitions', {
      method: 'POST',
      headers: { 'x-api-key': 'unknown' },
    });

    expect(bearer.status).toBe(401);
    expect(key.status).toBe(401);
  });

  it('leaves a request without credentials to the route', async () => {
    const res = await gated().request('/definitions', { method: 'POST' });

    expect(res.status).toBe(200);
  });
});
