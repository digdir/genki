import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { createClient } from '@genai/client';
import { frontendContract } from '@genai/client/contract';
import { envSecrets, InMemoryEventLog } from '@genai/kernel';
import { runContract } from '@genai/plugins';
import {
  altinnPolicy,
  apiKeyDigest,
  configKeyGrant,
  createAuthenticator,
  createMockAltinnPdp,
  InMemoryApiKeys,
  InMemoryIdentities,
  overrideScope,
} from '@genai/identity';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import {
  evaluatorSystemPrompt,
  exhaustionNudge,
  readEvaluatorSystemPrompt,
} from '@genai/strategy-agent-loop';
import { resolveCatalog } from './catalogs.js';
import { Hono } from 'hono';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform, serviceRequirement } from './composition.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;

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
  return 'tildelingsbrev';
};

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const chunk = (id: string, index: number) => ({
  id,
  chunk_id: id,
  doc_num: 'd1',
  chunk_index: index,
  content_markdown: `Tildelingsbrevet for 2025 sier ${id}.`,
  content_length: 40,
  metadata: '{"Header 1" "Tildelingsbrev 2025"}',
  KUDOS_preprod_v4_documents_ab897fbdedfa: {
    title: 'Tildelingsbrev 2025',
    url: 'https://kudos.dfo.no/dokument/d1',
    total_chunks: 2,
    orgs_short: ['DIGDIR'],
  },
});

const typesenseReply = (body: Record<string, unknown>) => ({
  status: 200,
  json: {
    results: (body.searches as Record<string, unknown>[]).map((s) => {
      const collection = String(s.collection);
      if (s.facet_by) return { facet_counts: [], hits: [] };
      if (String(s.filter_by ?? '').includes('ZZZ')) return { found: 0, hits: [] };
      if (collection.includes('phrases'))
        return {
          found: 2,
          hits: ['c1', 'c2'].map((id, i) => ({
            document: { chunk_id: id, search_phrase: `tildelingsbrev ${id}`, doc_num: 'd1' },
            hybrid_search_info: { rank_fusion_score: 0.9 - i * 0.1 },
          })),
        };
      if (collection.includes('documents'))
        return {
          hits: [{ document: { doc_num: 'd1', title: 'Tildelingsbrev 2025', total_chunks: 2 } }],
        };
      return {
        found: 2,
        hits: ['c1', 'c2'].map((id, i) => ({
          document: chunk(id, i),
          text_match_info: { score: String(100 - i) },
        })),
      };
    }),
  },
});

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: '991825827',
  authorizedFor: [{ org: '991825827' }],
} as Principal;

interface Message {
  role: string;
  content?: string | null;
}

const section = (prompt: string, title: string) => {
  const start = prompt.indexOf(`${title}\n`);
  if (start < 0) return undefined;
  const rest = prompt.slice(start + title.length + 1);
  const end = rest.indexOf('\n\n');
  return end >= 0 ? rest.slice(0, end) : rest;
};

const allSupported = (prompt: string) => {
  const plan = JSON.parse(section(prompt, 'Evidence plan JSON:') ?? '{"required_claims":[]}') as {
    required_claims: { claim_id: string }[];
  };
  const read = JSON.parse(section(prompt, 'Newly read chunks JSON:') ?? '[]') as {
    chunk_id: string;
  }[];
  return JSON.stringify({
    status: 'support-found',
    scope_assessment: 'aligned',
    supported_claims: plan.required_claims.map((c) => ({
      claim_id: c.claim_id,
      support: 'explicit',
      chunk_ids: read.map((x) => x.chunk_id),
    })),
    remaining_gaps: [],
    contradictions: [],
    next_action_hint: 'finalize',
    confidence: 0.9,
  });
};

const toolCall = (name: string, args: unknown) => ({
  ...completion(''),
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});

const answer = 'Tildelingsbrevet for 2025 sier dette [1].';

