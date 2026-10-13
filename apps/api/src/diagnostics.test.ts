import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Event, Principal, Task } from '@genai/contracts';
import { platformSettings, SettingsRegistry, type CompiledCapability } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { fixtureFilters, memoryEngine, seedCorpus } from '@genai/port-knowledge/testing';
import type { ModelPort } from '@genai/port-model';
import { tenantAccess } from './access.js';
import { mountDiagnostics } from './diagnostics.js';

const tenant = '991825827';
const other = '889640782';
const signal = new AbortController().signal;

const people: Record<string, Principal> = {
  operator: { kind: 'operator', issuer: 'test', subject: 'drift' },
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
};

const compiled = (
  owner: string,
  id: string,
  knowledge: Record<string, unknown>,
  strategy: Record<string, unknown> = {},
): CompiledCapability =>
  ({
    capability: {
      descriptor: { id: `${owner}/${id}/default` },
      strategy: { id: 'agent-loop', version: '1' },
      config: {
        strategy,
        settings: {},
        model: { primary: 'test/model', tenant: owner },
        knowledge,
      },
      grants: [],
    },
    service: { tenant: owner, id, version: 3 },
    variant: 'default',
    publicName: `${owner}/${id}`,
    aliases: [],
  }) as unknown as CompiledCapability;

const noticeEvent = (seq: number, data: Record<string, unknown>): Event => ({
  type: 'kernel.notice',
  v: 1,
  task: 't1',
  seq,
  ts: '2026-10-09T10:00:00Z',
  data,
  actor: { kind: 'strategy', id: 'agent-loop' } as Event['actor'],
});

