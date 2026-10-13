import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform } from './composition.js';

const tenant = '991825827';
const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) =>
  parseYaml(readFileSync(join(config, file), 'utf8')) as Record<string, unknown>;

const parityBudgetService = join(
  import.meta.dirname,
  '..',
  '..',
  'parity',
  'config',
  'services',
  'agent-budget-relaxed.yaml',
);

const flows = [
  'basic-rag',
  'multi-query-rag',
  'retrieve-and-rerank',
  'entity-extraction',
  'summarization',
  'multi-retrieval',
  'docs-outline',
  'docs-release-cross-check',
];
const services = [
  'simple-qa',
  'builtin-skills',
  'docs-agent',
  'kunnskapsassistenten',
  'kunnskapsassistenten-retrieve-only',
  'public-docs-agent',
  'public-docs-retrieve-only',
];

const parityTools = () => {
  const targets = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'parity', 'testsets', 'targets.json'),
      'utf8',
    ),
  ) as { testSets: Record<string, { new: Record<string, unknown> }> };
  return [
    ...new Set(
      Object.values(targets.testSets).flatMap((t) =>
        [t.new.agent, t.new.probe, t.new.relaxedAgent].filter(
          (x): x is string => typeof x === 'string',
        ),
      ),
    ),
  ];
};

const toolNames = [
  'simple-qa__default',
  'simple-qa__basic-rag',
  'simple-qa__multi-query-rag',
  'simple-qa__retrieve-and-rerank',
  'builtin-skills__entity-extraction',
  'builtin-skills__summarization',
  'builtin-skills__multi-retrieval',
  'docs-agent__outline-graph',
  'docs-agent__release-cross-check',
];

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
};
const sample = (schema: Schema): unknown => {
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v)]),
    );
  if (schema.type === 'array') return [sample(schema.items ?? { type: 'string' })];
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return true;
  return 'Altinn Studio';
};

const chunk = (id: string, index: number) => ({
  id,
  chunk_id: id,
  doc_num: 'd1',
  chunk_index: index,
  content_markdown: `Altinn Studio-dokumentasjonen sier ${id}.`,
  content_length: 40,
  metadata: '{"Header 1" "Altinn Studio"}',
});

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
});

