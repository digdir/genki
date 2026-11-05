import { describe, expect, it } from 'vitest';
import { apiRegistry, parseCatalog, type ModelClassification } from '@genai/port-model';
import { anthropicMessages } from '@genai/providers-anthropic';
import { azureDeployments, openAiChat } from '@genai/providers-openai';
import { CatalogRegistry } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope, type ConfigEntry } from './config-store.js';
import {
  connectionMigrationActor,
  migratedCatalog,
  migrateConnections,
  registryApiFor,
} from './connection-migration.js';
import { processorRecordKind } from './operation-governance.js';

const apis = apiRegistry([openAiChat, anthropicMessages]);
const root = 'https://res.services.ai.azure.com';
const key = { kind: 'api-key', header: 'api-key', secret: 'secret://platform/foundry-key' };

const record = {
  agreement: 'Databehandleravtale med Microsoft',
  subProcessors: [{ name: 'Microsoft Ireland', location: 'EU' }],
  retention: { days: 30 },
};

const put = async (
  store: InMemoryConfigEntryStore,
  kind: string,
  id: string,
  spec: unknown,
  scope = platformScope,
) => {
  const entry: ConfigEntry<unknown> = {
    kind,
    scope,
    id,
    version: (await store.history(kind, scope, id)).length + 1,
    spec,
    deleted: false,
    by: 'ola',
    at: '2026-10-01T00:00:00.000Z',
    reason: 'set up before ADR 0048',
  };
  await store.append(entry);
};

const classifications = (initial: Record<string, unknown>) => {
  const saved: Record<string, ModelClassification> = structuredClone(initial) as typeof saved;
  return {
    saved,
    load: async () => structuredClone(saved),
    save: async (id: string, c: ModelClassification) => {
      saved[id] = c;
    },
  };
};

const legacyStore = async () => {
  const store = new InMemoryConfigEntryStore();
  await put(store, 'model-endpoint', 'foundry-openai', {
    protocol: 'openai-chat',
    baseURL: `${root}/openai/v1`,
    auth: key,
    options: {},
    discovery: { source: 'azure-deployments', exclude: ['claude-*'] },
  });
  await put(store, 'model-endpoint', 'foundry-claude', {
    protocol: 'anthropic-messages',
    baseURL: `${root}/anthropic`,
    auth: key,
    discovery: { source: 'azure-deployments', from: 'foundry-openai', include: ['claude-*'] },
  });
  await put(store, 'model', 'foundry-openai/gpt-6-luna', {
    endpoint: 'foundry-openai',
    deployment: 'gpt-6-luna',
    residency: 'eu',
    operations: ['chat', 'decide'],
    options: { api: 'responses' },
  });
  await put(store, 'model', 'foundry-claude/claude-opus', {
    endpoint: 'foundry-claude',
    deployment: 'claude-opus',
    residency: 'global',
    options: { defaultMaxTokens: 8192 },
  });
  await put(store, processorRecordKind, 'foundry-openai', record);
  return store;
};

const latest = async (store: InMemoryConfigEntryStore, kind: string) =>
  new Map(
    (await store.latest({ kind }))
      .filter((e) => !e.deleted)
      .map((e) => [e.id, e.spec as Record<string, unknown>]),
  );