const boot = async () => {
  const engine = memoryEngine();
  const knowledge = new KnowledgeRouter({
    catalog: {
      endpoints: { local: { engine: 'memory' } },
      datasets: [
        { id: 'digdir/felles', endpoint: 'local', residency: 'norway', filters: fixtureFilters },
        {
          id: `${other}/hemmelig`,
          endpoint: 'local',
          residency: 'norway',
          filters: fixtureFilters,
          tenants: [other],
        },
      ],
    },
    adapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
  for (const id of ['digdir/felles', `${other}/hemmelig`])
    await seedCorpus(writer, { id, filters: fixtureFilters, options: {} } as never);
  const modelCalls: string[] = [];
  const model = {
    info: () => ({ id: 'test/model' }),
    chat: async () => {
      modelCalls.push('chat');
      return {
        content: JSON.stringify({ phrases: ['tilskudd frist'], user_intent: 'frist for tilskudd' }),
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        servedModel: 'test/model',
      };
    },
  } as unknown as ModelPort;
  const tasks: Record<string, Task> = {
    t1: {
      id: 't1',
      tenant,
      service: { capability: { id: `${tenant}/svar/default`, version: '3' } },
    } as Task,
    t2: {
      id: 't2',
      tenant: other,
      service: { capability: { id: `${other}/svar/default`, version: '1' } },
    } as Task,
  };
  const events: Event[] = [
    noticeEvent(1, {
      kind: 'retrieval',
      queries: ['tilskudd'],
      hits: [
        { id: 'a', document: 'd1', position: 0 },
        { id: 'b', document: 'd1', position: 1 },
        { id: 'c', document: 'd2', position: 0 },
      ],
    }),
    noticeEvent(2, {
      kind: 'read',
      chunks: [{ id: 'a', document: 'd1', position: 0 }],
      auto: true,
    }),
    noticeEvent(3, {
      kind: 'retrieval',
      queries: ['frist'],
      hits: [
        { id: 'd', document: 'd3', position: 2 },
        { id: 'a', document: 'd1', position: 0 },
        { id: 'e', document: 'd4', position: 0 },
      ],
    }),
    noticeEvent(4, { kind: 'read', chunks: [{ id: 'e', document: 'd4', position: 0 }] }),
  ];
  const app = new Hono();
  mountDiagnostics(app, {
    definitions: {
      capabilities: async () => [
        compiled(
          tenant,
          'svar',
          {
            datasets: [{ dataset: 'digdir/felles' }],
            retrieval: { maxPerDocument: 2, autoFilter: { enabled: false } },
          },
          { search: { displayLimit: 2 } },
        ),
        compiled(other, 'hemmelig-svar', { datasets: [{ dataset: `${other}/hemmelig` }] }),
      ],
    },
    settings: new SettingsRegistry(platformSettings),
    knowledge,
    models: { open: () => model },
    task: async (id) => tasks[id],
    events: async function* (id) {
      if (id === 't1') yield* events;
    },
    authenticate: async (request) =>
      people[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''],
    access: tenantAccess({
      supportSession: (id, _operator, t) => (id === `sesjon-${t}` ? ({ id } as never) : undefined),
    }),
  });
  const send = async (
    method: string,
    path: string,
    options: { who?: string; session?: string; body?: unknown } = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${options.who ?? 'operator'}`,
        ...(options.session === undefined ? {} : { 'support-session': options.session }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { send, modelCalls };
};

const retrievePath = `/tenants/${tenant}/diagnostics/retrieve`;
const session = `sesjon-${tenant}`;

describe('operator diagnostics', () => {
  it('a fixed-query retrieve runs no planner and returns the same chunks twice', async () => {
    const { send, modelCalls } = await boot();
    const body = { service: 'svar', queries: ['tilskudd skyplattform'] };
    const first = await send('POST', retrievePath, { session, body });
    const second = await send('POST', retrievePath, { session, body });
    expect(first.status).toBe(200);
    const chunks = first.body.chunks as { chunkId: string; document?: string }[];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.find((c) => c.chunkId === 'dok-1-2')?.document).toBe('dok-1');
    expect(second.body.chunks).toEqual(first.body.chunks);
    expect(first.body.dataset).toBe('digdir/felles');
    expect(modelCalls).toEqual([]);
  });

  it('retrieve refuses an operator without a support session', async () => {
    const { send } = await boot();
    const body = { dataset: 'digdir/felles', queries: ['tilskudd'] };
    expect((await send('POST', retrievePath, { body })).status).toBe(404);
    expect((await send('POST', retrievePath, { body, session: `sesjon-${other}` })).status).toBe(
      404,
    );
  });

  it('retrieve refuses a tenant user', async () => {
    const { send } = await boot();
    const res = await send('POST', retrievePath, {
      who: 'kari',
      session,
      body: { dataset: 'digdir/felles', queries: ['tilskudd'] },
    });
    expect(res.status).toBe(404);
  });

  it("retrieve cannot reach another tenant's dataset or service", async () => {
    const { send } = await boot();
    const dataset = await send('POST', retrievePath, {
      session,
      body: { dataset: `${other}/hemmelig`, queries: ['tilskudd'] },
    });
    expect(dataset.status).toBe(404);
    const service = await send('POST', retrievePath, {
      session,
      body: { service: 'hemmelig-svar', queries: ['tilskudd'] },
    });
    expect(service.status).toBe(404);
  });

  it('retrieve needs exactly one of service and dataset', async () => {
    const { send } = await boot();
    const res = await send('POST', retrievePath, {
      session,
      body: { service: 'svar', dataset: 'digdir/felles', queries: ['tilskudd'] },
    });
    expect(res.status).toBe(400);
  });

  it('overrides switch rerank and auto-filter in the effective config', async () => {
    const { send } = await boot();
    const plain = await send('POST', retrievePath, {
      session,
      body: { service: 'svar', queries: ['tilskudd'] },
    });
    expect(plain.body.config).toMatchObject({
      maxPerDocument: 2,
      autoFilter: { enabled: false },
      rerank: { enabled: false },
    });
    const changed = await send('POST', retrievePath, {
      session,
      body: {
        service: 'svar',
        queries: ['tilskudd'],
        overrides: { rerank: true, rerankCandidateK: 12, autoFilter: true, limit: 5 },
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.config).toMatchObject({
      limit: 5,
      maxPerDocument: 2,
      autoFilter: { enabled: true },
      rerank: { enabled: true, candidateK: 12 },
    });
    const trace = changed.body.trace as { expansion: { rerank: { status: string } } };
    expect(trace.expansion.rerank.status).toBe('unconfigured');
  });

  it("resolution shows the service's retrieval settings without calling a model", async () => {
    const { send, modelCalls } = await boot();
    const res = await send('GET', `/tenants/${tenant}/diagnostics/services/svar/resolution`, {
      session,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: 'svar',
      version: 3,
      strategy: { id: 'agent-loop' },
      knowledge: {
        datasets: ['digdir/felles'],
        reranker: null,
        retrieval: { maxPerDocument: 2, autoFilter: { enabled: false } },
      },
    });
    expect(modelCalls).toEqual([]);
  });

  it("plan runs the service's query planner once with the service model", async () => {
    const { send, modelCalls } = await boot();
    const res = await send('POST', `/tenants/${tenant}/diagnostics/plan`, {
      session,
      body: { service: 'svar', query: 'Når er fristen for tilskudd?' },
    });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('test/model');
    expect(Array.isArray(res.body.queries)).toBe(true);
    expect(modelCalls.length).toBeGreaterThan(0);
  });

  it('attribution splits a run into search pool, displayed and read chunks', async () => {
    const { send } = await boot();
    const res = await send('GET', `/tenants/${tenant}/diagnostics/tasks/t1/attribution`, {
      session,
    });
    expect(res.status).toBe(200);
    const ids = (key: string) => (res.body[key] as { chunkId: string }[]).map((h) => h.chunkId);
    expect(res.body.service).toBe('svar');
    expect(res.body.displayLimit).toBe(2);
    expect(ids('pool')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids('displayed')).toEqual(['a', 'b', 'd']);
    expect(ids('read')).toEqual(['a', 'e']);
    expect(res.body.reads).toEqual([
      { chunks: [{ chunkId: 'a', document: 'd1', position: 0 }], auto: true },
      { chunks: [{ chunkId: 'e', document: 'd4', position: 0 }], auto: false },
    ]);
  });

  it('attribution refuses a task from another tenant', async () => {
    const { send } = await boot();
    const res = await send('GET', `/tenants/${tenant}/diagnostics/tasks/t2/attribution`, {
      session,
    });
    expect(res.status).toBe(404);
  });
});
