import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryDefinitionStore,
  SettingsRegistry,
  type DefinitionStore,
  type PluginSchemas,
} from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import {
  createPostgresStores,
  LocalKeyWrapper,
  PostgresDefinitionStore,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { createAdmin, serviceIdTakenType } from './admin.js';
import { createApp } from './app.js';
import { createPlatform } from './composition.js';
import { environmentsOf } from './service-environments.js';
import { digdir, principals, settingDefinitions } from './testkit.js';

const serviceNamed = (id: string, purpose: string) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id, name: id },
  spec: {
    purpose,
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'fake/gpt', residency: 'global' },
  },
});

let container: StartedPostgreSqlContainer | undefined;
type Database = Awaited<ReturnType<typeof createPostgresStores>>;
let db: Database | undefined;

const startPostgres = async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    new LocalKeyWrapper(randomBytes(32)),
  );
};

const stopDatabase = async () => {
  await db?.close();
  await db?.runtimePool.end();
  await db?.pool.end();
  await stopPostgres(container);
};

const stores: Record<string, (plugins: PluginSchemas) => DefinitionStore> = {
  memory: (plugins) => new InMemoryDefinitionStore({ ...plugins, settings: settingDefinitions }),
  postgres: (plugins) =>
    new PostgresDefinitionStore((db as Database).runtimePool, {
      ...plugins,
      settings: settingDefinitions,
    }),
};

const boot = async (store: (plugins: PluginSchemas) => DefinitionStore) => {
  const settings = new SettingsRegistry(settingDefinitions);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            families: { openai: '' },
            baseURL: 'http://127.0.0.1:9/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/gpt',
            endpoint: 'fake',
            deployment: 'gpt',
            residency: 'norway',
            capabilities: ['stream'],
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    settings,
    definitions: store,
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      caller: platform.caller,
      admin,
      drafts: platform.serviceDrafts,
      environments: (tenant, id) => environmentsOf(platform.configEntries, tenant, id),
    },
  });
  platform.mount(app, admin);
  const send = async (method: string, path: string, body: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: 'Bearer kari',
        'change-reason': 'testendring',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const versionsOf = async (id: string) =>
    (await platform.definitions.versions('Service', digdir, id)).length;
  return { send, versionsOf };
};

describe.each(Object.keys(stores))('publishing a new service against the %s store', (name) => {
  const boots = () => boot(stores[name] as (plugins: PluginSchemas) => DefinitionStore);
  if (name === 'postgres') {
    beforeAll(startPostgres, 120_000);
    afterAll(stopDatabase);
  }
  const unique = (base: string) => `${base}-${name}-${randomBytes(3).toString('hex')}`;

  it('refuses to publish a new service under an id another service has', async () => {
    const { send, versionsOf } = await boots();
    const id = unique('kopi-av-svar');
    await send('POST', '/definitions', { definition: serviceNamed(id, 'Den første kopien') });

    const second = await send('POST', '/definitions', {
      definition: serviceNamed(id, 'Den andre kopien'),
      newService: true,
      draftRevision: 1,
    });

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ type: serviceIdTakenType, id });
    expect(await versionsOf(id)).toBe(1);
  });

  it('refuses a new service under the id of an archived service', async () => {
    const { send, versionsOf } = await boots();
    const id = unique('arkivert');
    await send('POST', '/definitions', { definition: serviceNamed(id, 'Arkiveres snart') });
    const archived = await send('PUT', `/tenants/${digdir}/services/${id}/lifecycle`, {
      state: 'archived',
    });
    expect(archived.status).toBe(200);

    const reused = await send('POST', '/definitions', {
      definition: serviceNamed(id, 'En ny tjeneste med samme navn'),
      newService: true,
    });

    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ type: serviceIdTakenType, id });
    expect(await versionsOf(id)).toBe(1);
  });

  it('lets only one of two new services that publish under the same id at once through', async () => {
    const { send, versionsOf } = await boots();
    const id = unique('samtidig');

    const both = await Promise.all(
      ['Den ene', 'Den andre'].map((purpose) =>
        send('POST', '/definitions', { definition: serviceNamed(id, purpose), newService: true }),
      ),
    );

    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.status === 409)?.body).toMatchObject({ type: serviceIdTakenType });
    expect(await versionsOf(id)).toBe(1);
  });

  it('publishes a new service under a free id as version 1', async () => {
    const { send } = await boots();
    const id = unique('ledig');

    const first = await send('POST', '/definitions', {
      definition: serviceNamed(id, 'Helt ny'),
      newService: true,
    });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id, version: 1 });
  });

  it('still publishes a new version of a service from its own draft', async () => {
    const { send, versionsOf } = await boots();
    const id = unique('svar');
    await send('POST', '/definitions', { definition: serviceNamed(id, 'Første versjon') });
    const saved = await send('PUT', `/tenants/${digdir}/services/${id}/draft`, {
      definition: serviceNamed(id, 'Endret i utkastet'),
      files: {},
    });
    expect(saved.status).toBe(200);

    const next = await send('POST', '/definitions', {
      definition: serviceNamed(id, 'Endret i utkastet'),
      files: {},
      draftRevision: saved.body.revision,
    });

    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ id, version: 2 });
    expect(await versionsOf(id)).toBe(2);
  });

  it('still publishes a new version of a service straight from its definition', async () => {
    const { send } = await boots();
    const id = unique('yaml');
    await send('POST', '/definitions', { definition: serviceNamed(id, 'Første versjon') });

    const next = await send('POST', '/definitions', {
      definition: serviceNamed(id, 'Andre versjon'),
    });

    expect(next.status).toBe(201);
    expect(next.body).toMatchObject({ id, version: 2 });
  });
});