const modelReply = (body: Record<string, unknown>) => {
  if (!body.messages)
    return {
      status: 200,
      json: {
        data: [
          { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
          { id: 'gpt-5-mini', model: 'gpt-5-mini', status: 'succeeded' },
          { id: 'text-embedding-3-small', model: 'text-embedding-3-small', status: 'succeeded' },
        ],
      },
    };
  const messages = body.messages as Message[];
  const system = messages[0]?.content ?? '';
  const format = body.response_format as { json_schema?: { schema: Schema } } | undefined;
  const text = (content: string) =>
    body.stream
      ? {
          status: 200,
          sse: [
            {
              data: {
                id: 'c',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'gpt-test',
                choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
              },
            },
            {
              data: {
                id: 'c',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'gpt-test',
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              },
            },
            { data: '[DONE]' },
          ],
        }
      : { status: 200, json: completion(content) };
  const tool = (name: string, args: unknown) =>
    body.stream
      ? {
          status: 200,
          sse: [
            {
              data: {
                id: 'c',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'gpt-test',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${name}`,
                          type: 'function',
                          function: { name, arguments: JSON.stringify(args) },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
            },
            { data: '[DONE]' },
          ],
        }
      : { status: 200, json: toolCall(name, args) };
  if (body.tools) {
    const toolTurns = messages.filter((m) => m.role === 'tool').length;
    if (toolTurns === 0) return tool('search', { queries: ['tildelingsbrev Digdir 2025'] });
    if (toolTurns === 1) return tool('read_chunks', { chunk_ids: ['c1', 'c2'] });
    return text(answer);
  }
  if (system === readEvaluatorSystemPrompt) return text(allSupported(messages[1]?.content ?? ''));
  if (system === evaluatorSystemPrompt)
    return text(
      JSON.stringify({
        status: 'sufficient',
        reasoning: 'covered',
        missing_info: [],
        contradiction_detected: false,
        suggested_strategy: 'finalize',
      }),
    );
  if (messages.at(-1)?.content === exhaustionNudge) return text(answer);
  if (format?.json_schema) return text(JSON.stringify(sample(format.json_schema.schema)));
  return text(answer);
};

const boot = async (
  access?: Partial<Pick<Parameters<typeof createPlatform>[0], 'policy' | 'authenticate'>>,
  extra: {
    knowledge?: unknown;
    settings?: SettingsRegistry;
    prices?: Parameters<typeof createPlatform>[0]['prices'];
    log?: InMemoryEventLog;
  } = {},
) => {
  const model = await fakeHttp(modelReply);
  const search = await fakeHttp(typesenseReply);
  const colbert = await fakeHttp((body) => ({
    status: 200,
    json: (body.documents as unknown[]).map((_, i) => ({
      index: i,
      score: 1 - i * 0.1,
      rank: i + 1,
    })),
  }));
  servers.push(model, search, colbert);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: colbert.url,
  };
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog,
      knowledge: resolveCatalog(extra.knowledge ?? yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    ...(extra.settings ? { settings: extra.settings } : {}),
    ...(extra.prices ? { prices: extra.prices } : {}),
    ...(extra.log ? { log: extra.log } : {}),
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: access?.policy ?? { decide: async () => ({ allow: true }) },
    authenticate:
      access?.authenticate ??
      (async (request) =>
        request.headers.get('authorization') === 'Bearer kari'
          ? { principal: kari }
          : request.headers.get('authorization') === 'Bearer operator'
            ? { principal: { kind: 'operator', issuer: 'test', subject: 'ops' } as Principal }
            : undefined),
  });
  const callerOf = async (request: Request) =>
    (access?.authenticate ? await access.authenticate(request) : undefined)?.principal ??
    (request.headers.get('authorization') === 'Bearer kari'
      ? kari
      : request.headers.get('authorization') === 'Bearer operator'
        ? ({ kind: 'operator', issuer: 'test', subject: 'ops' } as Principal)
        : undefined);
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      auth: { authenticate: callerOf },
      models: platform.models,
    },
  });
  platform.mount(app);
  return { platform, app, model, search, colbert };
};

const mcp = (
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  method: string,
  params: Record<string, unknown>,
) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer kari',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('the composed platform', () => {
  it('serves a service published after boot under its public MCP tool name, end to end', async () => {
    const { platform, app, search, colbert } = await boot();

    const published = await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );
    expect(published.ok).toBe(true);

    const res = await mcp(app, 'tools/call', {
      name: 'kunnskapsassistenten-retrieve-only__default',
      arguments: { query: 'Hva står i tildelingsbrevet til Digdir for 2025?' },
    });
    const body = (await res.json()) as {
      result: {
        isError: boolean;
        content: { type: string; uri?: string }[];
        structuredContent: { chunks: { chunk_id: string }[] };
      };
    };

    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.chunks.map((c) => c.chunk_id)).toEqual(
      expect.arrayContaining(['c1']),
    );
    expect(body.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'resource_link', uri: 'https://kudos.dfo.no/dokument/d1' }),
      ]),
    );
    expect(search.seen.every((r) => r.path === '/multi_search')).toBe(true);
    expect(colbert.seen.length).toBeGreaterThan(0);
  });

  it("applies KA's retrieve-filter-by override to every chunk search, so a filter matching nothing returns no chunks", async () => {
    const { platform, app, search } = await boot();
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );
    const impossible = {
      fields: [{ field: 'type', 'selected-options': ['ZZZ_ingen_slik_type'] }],
    };

    const res = await mcp(app, 'tools/call', {
      name: 'kunnskapsassistenten-retrieve-only__default',
      arguments: { query: 'tiltak og resultater', overrides: { 'retrieve-filter-by': impossible } },
    });
    const body = (await res.json()) as {
      result: { isError: boolean; structuredContent: Record<string, unknown> };
    };

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.chunks).toBeUndefined();
    const searches = search.seen.flatMap(
      (r) => (r.body as { searches?: Record<string, unknown>[] }).searches ?? [],
    );
    const chunkSearches = searches.filter(
      (s) => String(s.collection).includes('chunks') && s.q !== '*',
    );
    expect(chunkSearches.length).toBeGreaterThan(0);
    for (const s of chunkSearches)
      expect(String(s.filter_by)).toContain('type:=[`ZZZ_ingen_slik_type`]');
    expect(body.result.structuredContent.filters_applied).toEqual([
      {
        filter: {
          fields: [
            {
              type: 'multiselect',
              field: 'type',
              'selected-options': ['ZZZ_ingen_slik_type'],
              'value-type': 'string',
            },
          ],
        },
        source: 'explicit',
      },
    ]);
  });

  it('applies a variant fixed filter to every chunk search, and lets a caller narrow it but not widen it', async () => {
    const { platform, app, search } = await boot();
    const service = yaml('services/kunnskapsassistenten-retrieve-only.yaml') as {
      metadata: Record<string, unknown>;
      spec: Record<string, unknown>;
    };
    const fixed = { fields: [{ field: 'type', 'selected-options': ['ZZZ_fast_type'] }] };
    const published = await platform.definitions.publish(
      {
        ...service,
        metadata: { ...service.metadata, id: 'kudos-fixed-filter' },
        spec: { ...service.spec, variants: [{ id: 'default', filters: fixed }] },
      },
      'test',
      'test',
    );
    expect(published.ok).toBe(true);
    const chunkFilters = async (overrides: Record<string, unknown>) => {
      search.seen.length = 0;
      const res = await mcp(app, 'tools/call', {
        name: 'kudos-fixed-filter__default',
        arguments: { query: 'tiltak og resultater', overrides },
      });
      expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
      const searches = search.seen.flatMap(
        (r) => (r.body as { searches?: Record<string, unknown>[] }).searches ?? [],
      );
      const chunks = searches.filter((s) => String(s.collection).includes('chunks') && s.q !== '*');
      expect(chunks.length).toBeGreaterThan(0);
      return chunks.map((s) => String(s.filter_by));
    };

    for (const f of await chunkFilters({})) expect(f).toContain('type:=[`ZZZ_fast_type`]');
    const caller = (field: string, value: string) => ({
      'retrieve-filter-by': { fields: [{ field, 'selected-options': [value] }] },
    });
    for (const f of await chunkFilters(caller('orgs_short', 'DIGDIR'))) {
      expect(f).toContain('type:=[`ZZZ_fast_type`]');
      expect(f).toContain('orgs_short:=[`DIGDIR`]');
    }
    for (const f of await chunkFilters(caller('type', 'Tildelingsbrev'))) {
      expect(f).toContain('type:=[`ZZZ_fast_type`]');
      expect(f).toContain('type:=[`Tildelingsbrev`]');
    }
  });

  it('refuses at publish a variant filter on a field none of its datasets declares', async () => {
    const { platform } = await boot();
    const service = yaml('services/kunnskapsassistenten-retrieve-only.yaml') as {
      metadata: Record<string, unknown>;
      spec: Record<string, unknown>;
    };
    const publish = (id: string, field: string) =>
      platform.definitions.publish(
        {
          ...service,
          metadata: { ...service.metadata, id },
          spec: {
            ...service.spec,
            variants: [
              { id: 'default', filters: { fields: [{ field, 'selected-options': ['x'] }] } },
            ],
          },
        },
        'test',
        'test',
      );

    const refused = await publish('kudos-undeclared-filter', 'produkt');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.errors).toEqual([
      {
        path: 'spec.variants[0].filters.fields[0].field',
        message: 'no dataset of this service declares the filter field produkt',
      },
    ]);
    expect((await publish('kudos-declared-filter', 'orgs_short')).ok).toBe(true);
  });

  it("streams the agent's steps and answer to KA as progress frames before the result", async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const res = await mcp(app, 'tools/call', {
      name: 'kunnskapsassistenten__default',
      arguments: { query: 'Hva står i tildelingsbrevet til Digdir for 2025?' },
      _meta: { progressToken: 'ka-1' },
    });
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
    const events = frames.flatMap((f) => {
      const meta = (f.params as { _meta?: { event?: string } } | undefined)?._meta;
      return meta?.event ? [meta.event] : [];
    });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events).toEqual(
      expect.arrayContaining([
        'request/started',
        'agent/iteration-started',
        'agent/turn-completed',
        'response/chunk',
        'agent/finalized',
      ]),
    );
    expect(events.indexOf('agent/iteration-started')).toBeLessThan(
      events.indexOf('response/chunk'),
    );
    expect(JSON.stringify(frames)).toContain('"queries":["tildelingsbrev Digdir 2025"]');
    expect(frames.at(-1)).toHaveProperty('result');
  });

  it('runs the full agent under its public MCP tool name: search, read, answer with a cited source', async () => {
    const { platform, app, model } = await boot();
    const published = await platform.definitions.publish(
      yaml('services/kunnskapsassistenten.yaml'),
      'test',
      'test',
    );
    expect(published.ok).toBe(true);

    const res = await mcp(app, 'tools/call', {
      name: 'kunnskapsassistenten__default',
      arguments: { query: 'Hva står i tildelingsbrevet til Digdir for 2025?' },
    });
    const body = (await res.json()) as {
      result: { isError: boolean; content: { type: string; text?: string; uri?: string }[] };
    };

    expect(body.result.isError).toBe(false);
    expect(body.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('[1]') }),
        expect.objectContaining({ type: 'resource_link', uri: 'https://kudos.dfo.no/dokument/d1' }),
      ]),
    );
    const turns = model.seen.filter((r) => Array.isArray(r.body.tools));
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it("serves KA's datasets and facets over REST from the knowledge catalog", async () => {
    const { app, search } = await boot();

    const datasets = await app.request('/api/datasets', {
      headers: { authorization: 'Bearer kari' },
    });
    const facets = await app.request(
      `/api/facets?${new URLSearchParams({ tenant: 'digdir', 'dataset-config-key': 'kudos', fields: 'orgs_short' })}`,
      { headers: { authorization: 'Bearer kari' } },
    );

    expect(datasets.status).toBe(200);
    expect(JSON.stringify(await datasets.json())).toContain('"id":"kudos"');
    expect(facets.status).toBe(200);
    expect(search.seen.every((r) => r.path === '/multi_search')).toBe(true);
  });

  it('serves a frontend on a service key: dataset fields, facets, and an ask with filters and per-document sources', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({
      id: 'frontend',
      name: 'frontend',
      digest: apiKeyDigest('frontend-key'),
      tenant: '991825827',
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'kunnskapsassistenten',
    });
    const authenticator = createAuthenticator({ apiKeys: keys });
    const { app, platform } = await boot({
      authenticate: async (request) => {
        const found = await authenticator.authenticate(request);
        return found && callerFrom(found);
      },
    });
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const call = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-api-key': 'frontend-key', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ask = (filters: unknown) =>
      call('/v1/chat/completions', {
        model: 'kunnskapsassistenten__default',
        messages: [{ role: 'user', content: 'Hva står i tildelingsbrevet til Digdir for 2025?' }],
        filters,
      });

    const dataset = (await (await call('/api/datasets/kudos')).json()) as {
      dataset: { filters: { field: string }[] };
    };
    const facets = await call(
      `/api/facets?${new URLSearchParams({ tenant: 'digdir', 'dataset-config-key': 'kudos', fields: 'orgs_short' })}`,
    );
    const refused = await ask({ fields: [{ field: 'nope', 'selected-options': ['x'] }] });
    const answered = await ask({
      fields: [{ field: 'orgs_short', 'selected-options': ['DIGDIR'] }],
    });
    const body = (await answered.json()) as {
      choices: { message: { content: string } }[];
      sources: { index: number; document_id: string; excerpts: { chunk_id: string }[] }[];
    };

    expect(dataset.dataset.filters.map((f) => f.field)).toContain('orgs_short');
    expect(facets.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_filters' } });
    expect(answered.status).toBe(200);
    expect(body.sources[0]).toMatchObject({ index: 1, document_id: 'd1' });
    expect(body.sources[0]?.excerpts.length).toBeGreaterThan(0);
  });

  it('limits a service key to the datasets of its service', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({
      id: 'frontend',
      name: 'frontend',
      digest: apiKeyDigest('frontend-key'),
      tenant: '991825827',
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'kunnskapsassistenten',
    });
    const authenticator = createAuthenticator({ apiKeys: keys });
    const { app, platform } = await boot({
      authenticate: async (request) => {
        const found = await authenticator.authenticate(request);
        return found && callerFrom(found);
      },
    });
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const call = (path: string) => app.request(path, { headers: { 'x-api-key': 'frontend-key' } });
    const facets = (key: string) =>
      call(
        `/api/facets?${new URLSearchParams({ tenant: 'digdir', 'dataset-config-key': key, fields: 'orgs_short' })}`,
      );

    const listed = JSON.stringify(await (await call('/api/datasets')).json());
    const own = await call('/api/datasets/kudos');
    const other = await call('/api/datasets/public-docs');

    expect(listed).toContain('"id":"kudos"');
    expect(listed).not.toContain('"id":"public-docs"');
    expect(own.status).toBe(200);
    expect((await facets('kudos')).status).toBe(200);
    expect(other.status).toBe(404);
    expect((await facets('public-docs')).status).toBe(403);
  });

  it('names the datasets a service searches on /v1/models and in its schema, with owner tenant, dataset-config-key and filter value types', async () => {
    const { app, platform } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const get = async (path: string) =>
      (
        await app.request(path, { headers: { authorization: 'Bearer kari' } })
      ).json() as Promise<unknown>;

    const models = (await get('/v1/models')) as {
      data: { id: string; _datasets?: Record<string, unknown>[] }[];
    };
    const schema = (await get('/v1/models/kunnskapsassistenten__default/schema')) as {
      datasets?: unknown[];
    };
    const listed = models.data.find((m) => m.id === 'kunnskapsassistenten__default')?._datasets;

    expect(listed).toEqual([
      expect.objectContaining({ id: 'kudos', tenant: 'digdir', 'dataset-config-key': 'kudos' }),
    ]);
    expect(listed?.[0]?.filters).toEqual(
      expect.arrayContaining([
        { field: 'concerned_years', kinds: ['multiselect'], 'value-type': 'integer' },
        { field: 'orgs_short', kinds: ['multiselect'], 'value-type': 'string' },
      ]),
    );
    expect(schema.datasets).toEqual(listed);
  });

  it('returns the sources of a stored answer with their index, so [N] resolves in a reopened conversation', async () => {
    const { app, platform } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const call = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const asked = (await (
      await call('/v1/chat/completions', {
        model: 'kunnskapsassistenten__default',
        messages: [{ role: 'user', content: 'Hva står i tildelingsbrevet til Digdir for 2025?' }],
        genai_conversation: true,
      })
    ).json()) as { conversation_id: string; sources: { index?: number; title: string }[] };
    const reopened = (await (await call(`/api/conversations/${asked.conversation_id}`)).json()) as {
      messages: { role: string; sources?: { index?: number; title: string }[] }[];
    };
    const stored = reopened.messages.at(-1)?.sources;

    expect(asked.sources[0]?.index).toBe(1);
    expect(stored?.map((s) => [s.index, s.title])).toEqual(
      asked.sources.map((s) => [s.index, s.title]),
    );
  });

  it('passes the frontend contract suite as @genai/client sees it, on a key bound to the service', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({
      id: 'frontend',
      name: 'frontend',
      digest: apiKeyDigest('frontend-key'),
      tenant: '991825827',
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'kunnskapsassistenten',
    });
    const authenticator = createAuthenticator({ apiKeys: keys });
    const { app, platform } = await boot({
      authenticate: async (request) => {
        const found = await authenticator.authenticate(request);
        return found && callerFrom(found);
      },
    });
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const inProcess = ((url, init) => app.request(String(url), init)) as typeof fetch;
    const connect = (apiKey?: string) =>
      createClient({
        baseUrl: 'http://platform.test',
        ...(apiKey ? { apiKey, userId: 'ola' } : {}),
        fetch: inProcess,
      });

    const result = await runContract(
      frontendContract,
      async () => ({
        subject: {
          client: connect('frontend-key'),
          anonymous: connect(),
          service: 'kunnskapsassistenten__default',
          question: 'Hva står i tildelingsbrevet til Digdir for 2025?',
          dataset: { tenant: 'digdir', key: 'kudos', id: 'kudos', field: 'orgs_short' },
          filter: { fields: [{ field: 'orgs_short', 'selected-options': ['DIGDIR'] }] },
        },
      }),
      { timeoutMs: 30_000 },
    );

    expect(result.results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(result.results.filter((r) => r.status === 'skipped').map((r) => r.name)).toEqual([
      'records feedback on an answer through its task id',
    ]);
  });

  it("lists only the datasets a key's allowed dataset config keys name, as headless-rag did", async () => {
    const keys = new InMemoryApiKeys();
    for (const [id, configKey] of [
      ['kudos-key', 'kudos'],
      ['other-key', 'other'],
    ] as const)
      keys.add({
        id,
        name: id,
        digest: apiKeyDigest(id),
        tenant: '991825827',
        scopes: ['query'],
        datasets: ['*'],
        agents: ['*'],
        allowedConfigKeys: [configKeyGrant('dataset', configKey)],
      });
    const authenticator = createAuthenticator({ apiKeys: keys });
    const { app } = await boot({
      authenticate: async (request) => {
        const found = await authenticator.authenticate(request);
        return found && { principal: found.principal };
      },
    });
    const listed = async (key: string) =>
      JSON.stringify(
        await (await app.request('/api/datasets', { headers: { 'x-api-key': key } })).json(),
      );

    expect(await listed('kudos-key')).toContain('"id":"kudos"');
    expect(await listed('other-key')).not.toContain('"id":"kudos"');
  });

  it('lets an API key call a service through the real authenticator and Altinn policy', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({
      id: 'ka',
      name: 'KA',
      digest: apiKeyDigest('ka-test-key'),
      tenant: '991825827',
      scopes: ['query'],
      datasets: ['*'],
      agents: ['*'],
    });
    const authenticator = createAuthenticator({ apiKeys: keys });
    const resource = 'urn:altinn:resource:digdir-genai-platform';
    const { platform, app } = await boot({
      policy: altinnPolicy({
        altinn: createMockAltinnPdp({ persons: [], clients: [] }).authorization,
        identities: new InMemoryIdentities(),
        requirementFor: () => serviceRequirement(resource),
      }),
      authenticate: async (request) => {
        const found = await authenticator.authenticate(request);
        return found && { principal: found.principal };
      },
    });
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );

    const call = (key: string) =>
      app.request('/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'kunnskapsassistenten-retrieve-only__default',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'kunnskapsassistenten-retrieve-only__default',
            arguments: { query: 'tildelingsbrev 2025' },
          },
        }),
      });
    const allowed = (await (await call('ka-test-key')).json()) as { result: { isError: boolean } };
    const unknown = await call('not-a-key');

    expect(allowed.result.isError).toBe(false);
    expect(unknown.status).toBe(401);
  });

  it('offers discovered models for a dropdown, filtered by residency, and lets only operators classify them', async () => {
    const { app } = await boot();
    const as = (who: string) => ({ authorization: `Bearer ${who}` });
    const ids = async (query = '') =>
      (
        (await (await app.request(`/models${query}`, { headers: as('kari') })).json()) as {
          data: { id: string }[];
        }
      ).data.map((m) => m.id);

    expect(await ids()).toEqual(['foundry-openai/gpt-4o-2m-tps', 'foundry-openai/gpt-5-mini']);
    expect(await ids('?residency=norway')).toEqual([]);

    const refused = await app.request('/operator/models/foundry-openai/gpt-4o-2m-tps', {
      method: 'PATCH',
      headers: {
        ...as('kari'),
        'content-type': 'application/json',
        'change-reason': 'test av klassifisering',
      },
      body: JSON.stringify({ residency: 'norway' }),
    });
    const classified = await app.request('/operator/models/foundry-openai/gpt-4o-2m-tps', {
      method: 'PATCH',
      headers: {
        ...as('operator'),
        'content-type': 'application/json',
        'change-reason': 'test av klassifisering',
      },
      body: JSON.stringify({ residency: 'norway' }),
    });

    expect(refused.status).toBe(403);
    expect(classified.status).toBe(200);
    expect(await ids('?residency=norway')).toEqual(['foundry-openai/gpt-4o-2m-tps']);
    expect((await app.request('/models')).status).toBe(401);
  });

  it('shows the price per 1,000 tokens next to each model, or null when it has none', async () => {
    const price = { inputPerThousand: 0.0238, outputPerThousand: 0.0952 };
    const list = async (prices?: Record<string, typeof price>) => {
      const { app } = await boot(undefined, prices ? { prices } : {});
      const res = await app.request('/models', { headers: { authorization: 'Bearer kari' } });
      return ((await res.json()) as { data: { id: string; price: unknown }[] }).data;
    };

    expect(await list()).toEqual([
      expect.objectContaining({ price: null, name: expect.any(String) }),
      expect.objectContaining({ price: null, name: expect.any(String) }),
    ]);
    expect(await list({ 'foundry-openai/gpt-4o-2m-tps': price })).toEqual([
      expect.objectContaining({ id: 'foundry-openai/gpt-4o-2m-tps', price }),
      expect.objectContaining({ id: 'foundry-openai/gpt-5-mini', price: null }),
    ]);
  });

  it('presents KA under its service id and variant on MCP and /v1/models', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const name = 'kunnskapsassistenten__default';

    const listed = (await (await mcp(app, 'tools/list', {})).json()) as {
      result: {
        tools: {
          name: string;
          title: string;
          description: string;
          _meta: unknown;
          inputSchema: { properties: Record<string, unknown> };
        }[];
      };
    };
    const tool = listed.result.tools.find((t) => t.name === name);
    const models = (await (
      await app.request('/v1/models', { headers: { authorization: 'Bearer kari' } })
    ).json()) as {
      data: Record<string, unknown>[];
    };

    expect(tool).toMatchObject({
      title: 'Kunnskapsassistenten',
      _meta: {
        'agent-id': 'kunnskapsassistenten',
        mode: 'default',
        default: true,
      },
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['query', 'claim', 'conversation-history', 'model', 'temperature']),
    );
    expect(models.data.find((m) => m.id === name)).toMatchObject({
      _agent_id: 'kunnskapsassistenten',
      _mode: 'default',
      _default: true,
    });
  });

  it("creates a conversation for KA's service id and keeps that id", async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const created = await app.request('/api/conversations', {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'kunnskapsassistenten', title: 'Paritet' }),
    });

    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { conversation: { agentId: string } }).conversation.agentId,
    ).toBe('kunnskapsassistenten');
  });

  it('lists published services on /v1/models and refuses an anonymous caller', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );

    const listed = await app.request('/v1/models', { headers: { authorization: 'Bearer kari' } });
    const anonymous = await app.request('/v1/models');

    expect(((await listed.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(
      expect.arrayContaining(['kunnskapsassistenten-retrieve-only__default']),
    );
    expect(anonymous.status).toBe(401);
  });

  it('marks only the public name of services exposed for chat with _chat on /v1/models', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );

    const listed = (await (
      await app.request('/v1/models', { headers: { authorization: 'Bearer kari' } })
    ).json()) as { data: { id: string; _chat?: boolean }[] };
    const chat = listed.data.filter((m) => m._chat).map((m) => m.id);

    expect(chat).toEqual(['kunnskapsassistenten__default']);
  });

  it('lists a mode that gives no answer with _chat false, so a chat picker can leave it out', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const listed = (await (
      await app.request('/v1/models', { headers: { authorization: 'Bearer kari' } })
    ).json()) as { data: { id: string; _chat?: boolean }[] };

    expect(listed.data.find((m) => m.id === 'kunnskapsassistenten__retrieve-only')?._chat).toBe(
      false,
    );
    expect(listed.data.every((m) => typeof m._chat === 'boolean')).toBe(true);
  });

  it('names the service and the variant of every /v1/models row, so a frontend can group variants under their service', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const listed = (await (
      await app.request('/v1/models', {
        headers: { authorization: 'Bearer kari', 'accept-language': 'en' },
      })
    ).json()) as { data: Record<string, unknown>[] };
    const ka = listed.data.filter((m) => m._service === 'kunnskapsassistenten');

    expect(ka.map((m) => [m.id, m._variant, m._variant_title, m._service_title])).toEqual([
      ['kunnskapsassistenten__default', 'default', 'Answers with sources', 'Kunnskapsassistenten'],
      ['kunnskapsassistenten__mini', 'mini', 'Fast (GPT-5 mini)', 'Kunnskapsassistenten'],
      [
        'kunnskapsassistenten__retrieve-only',
        'retrieve-only',
        'Search only',
        'Kunnskapsassistenten',
      ],
    ]);
    expect(ka.every((m) => m._agent_id === m._service && m._mode === m._variant)).toBe(true);
  });

  it('marks as _pickable only the chat variants of a chat service, never a non-chat variant or an alias', async () => {
    const { platform, app } = await boot();
    const ka = yaml('services/kunnskapsassistenten.yaml') as { spec: { variants: unknown[] } };
    const [first, mini, search] = ka.spec.variants as Record<string, unknown>[];
    await platform.definitions.publish(
      { ...ka, spec: { ...ka.spec, variants: [first, { ...mini, aliases: ['ka-rask'] }, search] } },
      'test',
      'test',
    );

    const listed = (await (
      await app.request('/v1/models', { headers: { authorization: 'Bearer kari' } })
    ).json()) as { data: Record<string, unknown>[] };
    const pickable = listed.data
      .filter((m) => m._service === 'kunnskapsassistenten' && m._pickable)
      .map((m) => m.id);

    expect(pickable).toEqual(['kunnskapsassistenten__default', 'kunnskapsassistenten__mini']);
    expect(listed.data.find((m) => m.id === 'ka-rask')).toMatchObject({
      _alias_of: 'kunnskapsassistenten__mini',
      _pickable: false,
    });
    expect(listed.data.every((m) => typeof m._pickable === 'boolean')).toBe(true);
  });

  it('creates a conversation from a service id sent as service, the platform name for agent', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const created = await app.request('/api/conversations', {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'kunnskapsassistenten' }),
    });

    expect(created.status).toBe(201);
    expect(((await created.json()) as { conversation: unknown }).conversation).toMatchObject({
      agentId: 'kunnskapsassistenten',
      serviceId: 'kunnskapsassistenten',
    });
  });

  it('refuses at publish a service whose dataset, model or reranker is not configured', async () => {
    const platform = await createPlatform({
      catalogs: {
        models: resolveCatalog(yaml('models.yaml'), 'models', {}).catalog,
        knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', {}).catalog,
        rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', {}).catalog,
      },
      secrets: envSecrets({}),
      definitions: (plugins) => new InMemoryDefinitionStore(plugins),
      policy: { decide: async () => ({ allow: true }) },
      authenticate: async () => undefined,
    });

    const result = await platform.definitions.publish(
      yaml('services/kunnskapsassistenten.yaml'),
      'test',
      'test',
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      'spec.model.primary',
      'spec.variants[1].model',
      'spec.knowledge.datasets[0].dataset',
      'spec.knowledge.reranker',
    ]);
  });
});

describe('a draft test run', () => {
  const draft = {
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant: '991825827', id: 'utkast-svar', name: 'Utkast' },
    spec: {
      purpose: 'Svar kort på spørsmål',
      riskClass: 'minimal',
      input: { accepts: ['text/plain'] },
      output: { kind: 'answer' },
      strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
      model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
    },
  };
  const withAdmin = async () => {
    const { platform } = await boot();
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
    return { platform, app };
  };
  const run = (app: Hono, body: unknown) =>
    app.request('/tenants/991825827/definitions/test-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer kari' },
      body: JSON.stringify(body),
    });

  it('runs an unpublished service once and leaves nothing published or registered', async () => {
    const { platform, app } = await withAdmin();

    const res = await run(app, { definition: draft, query: 'Hva står i tildelingsbrevet?' });
    const body = (await res.json()) as { ok: boolean; task: string; answer: string };

    expect(res.status).toBe(200);
    expect(body.answer).toBe(answer);
    expect(body.task).toEqual(expect.any(String));
    expect(await platform.definitions.list('991825827')).toEqual([]);
    expect(platform.registry.all().some((c) => c.descriptor.id.startsWith('platform/draft/'))).toBe(
      false,
    );
  });

  it('answers 422 with schema errors for an invalid draft', async () => {
    const { app } = await withAdmin();

    const res = await run(app, {
      definition: { ...draft, spec: { ...draft.spec, riskClass: 'unknown' } },
      query: 'Hei',
    });

    expect(res.status).toBe(422);
  });

  it("refuses a draft that belongs to another tenant's services", async () => {
    const { app } = await withAdmin();

    const res = await run(app, {
      definition: { ...draft, metadata: { ...draft.metadata, tenant: '123456785' } },
      query: 'Hei',
    });

    expect(res.status).toBe(403);
  });
});

describe('settings and datasets at run time', () => {
  const twoDatasets = () => {
    const catalog = structuredClone(yaml('knowledge.yaml')) as {
      datasets: {
        id: string;
        aliases?: string[];
        options: { collections: Record<string, string> };
      }[];
    };
    const first = catalog.datasets[0];
    if (!first) throw new Error('no dataset in the catalog');
    const archive = structuredClone(first);
    archive.id = 'digdir/kudos-arkiv';
    archive.aliases = [];
    archive.options.collections = Object.fromEntries(
      Object.entries(first.options.collections).map(([k, v]) => [k, `${v}_arkiv`]),
    );
    catalog.datasets.push(archive);
    return catalog;
  };

  const retrieveOnly = (patch: { datasets?: string[]; settings?: Record<string, unknown> }) => {
    const service = structuredClone(yaml('services/kunnskapsassistenten-retrieve-only.yaml')) as {
      spec: { knowledge: { datasets: { dataset: string }[] }; settings?: unknown };
    };
    if (patch.datasets)
      service.spec.knowledge.datasets = patch.datasets.map((dataset) => ({ dataset }));
    if (patch.settings) service.spec.settings = patch.settings;
    return service;
  };

  const call = async (app: Hono, who: string, overrides?: Record<string, unknown>) => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${who}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'kunnskapsassistenten-retrieve-only__default',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'kunnskapsassistenten-retrieve-only__default',
          arguments: { query: 'tildelingsbrev 2025', ...(overrides ? { overrides } : {}) },
        },
      }),
    });
    return (await res.json()) as {
      result?: { isError: boolean; structuredContent: { chunks?: { chunk_id: string }[] } };
      error?: { message: string; data?: { code?: string } };
    };
  };

  it('searches every dataset on a service and merges the hits', async () => {
    const { platform, app, search } = await boot(undefined, { knowledge: twoDatasets() });
    const published = await platform.definitions.publish(
      retrieveOnly({ datasets: ['digdir/kudos', 'digdir/kudos-arkiv'] }),
      'test',
      'test',
    );
    expect(published.ok).toBe(true);

    const body = await call(app as unknown as Hono, 'kari');

    const collections = new Set(
      search.seen.flatMap((r) =>
        ((r.body as { searches?: { collection: string }[] }).searches ?? []).map(
          (s) => s.collection,
        ),
      ),
    );
    expect(collections).toContain('KUDOS_preprod_v4_chunks_ab897fbdedfa');
    expect(collections).toContain('KUDOS_preprod_v4_chunks_ab897fbdedfa_arkiv');
    const ids = body.result?.structuredContent.chunks?.map((c) => c.chunk_id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['digdir/kudos::c1', 'digdir/kudos-arkiv::c1']));
  });

  it('applies platform default, tenant, service and call values in that order', async () => {
    const settings = new SettingsRegistry(platformSettings);
    const withKey: Principal = { ...kari, scopes: [overrideScope('rag.*')] };
    const { platform, app } = await boot(
      {
        policy: { decide: async () => ({ allow: true }) },
        authenticate: async (request) => {
          const bearer = request.headers.get('authorization');
          return bearer === 'Bearer kari'
            ? { principal: kari }
            : bearer === 'Bearer kari-key'
              ? { principal: withKey }
              : undefined;
        },
      },
      { settings },
    );
    await platform.definitions.publish(retrieveOnly({}), 'test', 'test');
    const count = async (who = 'kari', overrides?: Record<string, unknown>) =>
      (await call(app as unknown as Hono, who, overrides)).result?.structuredContent.chunks
        ?.length ?? 0;

    settings.setDefault('rag.topK', 2, 'drift', 'test');
    expect(await count()).toBe(2);
    settings.setTenant('991825827', 'rag.topK', 1);
    expect(await count()).toBe(1);
    await platform.definitions.publish(
      retrieveOnly({ settings: { 'rag.topK': 2 } }),
      'test',
      'test',
    );
    expect(await count()).toBe(2);
    expect(await count('kari-key', { 'rag.topK': 1 })).toBe(1);
  });

  it("refuses a per-call override that is not on the caller's allowlist", async () => {
    const { platform, app } = await boot(undefined, {
      settings: new SettingsRegistry(platformSettings),
    });
    await platform.definitions.publish(retrieveOnly({}), 'test', 'test');

    const body = await call(app as unknown as Hono, 'kari', { 'rag.topK': 1 });

    expect(body.error?.data?.code).toBe('invalid_overrides');
    expect(body.error?.message).toContain('rag.topK is not in the credential');
    const alias = await call(app as unknown as Hono, 'kari', { 'retrieve-top-k': 5 });
    expect(alias.error?.data?.code).toBe('invalid_overrides');
    expect(alias.error?.message).toContain(
      'retrieve-top-k (retrieval.retrieveTopK) is not in the credential',
    );
  });

  const tenantSettable = (d: (typeof platformSettings)[number]) =>
    d.settableAt.includes('tenant') && d.default !== null;

  const everyEntryPoint = async (
    service: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    const settings = new SettingsRegistry(platformSettings);
    for (const d of platformSettings)
      if (tenantSettable(d)) settings.setTenant('991825827', d.key, d.default);
    const applied: unknown[] = [];
    const log = new (class extends InMemoryEventLog {
      override async append(event: Parameters<InMemoryEventLog['append']>[0]) {
        if (event.type === 'x.settings.applied') applied.push(event.data);
        return super.append(event);
      }
    })();
    const withKey: Principal = { ...kari, scopes: [overrideScope('retrieval.*')] };
    const { platform, app } = await boot(
      {
        policy: { decide: async () => ({ allow: true }) },
        authenticate: async (request) =>
          request.headers.get('authorization') === 'Bearer kari-key'
            ? { principal: withKey }
            : undefined,
      },
      { settings, log },
    );
    await platform.definitions.publish(service, 'test', 'test');
    const name = 'kunnskapsassistenten-retrieve-only__default';
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      (app as unknown as Hono).request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer kari-key',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const query = 'tildelingsbrev 2025';
    const responses = {
      mcp: await post(
        '/api/mcp',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { query, overrides } },
        },
        { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
      ),
      openai: await post('/v1/chat/completions', {
        model: name,
        messages: [{ role: 'user', content: query }],
        overrides,
      }),
      rest: await post(`/api/tools/call/${name}`, { query, overrides }),
      a2a: await post(`/a2a/${name}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'm1',
            role: 'ROLE_USER',
            parts: [{ text: query }, { data: { overrides } }],
          },
        },
      }),
    };
    return { applied, responses };
  };

  it('resolves every tenant setting with a default the same way on MCP, /v1, REST and A2A, so none is read on only some entry points', async () => {
    const service = retrieveOnly({});
    (service.spec as Record<string, unknown>).exposure = {
      mcp: true,
      openai: true,
      rest: true,
      a2a: true,
    };
    const { applied, responses } = await everyEntryPoint(service, {
      'retrieval.retrieveTopK': 7,
    });

    expect(Object.values(responses).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(applied).toHaveLength(4);
    const [first, ...rest] = applied as { effective: Record<string, unknown> }[];
    const tenantSettings = platformSettings.filter(tenantSettable);
    expect(Object.keys(first?.effective ?? {}).sort()).toEqual(
      tenantSettings.map((d) => d.key).sort(),
    );
    expect(first?.effective['retrieval.retrieveTopK']).toEqual({ value: 7, source: 'call' });
    for (const other of rest) expect(other).toEqual(first);
  });

  it('refuses on /v1 a call override the service allows only on MCP', async () => {
    const service = retrieveOnly({});
    (service.spec as Record<string, unknown>).callOverrides = {
      mcp: ['retrieval.retrieveTopK'],
      openai: [],
    };
    const { applied, responses } = await everyEntryPoint(service, {
      'retrieval.retrieveTopK': 7,
    });

    expect(responses.mcp.status).toBe(200);
    expect(responses.openai.status).toBe(400);
    expect(await responses.openai.json()).toMatchObject({
      error: {
        code: 'invalid_overrides',
        message: expect.stringContaining(
          'retrieval.retrieveTopK cannot be overridden on openai for this service',
        ),
      },
    });
    expect(responses.rest.status).toBe(200);
    expect(applied).toHaveLength(2);
  });
});