const boot = async () => {
  const model = await fakeHttp((body) => {
    if (!body.messages)
      return {
        status: 200,
        json: {
          data: [
            { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
            { id: 'gpt-5-mini', model: 'gpt-5-mini', status: 'succeeded' },
          ],
        },
      };
    const format = body.response_format as { json_schema?: { schema: Schema } } | undefined;
    const content = format?.json_schema
      ? JSON.stringify(sample(format.json_schema.schema))
      : 'Svaret står i kilden [1].';
    return {
      status: 200,
      json: {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
  });
  const search = await fakeHttp((body) => ({
    status: 200,
    json: {
      results: (body.searches as Record<string, unknown>[]).map((s) =>
        s.facet_by
          ? { facet_counts: [], hits: [] }
          : String(s.collection).includes('phrases')
            ? {
                hits: ['c1', 'c2'].map((id) => ({
                  document: { chunk_id: id, search_phrase: id, doc_num: 'd1' },
                  hybrid_search_info: { rank_fusion_score: 0.8 },
                })),
              }
            : {
                hits: ['c1', 'c2'].map((id, i) => ({
                  document: chunk(id, i),
                  text_match_info: { score: '10' },
                })),
              },
      ),
    },
  }));
  const colbert = await fakeHttp((body) => ({
    status: 200,
    json: (body.documents as unknown[]).map((_, i) => ({
      index: i,
      score: 1 - i * 0.1,
      rank: i + 1,
    })),
  }));
  fakes.push(model, search, colbert);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: colbert.url,
  };
  const knowledge = yaml('knowledge.yaml');
  const kari = {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  } as Principal;
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(knowledge, 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
    egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const published: Record<string, unknown> = {};
  for (const file of [
    ...flows.map((f) => `flows/${f}.yaml`),
    ...services.map((s) => `services/${s}.yaml`),
  ])
    published[file] = await platform.definitions.publish(yaml(file), 'test', 'test');
  published['services/agent-budget-relaxed.yaml'] = await platform.definitions.publish(
    parseYaml(readFileSync(parityBudgetService, 'utf8')) as Record<string, unknown>,
    'test',
    'test',
  );
  return { app, published, model };
};

const mcp = (app: Hono, method: string, params: Record<string, unknown>, name?: string) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer kari',
      'content-type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('the benchmark service', () => {
  it('is not part of the boot seed, so it does not show up on the demo tenant', () => {
    expect(readdirSync(join(config, 'services'))).not.toContain('agent-budget-relaxed.yaml');
    expect(existsSync(parityBudgetService)).toBe(true);
  });
});

describe('the seeded flow files', () => {
  it('carry no comments that name the headless-rag graph they came from', () => {
    const files = readdirSync(join(config, 'flows')).filter((f) => f.endsWith('.yaml'));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(readFileSync(join(config, 'flows', file), 'utf8')).not.toMatch(/^#.*headless-rag/m);
  });
});

describe('headless-rag agents and skill graphs the platform rebuilt', () => {
  it('the named skill graphs, skills and docs graphs compile as step flows and publish as services', async () => {
    const { published } = await boot();

    for (const [file, result] of Object.entries(published))
      expect({ file, result }).toMatchObject({ file, result: { ok: true } });
  });

  it("headless-rag's simple-qa and docs agents and the built-in skills are published under their service tool names", async () => {
    const { app } = await boot();

    const res = await mcp(app, 'tools/list', {});
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);

    expect(names).toEqual(expect.arrayContaining(toolNames));
  });

  it('every tool the parity golden-set profiles name for the platform is published by the local config', async () => {
    const { app } = await boot();

    const res = await mcp(app, 'tools/list', {});
    const body = (await res.json()) as { result: { tools: { name: string }[] } };

    expect(body.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(parityTools()));
  });

  it.each(toolNames)('%s answers a tools/call without an error', async (name) => {
    const { app } = await boot();

    const res = await mcp(
      app,
      'tools/call',
      {
        name,
        arguments: {
          query: 'Hvordan publiserer jeg en app i Altinn Studio?',
          text: 'Digdir lanserte Altinn Studio i Oslo i 2024.',
          queries: ['publisere app', 'Altinn Studio'],
        },
      },
      name,
    );
    const body = (await res.json()) as {
      result?: { isError: boolean; content: { type: string; text?: string }[] };
      error?: unknown;
    };

    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
  });

  it('entity extraction answers with the entities as JSON', async () => {
    const { app } = await boot();
    const name = 'builtin-skills__entity-extraction';

    const res = await mcp(
      app,
      'tools/call',
      { name, arguments: { query: 'Digdir lanserte Altinn Studio i Oslo i 2024.' } },
      name,
    );
    const body = (await res.json()) as { result: { content: { type: string; text: string }[] } };
    const text = body.result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(JSON.parse(text)).toEqual({
      entities: [
        { text: 'Altinn Studio', type: 'Altinn Studio', confidence: 1, context: 'Altinn Studio' },
      ],
    });
  });

  it.each(['simple-qa__retrieve-and-rerank', 'builtin-skills__multi-retrieval'])(
    '%s returns sources without calling a model',
    async (name) => {
      const { app, model } = await boot();
      const before = model.seen.length;

      const res = await mcp(
        app,
        'tools/call',
        {
          name,
          arguments: { query: 'publisere app', queries: ['publisere app', 'Altinn Studio'] },
        },
        name,
      );
      const body = (await res.json()) as {
        result: { structuredContent: { chunks: unknown[] } };
      };

      expect(body.result.structuredContent.chunks.length).toBeGreaterThan(0);
      expect(model.seen.length).toBe(before);
    },
  );
});