describe('moving model connections to the shape of ADR 0048', () => {
  it('migrating merges connections on the same resource and keeps model ids', async () => {
    const store = await legacyStore();
    const classified = classifications({
      'foundry-openai/gpt-5-mini': { operations: ['chat'], residency: 'eu' },
    });

    const result = await migrateConnections({
      store,
      seed: { endpoints: {}, models: [] },
      apis,
      classifications: classified,
    });

    expect(result).toMatchObject({ endpoints: 1, models: 2, removed: 2, processorRecords: 1 });
    const endpoints = await latest(store, 'model-endpoint');
    expect([...endpoints.keys()]).toEqual(['foundry']);
    expect(endpoints.get('foundry')).toEqual({
      baseURL: root,
      auth: key,
      families: { anthropic: '/anthropic', openai: '/openai/v1' },
      discovery: [
        {
          source: 'azure-deployments',
          include: ['claude-*'],
          idPrefix: 'foundry-claude',
          apis: { chat: 'anthropic/messages@1' },
        },
        {
          source: 'azure-deployments',
          exclude: ['claude-*'],
          idPrefix: 'foundry-openai',
          apis: { chat: 'openai/chat-completions@1' },
        },
      ],
    });
    const models = await latest(store, 'model');
    expect(models.get('foundry-openai/gpt-6-luna')).toEqual({
      endpoint: 'foundry',
      deployment: 'gpt-6-luna',
      residency: 'eu',
      options: {},
      apis: { chat: 'openai/responses@1', decide: 'openai/decide@1' },
    });
    expect(models.get('foundry-claude/claude-opus')).toMatchObject({
      endpoint: 'foundry',
      apis: { chat: 'anthropic/messages@1' },
      options: { defaultMaxTokens: 8192 },
    });
    const records = await latest(store, processorRecordKind);
    expect([...records]).toEqual([['foundry', record]]);
    expect(classified.saved['foundry-openai/gpt-5-mini']).toEqual({
      residency: 'eu',
      apis: { chat: 'openai/chat-completions@1' },
    });
    expect((await store.history('model-endpoint', platformScope, 'foundry')).at(-1)?.by).toBe(
      connectionMigrationActor,
    );
  });

  it('migrating twice changes nothing the second time', async () => {
    const store = await legacyStore();
    const input = { store, seed: { endpoints: {}, models: [] }, apis };
    await migrateConnections(input);
    const before = await store.latest();

    const again = await migrateConnections(input);

    expect(again).toEqual({
      endpoints: 0,
      models: 0,
      removed: 0,
      processorRecords: 0,
      classifications: 0,
    });
    expect(await store.latest()).toEqual(before);
  });

  it('endpoints with another credential stay their own connection', async () => {
    const store = await legacyStore();
    await put(store, 'model-endpoint', 'foundry-claude', {
      protocol: 'anthropic-messages',
      baseURL: `${root}/anthropic`,
      auth: { kind: 'api-key', secret: 'secret://platform/claude-key' },
    });

    await migrateConnections({ store, seed: { endpoints: {}, models: [] }, apis });

    const endpoints = await latest(store, 'model-endpoint');
    expect([...endpoints.keys()].sort()).toEqual(['foundry-claude', 'foundry-openai']);
    expect(endpoints.get('foundry-claude')).toMatchObject({
      baseURL: root,
      families: { anthropic: '/anthropic' },
    });
    expect((await latest(store, 'model')).get('foundry-claude/claude-opus')).toMatchObject({
      endpoint: 'foundry-claude',
    });
  });

  it('a seed connection whose rules name former ids takes over their models and processor records', async () => {
    const store = new InMemoryConfigEntryStore();
    await put(store, 'model', 'foundry-openai/kandidat', {
      endpoint: 'foundry-openai',
      deployment: 'kandidat',
      residency: 'eu',
    });
    await put(store, processorRecordKind, 'foundry-claude', record);
    const seed = {
      endpoints: {
        foundry: {
          baseURL: root,
          auth: key,
          families: { openai: '/openai/v1', anthropic: '/anthropic' },
          discovery: [
            {
              source: 'azure-deployments',
              idPrefix: 'foundry-openai',
              apis: { chat: 'openai/chat-completions@1' },
            },
            {
              source: 'azure-deployments',
              idPrefix: 'foundry-claude',
              apis: { chat: 'anthropic/messages@1' },
            },
          ],
        },
      },
      models: [],
    };

    await migrateConnections({ store, seed, apis });

    expect((await latest(store, 'model')).get('foundry-openai/kandidat')).toEqual({
      endpoint: 'foundry',
      deployment: 'kandidat',
      residency: 'eu',
      apis: { chat: 'openai/chat-completions@1' },
    });
    expect([...(await latest(store, processorRecordKind))]).toEqual([['foundry', record]]);
  });

  it('the catalogue registry loads every migrated entry', async () => {
    const store = await legacyStore();
    await migrateConnections({ store, seed: { endpoints: {}, models: [] }, apis });
    let applied: unknown;
    const registry = new CatalogRegistry({
      seed: { models: { endpoints: {}, models: [] }, knowledge: {}, rerank: {} },
      store,
      checks: {
        models: (c) => {
          const parsed = parseCatalog(c, apis, [azureDeployments.kind]);
          return parsed.ok ? [] : parsed.errors;
        },
        knowledge: () => [],
        rerank: () => [],
      },
      apply: (catalogs) => {
        applied = catalogs.models;
      },
    });

    await registry.initialize();

    expect(registry.skipped()).toEqual([]);
    expect(applied).toMatchObject({
      endpoints: { foundry: { families: { openai: '/openai/v1', anthropic: '/anthropic' } } },
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'foundry-claude/claude-opus', endpoint: 'foundry' }),
        expect.objectContaining({ id: 'foundry-openai/gpt-6-luna', endpoint: 'foundry' }),
      ]),
    });
  });

  it('a catalogue file in the old shape is read in the new one', () => {
    const migrated = migratedCatalog(
      {
        endpoints: {
          'local-model': {
            protocol: 'openai-chat',
            baseURL: 'http://127.0.0.1:4010/v1',
            auth: { kind: 'bearer', secret: 'secret://env/local-model-key' },
          },
        },
        models: [
          { id: 'local/echo', endpoint: 'local-model', deployment: 'echo', residency: 'norway' },
        ],
      },
      registryApiFor(apis),
    );

    expect(migrated).toEqual({
      endpoints: {
        'local-model': {
          baseURL: 'http://127.0.0.1:4010',
          auth: { kind: 'bearer', secret: 'secret://env/local-model-key' },
          families: { openai: '/v1' },
          discovery: [],
        },
      },
      models: [
        { id: 'local/echo', endpoint: 'local-model', deployment: 'echo', residency: 'norway' },
      ],
    });
    expect(parseCatalog(migrated, apis).ok).toBe(true);
  });
});