describe('the OpenAI-compatible /v1 surface', () => {
  const chat = (app: Hono, body: Record<string, unknown>) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Dialogporten' }], ...body }),
    });

  it('runs a service for a tenant and dataset_config_key it uses, and refuses another with dataset_not_authorized', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );
    const model = 'kunnskapsassistenten-retrieve-only__default';

    const alias = await chat(app as unknown as Hono, {
      model,
      tenant: 'public-sector-knowledge',
      dataset_config_key: 'default',
    });
    const canonical = await chat(app as unknown as Hono, {
      model,
      tenant: 'digdir',
      dataset_config_key: 'kudos',
    });
    const other = await chat(app as unknown as Hono, {
      model,
      tenant: 'nav',
      dataset_config_key: 'default',
    });

    expect([alias.status, canonical.status]).toEqual([200, 200]);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: 'dataset_not_authorized' } });
  });

  it('answers mode_not_authorized when the caller reaches the agent through another mode only', async () => {
    const { platform, app } = await boot({
      policy: {
        decide: async (_principal, _action, ref) =>
          ref.kind === 'capability' && ref.id.includes('faithful')
            ? { allow: false, reason: 'mode not granted' }
            : { allow: true },
      },
    });
    const published = await platform.definitions.publish(
      {
        apiVersion: 'genai/v1',
        kind: 'Service',
        metadata: { tenant: '991825827', id: 'demo-agent', name: 'Demo' },
        spec: {
          purpose: 'Svar kort',
          riskClass: 'minimal',
          variants: [{ id: 'faithful' }, { id: 'bundled' }],
          input: { accepts: ['text/plain'] },
          output: { kind: 'answer' },
          strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
          model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
          exposure: { openai: true },
        },
      },
      'test',
      'test',
    );

    const refused = await chat(app as unknown as Hono, { model: 'demo-agent__faithful' });
    const unknownAgent = await chat(app as unknown as Hono, { model: 'nobody__faithful' });

    expect(published.ok).toBe(true);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'mode_not_authorized' } });
    expect(unknownAgent.status).toBe(404);
  });
});

