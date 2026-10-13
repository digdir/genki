import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { secretRef, type KnowledgeAdapter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { pgvectorEngine } from '@genai/providers-pgvector';
import { typesense } from '@genai/providers-typesense';
import { typesenseIndexWriter } from '@genai/providers-typesense-writer';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { describeEngines, type EngineDescription } from './knowledge-engines.js';

type Schema = {
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  additionalProperties?: Schema;
  [key: string]: unknown;
};

const pgvector = pgvectorEngine({ pool: {} as Parameters<typeof pgvectorEngine>[0]['pool'] });

const drift: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };

const boot = async () => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async () => ({ principal: drift }),
  });
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  return app;
};

describe('knowledge engine descriptions', () => {
  it('the engines route describes title, tech and builtin', async () => {
    const app = await boot();
    const response = await app.request('/operator/knowledge/engines', {
      headers: { authorization: 'Bearer drift' },
    });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: EngineDescription[] };
    expect(data.find((e) => e.engine === 'typesense')).toMatchObject({
      title: 'Typesense',
      tech: 'Typesense',
      builtin: false,
      probe: true,
      requiresBaseURL: true,
      writeKeyRequired: true,
    });
    expect(data.find((e) => e.engine === 'typesense')).not.toHaveProperty('runsAt');
    expect(data.find((e) => e.engine === 'http-search')).toMatchObject({
      builtin: false,
      writeKeyRequired: false,
    });
    for (const engine of data) expect(engine.title).toBeTruthy();

    const local = describeEngines([pgvector.adapter], [pgvector.writer], {
      platformDataLocation: 'norway',
    });
    expect(local).toEqual([
      expect.objectContaining({
        engine: 'pgvector',
        title: 'Innebygd søk',
        tech: 'Postgres med pgvector',
        builtin: true,
        runsAt: 'platform',
        dataLocation: 'norway',
        writeKeyRequired: false,
        probe: true,
        requiresBaseURL: false,
        writer: { needsVectors: true },
      }),
    ]);
    expect(describeEngines([pgvector.adapter], [])[0]).not.toHaveProperty('dataLocation');
  });

  it('secret fields carry x-secret in the engine JSON Schema', () => {
    const custom = {
      ...memoryEngine({ engine: 'egen' }).adapter,
      endpointOptions: z.strictObject({
        key: secretRef(),
        region: z.enum(['norwayeast', 'swedencentral']).meta({
          enumTitles: ['Norge øst', 'Sverige sentralt'],
        }),
      }),
    } as KnowledgeAdapter;
    const [egen, pg, ts] = describeEngines(
      [custom, pgvector.adapter, typesense],
      [typesenseIndexWriter()],
    ) as [EngineDescription, EngineDescription, EngineDescription];

    const options = egen.endpointOptions as Schema;
    expect(options.properties?.key).toMatchObject({ type: 'string', 'x-secret': true });
    expect(options.properties?.region).toMatchObject({
      enum: ['norwayeast', 'swedencentral'],
      enumTitles: ['Norge øst', 'Sverige sentralt'],
    });
    expect((egen.endpoint as Schema).properties?.options?.properties?.key).toMatchObject({
      'x-secret': true,
    });

    const auth = (ts.endpoint as Schema).properties?.auth as Schema;
    const kinds = (auth.oneOf ?? auth.anyOf ?? []) as Schema[];
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds.filter((k) => k.properties?.secret))
      expect(kind.properties?.secret).toMatchObject({ 'x-secret': true });
    expect((ts.endpoint as Schema).properties?.baseURL).toMatchObject({ format: 'uri' });

    expect((pg.endpoint as Schema).properties).not.toHaveProperty('auth');
    expect((pg.endpointOptions as Schema).properties?.connection).toMatchObject({
      enumTitles: ['Plattformens database'],
    });
    const profile = (pg.datasetOptions as Schema).properties?.profiles?.additionalProperties;
    expect(profile?.properties?.mode).toMatchObject({
      enumTitles: ['Ordsøk', 'Betydningssøk', 'Kombinert søk'],
    });
  });
});