describe('MCP conversations, scope and wire metadata', () => {
  const KA = 'kunnskapsassistenten__default';
  type ToolResult = {
    result: {
      isError: boolean;
      content: { text?: string }[];
      structuredContent: { conversation_id: string; chunks?: unknown[] };
      _meta: Record<string, unknown>;
    };
  };
  const ask = async (app: Hono, args: Record<string, unknown>) =>
    (await (await mcp(app, 'tools/call', { name: KA, arguments: args })).json()) as ToolResult;
  const conversation = async (app: Hono, id: string) =>
    (await (
      await app.request(`/api/conversations/${id}`, { headers: { authorization: 'Bearer kari' } })
    ).json()) as {
      messages: { role: string | null; text: string; chunks: { chunkId: string }[] }[];
    };

  it('continues a REST-created conversation over MCP: the second call sees the first turn and GET returns every turn', async () => {
    const { platform, app, model } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');
    const created = await app.request('/api/conversations', {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'kunnskapsassistenten' }),
    });
    const id = ((await created.json()) as { conversation: { id: string } }).conversation.id;

    const first = await ask(app as unknown as Hono, {
      query: 'Hva står i tildelingsbrevet til Digdir for 2025?',
      conversation_id: id,
    });
    const before = model.seen.length;
    const second = await ask(app as unknown as Hono, {
      query: 'Hvilke av dem er fra 2023?',
      conversation_id: id,
    });

    expect([first.result.isError, second.result.isError]).toEqual([false, false]);
    expect(second.result.structuredContent.conversation_id).toBe(id);
    const firstTurn = model.seen.slice(before).find((r) => Array.isArray(r.body.tools))?.body
      .messages as Message[];
    expect(firstTurn.map((m) => [m.role, m.content]).slice(1, 4)).toEqual([
      ['user', 'Hva står i tildelingsbrevet til Digdir for 2025?'],
      ['assistant', first.result.content[0]?.text],
      ['user', 'Hvilke av dem er fra 2023?'],
    ]);
    const { messages } = await conversation(app as unknown as Hono, id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[1]?.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
  });

  it('creates a conversation for an MCP call without conversation_id and returns its id', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const body = await ask(app as unknown as Hono, { query: 'Hva er Dialogporten?' });
    const id = body.result.structuredContent.conversation_id;

    expect(body.result._meta.conversation_id).toBe(id);
    const { messages } = await conversation(app as unknown as Hono, id);
    expect(messages.map((m) => [m.role, m.text]).slice(0, 1)).toEqual([
      ['user', 'Hva er Dialogporten?'],
    ]);
    expect(messages.at(-1)?.role).toBe('assistant');
  });

  it('refuses an MCP conversation_id the caller does not own with conversation_not_found', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const body = await ask(app as unknown as Hono, { query: 'x', conversation_id: 'nobody' });

    expect(body.result).toMatchObject({
      isError: true,
      _meta: { code: 'conversation_not_found' },
    });
  });

  it('publishes insufficient and execution_metadata in _meta of an MCP answer', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(yaml('services/kunnskapsassistenten.yaml'), 'test', 'test');

    const body = await ask(app as unknown as Hono, { query: 'Hva står i tildelingsbrevet?' });

    expect(body.result._meta.insufficient).toBe(false);
    expect(body.result._meta.execution_metadata).toMatchObject({
      'steps-executed': 3,
      'stage-timings': [
        { 'step-id': 'setup' },
        { 'step-id': 'react', 'loop?': true },
        { 'step-id': 'finalize' },
      ],
    });
  });

  it('accepts an MCP tenant and dataset_config_key the service uses and refuses another with dataset_not_authorized', async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );
    const call = async (tenant: string, key: string) =>
      (await (
        await mcp(app, 'tools/call', {
          name: 'kunnskapsassistenten-retrieve-only__default',
          arguments: { query: 'tiltak', tenant, dataset_config_key: key },
        })
      ).json()) as ToolResult;

    const alias = await call('public-sector-knowledge', 'default');
    const other = await call('nav', 'default');

    expect(alias.result.isError).toBe(false);
    expect(other.result).toMatchObject({
      isError: true,
      content: [
        {
          text: 'Agent kunnskapsassistenten-retrieve-only is not allowed to access the requested dataset: nav/default',
        },
      ],
      _meta: { code: 'dataset_not_authorized' },
    });
  });

  it("satisfies unmodified KA's capability probe, which counts chunks with a regex over the raw JSON", async () => {
    const { platform, app } = await boot();
    await platform.definitions.publish(
      yaml('services/kunnskapsassistenten-retrieve-only.yaml'),
      'test',
      'test',
    );
    const countChunks = (text: string) => {
      let most = 0;
      for (const m of text.matchAll(/"chunks":\s*(\[[\s\S]*?\])\s*(?:,\s*"queries"|\})/g)) {
        try {
          most = Math.max(most, (JSON.parse(m[1] ?? '[]') as unknown[]).length);
        } catch {
          continue;
        }
      }
      return most;
    };
    const probe = async (filterBy?: unknown) =>
      countChunks(
        await (
          await mcp(app, 'tools/call', {
            name: 'kunnskapsassistenten-retrieve-only__default',
            arguments: {
              query: 'tiltak og resultater',
              tenant: 'public-sector-knowledge',
              dataset_config_key: 'default',
              ...(filterBy ? { overrides: { 'retrieve-filter-by': filterBy } } : {}),
            },
          })
        ).text(),
      );

    const baseline = await probe();
    const filtered = await probe({
      fields: [{ field: 'type', 'selected-options': ['ZZZ_ingen_slik_type'] }],
    });

    expect(baseline).toBeGreaterThan(0);
    expect(filtered).toBe(0);
  });
});
