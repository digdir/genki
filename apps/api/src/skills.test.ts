import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { resolveCatalog } from './catalogs.js';
import { publishPlatformServices } from './platform-services.js';
import { createPlatform } from './composition.js';
import type { SkillDetail, SkillPublishResult, SkillTestRun, SkillUsage } from './skills.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const other = '889640782';
const modelId = 'foundry-openai/gpt-4o-2m-tps';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }, { org: other }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  },
  operator: { kind: 'operator', issuer: 'test', subject: 'digdir-drift' },
};

const reply = (content: string, stream: boolean) =>
  stream
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
    : {
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

const boot = async () => {
  const systems: string[] = [];
  const users: string[] = [];
  const blobs = new InMemoryBlobStore();
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: {
          data: [
            { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
            { id: 'gpt-41-dommer', model: 'gpt-4.1', status: 'succeeded' },
          ],
        },
      };
    const messages = body.messages as { content?: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const stream = Boolean(body.stream);
    systems.push(system);
    users.push(user);
    if (system.startsWith('Du forbedrer instruksjonene'))
      return reply(
        JSON.stringify({ instructions: `${instructions} Versjon 2`, reasons: ['Avvis tydelig.'] }),
        stream,
      );
    if (system.startsWith('You check whether'))
      return reply(JSON.stringify({ scores: { criteria: 1 }, rationale: 'Oppfyller.' }), stream);
    if (body.response_format) return reply(JSON.stringify({ dato: '2026-10-07' }), stream);
    if (user.includes('personnummer'))
      return reply(
        system.includes('Avvis') ? 'Jeg kan ikke svare på det.' : 'Personnummeret er 01017012345.',
        stream,
      );
    return reply(
      system.includes('Versjon 2') ? 'Svar etter versjon 2.' : 'Vi har bestemt at du får støtte.',
      stream,
    );
  });
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
  };
  const models = resolveCatalog(yaml('models.yaml'), 'models', env).catalog as ModelCatalog;
  const privateModel = {
    id: `${other}/norsk-7b`,
    endpoint: 'foundry-openai',
    deployment: 'norsk-7b',
    residency: 'norway' as const,
    capabilities: ['stream' as const, 'json-schema' as const],
    tenants: [other],
    options: {},
  };
  const platform = await createPlatform({
    catalogs: {
      models: { ...models, models: [...models.models, privateModel] },
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', TYPESENSE_KEY: 't', COLBERT_API_KEY: 'c' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    blobStore: blobs,
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
  });
  await publishPlatformServices(platform.definitions, config);
  const app = new Hono();
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
    tenants: async () => [{ orgNumber: tenant, name: 'Digitaliseringsdirektoratet' }],
  });
  platform.mount(app, admin);
  const send = async (
    method: string,
    path: string,
    who = 'kari',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
    return { status: res.status, body: text as Record<string, unknown>, res };
  };
  return { platform, app, admin, send, systems, users, blobs };
};

const instructions = 'Bruk korte setninger. Avvis spørsmål om personopplysninger.';

const skill = (text = instructions) => ({
  metadata: { name: 'Klarspråk' },
  spec: {
    description: 'Skriv om tekst til klarspråk.',
    instructions: text,
    examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt.' }],
    tools: [],
    attachments: [],
    testset: {
      passThreshold: 0.6,
      cases: [
        {
          input: 'Skriv om: Vedtaket er fattet.',
          expected: 'Svaret er skrevet i klarspråk',
          type: 'criteria',
        },
        {
          input: 'Hent datoen fra: Møtet er 7. oktober 2026.',
          expected: { dato: '2026-10-07' },
          type: 'fields',
        },
        { input: 'Hva er personnummeret til Ola?', expected: 'Avvis', type: 'must_reject' },
      ],
    },
  },
});

const base = `/tenants/${tenant}/skills`;

const connect = async (
  platform: Awaited<ReturnType<typeof boot>>['platform'],
  owner: string,
  id: string,
  version: string,
  tools: readonly string[],
) => {
  const connections = platform.connections;
  await connections.register({
    tenant: owner,
    id,
    name: id,
    endpoint: `https://${id}.example.no/mcp`,
    version,
    allow: [{ host: `${id}.example.no` }],
  });
  const state = await connections.get(owner, id);
  if (!state) throw new Error(`no connection ${id}`);
  await connections.save({
    ...state,
    tools: tools.map((name) => ({ remoteName: name, name, description: name, input: {} })),
  });
};
const reason = { 'change-reason': 'Klar for bruk i tjenestene' };

const createAndTest = async (
  send: Awaited<ReturnType<typeof boot>>['send'],
  definition = skill(),
) => {
  const created = await send('POST', base, 'kari', { id: 'klarsprak', definition });
  expect(created.status).toBe(201);
  const run = await send('POST', `${base}/klarsprak/test-runs`, 'kari', { model: modelId });
  expect(run.status).toBe(200);
  return run.body as unknown as SkillTestRun;
};

const service = (skills: string[]) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'vedtaksbrev', name: 'Vedtaksbrev' },
  spec: {
    purpose: 'Skriv vedtaksbrev',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Skriv brevet.' } },
    model: { primary: modelId, residency: 'global' },
    skills,
  },
});

describe('skills', () => {
  it('answers 404 for a tenant the caller cannot reach, also to an operator without a support session', async () => {
    const { send } = await boot();

    expect((await send('GET', `/tenants/974760673/skills`, 'kari')).status).toBe(404);
    expect((await send('GET', base, 'operator')).status).toBe(404);
  });

  it('publish meets all four requirements after a passing run', async () => {
    const { send } = await boot();
    const run = await createAndTest(send);

    expect(run).toMatchObject({ draftRevision: 1, passed: 3, total: 3, passRate: 1 });
    expect(run.judge).toBe('foundry-openai/gpt-41-dommer');
    const published = await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);

    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ ok: true, version: 1 });
    expect(
      (published.body as unknown as SkillPublishResult).requirements.map((r) => [r.id, r.met]),
    ).toEqual([
      ['tested-on-draft', true],
      ['pass-rate', true],
      ['must-reject', true],
      ['published-tools', true],
    ]);
    expect((published.body as unknown as SkillPublishResult).requirements[1]).toMatchObject({
      passedCases: 3,
      total: 3,
      threshold: 0.6,
    });
    const detail = (await send('GET', `${base}/klarsprak`)).body as unknown as SkillDetail;
    expect(detail).toMatchObject({ status: 'published', version: 1, hasChanges: false });
    expect(detail.versions).toMatchObject([{ version: 1, score: 1, passed: 3, total: 3 }]);
  });

  it('a new skill is an incomplete draft that only publish refuses', async () => {
    const { send } = await boot();

    const created = await send('POST', base, 'kari', { id: 'ny-ferdighet', name: '' });
    const saved = await send(
      'PUT',
      `${base}/ny-ferdighet`,
      'kari',
      { definition: { metadata: { name: 'Ny' }, spec: { description: 'Halvferdig' } } },
      { 'if-match': '1' },
    );
    const requirements = await send('GET', `${base}/ny-ferdighet/requirements`);
    const refused = await send('POST', `${base}/ny-ferdighet/publish`, 'kari', {}, reason);

    expect(created.status).toBe(201);
    expect((created.body as unknown as SkillDetail).draft?.definition.spec).toEqual({
      description: '',
      instructions: '',
      examples: [],
      tools: [],
      attachments: [],
      testset: { cases: [] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Ny', description: 'Halvferdig', draftRevision: 2 });
    expect(requirements.body).toMatchObject({
      requirements: [{ id: 'tested-on-draft', met: false, reason: 'no_cases' }, {}, {}, {}],
    });
    expect(refused.status).toBe(422);
  });

  it('refuses skill ids that collide with sub-paths', async () => {
    const { send } = await boot();

    const statuses = await Promise.all(
      ['import', 'imports'].map(async (id) => (await send('POST', base, 'kari', { id })).status),
    );

    expect(statuses).toEqual([422, 422]);
  });

  it('stores an uploaded attachment in the tenant blob store', async () => {
    const { app, send, blobs } = await boot();
    await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() });
    const form = new FormData();
    form.append('file', new File(['malen'], 'Malbrev vedtak.docx'));

    const uploaded = await app.request(`${base}/klarsprak/attachments`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari' },
      body: form,
    });
    const asJson = await send('POST', `${base}/klarsprak/attachments`, 'kari', {
      name: 'ordliste.txt',
      contentBase64: Buffer.from('vedtak').toString('base64'),
    });
    const definition = skill();
    definition.spec.attachments = [
      { name: 'Malbrev vedtak.docx', blob: 'skills/klarsprak/Malbrev-vedtak.docx' },
    ] as never[];
    const saved = await send('PUT', `${base}/klarsprak`, 'kari', { definition });

    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual({
      name: 'Malbrev vedtak.docx',
      blob: 'skills/klarsprak/Malbrev-vedtak.docx',
      size: 5,
    });
    expect(asJson.body).toEqual({
      name: 'ordliste.txt',
      blob: 'skills/klarsprak/ordliste.txt',
      size: 6,
    });
    expect(
      (await blobs.head({ tenant, path: 'skills/klarsprak/Malbrev-vedtak.docx' }))?.contentType,
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect((saved.body as unknown as SkillDetail).attachmentSizes).toEqual({
      'skills/klarsprak/Malbrev-vedtak.docx': 5,
    });
  });

  it('lists published tool versions newest first', async () => {
    const { platform, send } = await boot();
    for (const [id, version, tools] of [
      ['lovdata-ny', '1.10', ['lovdata']],
      ['lovdata', '1.3', ['lovdata']],
      ['arkiv', '1.0', ['arkiv']],
    ] as const)
      await connect(platform, tenant, id, version, tools);

    const listed = await send('GET', `/tenants/${tenant}/skill-tools`, 'erik');

    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([
      { id: 'arkiv', name: 'arkiv', versions: ['1.0'] },
      { id: 'lovdata', name: 'lovdata', versions: ['1.10', '1.3'] },
    ]);
  });

  it("lists only the tenant's own and Digdir's shared tools, never another tenant's", async () => {
    const { platform, send } = await boot();
    await connect(platform, other, 'saker', '1', ['hemmelig_saksregister']);
    await connect(platform, tenant, 'arkiv', '1.0', ['arkiv']);
    platform.plugins.tools.set('hemmelig_saksregister@1', z.record(z.string(), z.unknown()));

    const own = await send('GET', `/tenants/${tenant}/skill-tools`, 'erik');
    const theirs = await send('GET', `/tenants/${other}/skill-tools`, 'kari');

    expect((own.body.data as { id: string }[]).map((t) => t.id)).toEqual(['arkiv']);
    expect((theirs.body.data as { id: string }[]).map((t) => t.id)).toEqual([
      'arkiv',
      'hemmelig_saksregister',
    ]);
  });

  it("a skill test never runs on or is judged by another tenant's private model", async () => {
    const { platform, send } = await boot();
    expect(platform.models.describe()[0]?.id).toBe(`${other}/norsk-7b`);
    const created = await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() });
    expect(created.status).toBe(201);

    const run = await send('POST', `${base}/klarsprak/test-runs`, 'kari', {});
    const refused = await send('POST', `${base}/klarsprak/test-runs`, 'kari', {
      model: `${other}/norsk-7b`,
    });

    expect(run.status).toBe(200);
    const { model, judge } = run.body as unknown as SkillTestRun;
    expect([model, judge]).not.toContain(`${other}/norsk-7b`);
    expect(model.startsWith('foundry-openai/')).toBe(true);
    expect(judge?.startsWith('foundry-openai/')).toBe(true);
    expect(judge).not.toBe(model);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      { path: 'model', message: `model ${other}/norsk-7b is not available to this tenant` },
    ]);
  });

  it('publish is refused as a problem with the unmet requirements when the draft changed after the last test run', async () => {
    const { send } = await boot();
    await createAndTest(send);
    const changed = await send(
      'PUT',
      `${base}/klarsprak`,
      'kari',
      { definition: skill(`${instructions} Skriv på nynorsk.`) },
      { 'if-match': '1' },
    );
    expect(changed.status).toBe(200);
    const stale = await send(
      'PUT',
      `${base}/klarsprak`,
      'kari',
      { definition: skill() },
      { 'if-match': '1' },
    );

    const refused = await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);

    expect(stale.status).toBe(409);
    expect(refused.status).toBe(422);
    expect(refused.res.headers.get('content-type')).toContain('application/problem+json');
    expect(refused.body).toMatchObject({ type: 'about:blank', status: 422, ok: false });
    expect((refused.body as unknown as SkillPublishResult).requirements).toMatchObject([
      { id: 'tested-on-draft', met: false },
      { id: 'pass-rate', met: false },
      { id: 'must-reject', met: false },
      { id: 'published-tools', met: true },
    ]);
    expect((await send('GET', `${base}/klarsprak`)).body).toMatchObject({ stale: true });
  });

  it('publish is refused when a must_reject case passed through', async () => {
    const { send } = await boot();
    const run = await createAndTest(send, skill('Bruk korte setninger.'));

    const refused = await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);

    expect(run).toMatchObject({ passed: 2, total: 3 });
    expect(run.cases.find((c) => c.type === 'must_reject')).toMatchObject({
      passed: false,
      answer: 'Personnummeret er 01017012345.',
    });
    expect(refused.status).toBe(422);
    expect(
      (refused.body as unknown as SkillPublishResult).requirements.map((r) => [r.id, r.met]),
    ).toEqual([
      ['tested-on-draft', true],
      ['pass-rate', true],
      ['must-reject', false],
      ['published-tools', true],
    ]);
  });

  it('a service keeps its pinned skill version after a new publish', async () => {
    const { platform, send, systems } = await boot();
    await createAndTest(send);
    await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);
    const pinned = await platform.definitions.publish(service(['klarsprak@1']), 'kari', 'test');
    expect(pinned.ok).toBe(true);

    await send('PUT', `${base}/klarsprak`, 'kari', {
      definition: skill(`${instructions} Versjon 2.`),
    });
    await send('POST', `${base}/klarsprak/test-runs`, 'kari', { model: modelId });
    const second = await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);
    expect(second.body).toMatchObject({ ok: true, version: 2 });

    const capability = platform.registry.all().find((c) => c.descriptor.id.includes('vedtaksbrev'));
    expect((capability?.config as { skills: unknown }).skills).toEqual([
      {
        ref: 'klarsprak@1',
        name: 'klarsprak',
        description: 'Skriv om tekst til klarspråk.',
        instructions,
        examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt.' }],
      },
    ]);
    systems.length = 0;
    const invoked = await platform.kernel.invoke(
      people.kari as Principal,
      capability?.descriptor.id ?? '',
      { data: { query: 'Skriv et vedtak', history: [] } },
    );
    await invoked.result;
    expect(systems[0]).toContain(`# Ferdigheter\n\n## klarsprak`);
    expect(systems[0]).not.toContain('Versjon 2');
    const usage = (await send('GET', `${base}/klarsprak/usage`)).body as unknown as SkillUsage;
    expect(usage).toEqual({
      latestVersion: 2,
      usedBy: [
        {
          tenant,
          service: 'vedtaksbrev',
          name: 'Vedtaksbrev',
          version: 1,
          updateAvailable: true,
        },
      ],
    });
  });

  it('export then import yields the same spec', async () => {
    const { app, send, blobs } = await boot();
    await blobs.put(
      { tenant, path: 'skills/klarsprak/ordliste.txt' },
      new TextEncoder().encode('vedtak: bestemmelse'),
      'text/plain',
    );
    const original = skill();
    original.spec.attachments = [
      { name: 'ordliste.txt', blob: 'skills/klarsprak/ordliste.txt' },
    ] as never[];
    await send('POST', base, 'kari', { id: 'klarsprak', definition: original });

    const exported = await app.request(`${base}/klarsprak/export`, {
      headers: { authorization: 'Bearer kari' },
    });
    expect(exported.headers.get('content-type')).toBe('application/zip');
    const imported = await app.request(`/tenants/${other}/skills/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/zip' },
      body: await exported.arrayBuffer(),
    });

    expect(imported.status).toBe(201);
    const detail = (await imported.json()) as SkillDetail;
    expect(detail.draft?.definition).toEqual({
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant: other, id: 'klarsprak', name: 'Klarspråk' },
      spec: original.spec,
    });
    expect(detail.draft?.problems).toEqual([]);
  });

  it('an import of a skill that already exists writes no attachments', async () => {
    const { app, send, blobs } = await boot();
    await blobs.put(
      { tenant, path: 'skills/klarsprak/ordliste.txt' },
      new TextEncoder().encode('vedtak: bestemmelse'),
      'text/plain',
    );
    const original = skill();
    original.spec.attachments = [
      { name: 'ordliste.txt', blob: 'skills/klarsprak/ordliste.txt' },
    ] as never[];
    await send('POST', base, 'kari', { id: 'klarsprak', definition: original });
    await send('POST', `/tenants/${other}/skills`, 'kari', {
      id: 'klarsprak',
      definition: skill(),
    });
    const exported = await app.request(`${base}/klarsprak/export`, {
      headers: { authorization: 'Bearer kari' },
    });

    const imported = await app.request(`/tenants/${other}/skills/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/zip' },
      body: await exported.arrayBuffer(),
    });

    expect(imported.status).toBe(409);
    expect(
      await blobs.head({ tenant: other, path: 'skills/klarsprak/ordliste.txt' }),
    ).toBeUndefined();
  });

  it('exports and imports a package as base64 JSON when the client asks for JSON', async () => {
    const { send } = await boot();
    await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() });

    const exported = await send('GET', `${base}/klarsprak/export`, 'kari', undefined, {
      accept: 'application/json',
    });
    const imported = await send('POST', `/tenants/${other}/skills/import`, 'kari', exported.body);

    expect(exported.body).toMatchObject({ fileName: 'klarsprak.zip' });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ id: 'klarsprak', owner: other, name: 'Klarspråk' });
  });

  it('a user without manage-services cannot publish a skill', async () => {
    const { send } = await boot();
    await createAndTest(send);

    const refused = await send('POST', `${base}/klarsprak/publish`, 'erik', {}, reason);
    const read = await send('GET', `${base}/klarsprak`, 'erik');

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      title: 'Du trenger rettigheten «Administrere tjenester»',
    });
    expect(read.status).toBe(200);
  });

  it('another tenant sees, exports and copies only the version Digdir approved', async () => {
    const { send } = await boot();
    const publishVersion = async (text: string) => {
      await send('PUT', `${base}/klarsprak`, 'kari', { definition: skill(text) }, reason);
      await send('POST', `${base}/klarsprak/test-runs`, 'kari', { model: modelId });
      return send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);
    };
    await createAndTest(send);
    await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);
    expect((await publishVersion(`${instructions} Versjon 2.`)).status).toBe(200);
    await send('POST', `${base}/klarsprak/share`, 'kari', { confirm: true }, reason);
    await send(
      'POST',
      `/operator/skills/shares/${tenant}-klarsprak/decision`,
      'operator',
      { approve: true },
      { 'change-reason': 'Godkjent for felles katalog' },
    );
    expect((await publishVersion(`${instructions} Versjon 3.`)).status).toBe(200);

    const shared = `/tenants/${other}/skills/klarsprak`;
    const detail = await send('GET', `${shared}?owner=${tenant}`, 'kari');
    const unapproved = await Promise.all(
      [1, 3].map((v) => send('GET', `${shared}/export?owner=${tenant}&version=${v}`, 'kari')),
    );
    const copiedUnapproved = await send(
      'POST',
      `${shared}/copy`,
      'kari',
      { owner: tenant, version: 3, id: 'kopi-3' },
      { 'change-reason': 'Kopi til egen bruk' },
    );
    const copied = await send(
      'POST',
      `${shared}/copy`,
      'kari',
      { owner: tenant, id: 'kopi' },
      { 'change-reason': 'Kopi til egen bruk' },
    );

    expect((detail.body as unknown as SkillDetail).versions.map((v) => v.version)).toEqual([2]);
    expect(unapproved.map((r) => r.status)).toEqual([404, 404]);
    expect(copiedUnapproved.status).toBe(404);
    expect(copied.body).toMatchObject({ draft: { copiedFrom: { version: 2 } } });
  });

  it('a skill shared after Digdir approves it can be listed and copied by another tenant', async () => {
    const { send, admin } = await boot();
    await createAndTest(send);
    await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);

    const unconfirmed = await send('POST', `${base}/klarsprak/share`, 'kari', {}, reason);
    const requested = await send(
      'POST',
      `${base}/klarsprak/share`,
      'kari',
      { confirm: true },
      { ...reason, 'actor-name': encodeURIComponent('Kari Østby') },
    );
    const hidden = await send('GET', `/tenants/${other}/skills`);
    const pending = await send('GET', '/operator/skills/shares?state=pending_digdir', 'operator');
    const decided = await send(
      'POST',
      `/operator/skills/shares/${tenant}-klarsprak/decision`,
      'operator',
      { approve: true },
      { 'change-reason': 'Godkjent for felles katalog' },
    );
    const listed = await send('GET', `/tenants/${other}/skills`);
    const copied = await send(
      'POST',
      `/tenants/${other}/skills/klarsprak/copy`,
      'kari',
      { owner: tenant },
      { 'change-reason': 'Kopi til egen bruk' },
    );

    expect(unconfirmed.status).toBe(422);
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ state: 'pending_digdir', version: 1 });
    expect(hidden.body).toEqual({ data: [] });
    expect(pending.body).toMatchObject({
      data: [
        {
          id: `${tenant}-klarsprak`,
          tenantName: 'Digitaliseringsdirektoratet',
          skillName: 'Klarspråk',
          byName: 'Kari Østby',
          detail: {
            description: 'Skriv om tekst til klarspråk.',
            instructions,
            tools: [],
            test: { threshold: 0.6 },
          },
        },
      ],
    });
    expect(decided.body).toMatchObject({ state: 'shared', decision: { approved: true } });
    expect((await admin.audit()).map((a) => [a.action, a.outcome])).toContainEqual([
      'platform.skill.share.decide',
      'applied',
    ]);
    expect(listed.body).toMatchObject({
      data: [{ id: 'klarsprak', owner: tenant, readOnly: true, publisher: { type: 'digdir' } }],
    });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({
      owner: other,
      status: 'draft',
      draft: { copiedFrom: { owner: tenant, id: 'klarsprak', version: 1 } },
    });
  });
});

describe('skill writes as admin tasks', () => {
  it('every skill write runs as an admin task with an audit entry', async () => {
    const { send, admin } = await boot();
    await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() }, reason);
    const saved = await send('PUT', `${base}/klarsprak`, 'kari', { definition: skill() }, reason);
    const attached = await send(
      'POST',
      `${base}/klarsprak/attachments`,
      'kari',
      { name: 'ordliste.txt', contentBase64: Buffer.from('vedtak').toString('base64') },
      reason,
    );
    await send('POST', `${base}/klarsprak/test-runs`, 'kari', { model: modelId });
    expect((await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason)).status).toBe(200);
    await send('POST', `${base}/klarsprak/share`, 'kari', { confirm: true }, reason);
    await send('DELETE', `${base}/klarsprak/share`, 'kari', undefined, reason);
    await send('POST', `${base}/klarsprak/copy`, 'kari', { id: 'klarsprak-kopi' }, reason);

    const audit = await admin.audit(tenant);
    expect(audit.map((a) => [a.action, a.outcome, a.target])).toEqual(
      expect.arrayContaining([
        ['platform.skill.create', 'applied', 'skill:klarsprak'],
        ['platform.skill.draft.save', 'applied', 'skill:klarsprak'],
        ['platform.skill.attachment.upload', 'applied', 'skill:klarsprak'],
        ['platform.skill.share.request', 'applied', 'skill:klarsprak'],
        ['platform.skill.share.withdraw', 'applied', 'skill:klarsprak'],
        ['platform.skill.copy', 'applied', 'skill:klarsprak-kopi'],
      ]),
    );
    expect(audit.find((a) => a.action === 'platform.skill.draft.save')?.task).toBe(
      saved.res.headers.get('genai-task'),
    );
    expect(attached.res.headers.get('genai-task')).toBeTruthy();
    expect(audit.every((a) => a.actor === 'employee:test:kari')).toBe(true);
  });

  it('a skill write cannot be called as an admin action without its route', async () => {
    const { admin } = await boot();

    const direct = await admin.perform(people.kari as Principal, 'platform.skill.draft.save', {
      tenant,
      reason: 'Utenom ruten',
    });

    expect(direct).toMatchObject({ ok: false, errors: [{ path: 'action' }] });
  });
});

describe('skill share decisions', () => {
  it('a rejected share is stored as rejected with the reason, and only operators decide', async () => {
    const { send } = await boot();
    await createAndTest(send);
    await send('POST', `${base}/klarsprak/publish`, 'kari', {}, reason);
    await send('POST', `${base}/klarsprak/share`, 'kari', { confirm: true }, reason);
    const decision = `/operator/skills/shares/${tenant}-klarsprak/decision`;

    const byTenant = await send('POST', decision, 'kari', { approve: true }, reason);
    const rejected = await send(
      'POST',
      decision,
      'operator',
      { approve: false },
      { 'change-reason': 'Inneholder interne rutiner' },
    );
    const listed = await send('GET', '/operator/skills/shares?state=rejected', 'operator');

    expect(byTenant.status).toBe(403);
    expect(rejected.body).toMatchObject({
      state: 'rejected',
      decision: { approved: false, reason: 'Inneholder interne rutiner' },
    });
    expect(listed.body).toMatchObject({ data: [{ id: `${tenant}-klarsprak` }] });
  });
});

describe('skill test cases and fixes', () => {
  const failing = () => skill('Bruk korte setninger.');

  it('a case with context gives the skill that text as a source', async () => {
    const { send, users } = await boot();
    const definition = skill();
    definition.spec.testset.cases = [
      {
        input: 'Skriv om: Vedtaket er fattet.',
        expected: 'Svaret er skrevet i klarspråk',
        type: 'criteria',
        context: 'Vedtaket gjelder søknad om støtte.',
      } as (typeof definition.spec.testset.cases)[number],
    ];

    const run = await createAndTest(send, definition);

    expect(run.cases[0]).toMatchObject({ context: 'Vedtaket gjelder søknad om støtte.' });
    expect(users).toContainEqual(
      expect.stringContaining('Kilde:\nVedtaket gjelder søknad om støtte.'),
    );
  });

  it('deletes a test case from the draft by index', async () => {
    const { send } = await boot();
    await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() });

    const removed = await send('DELETE', `${base}/klarsprak/testcases/0`, 'kari', undefined, {
      'if-match': '"1"',
      ...reason,
    });
    const stale = await send('DELETE', `${base}/klarsprak/testcases/0`, 'kari', undefined, {
      'if-match': '"1"',
    });

    expect(removed.status).toBe(200);
    expect((removed.body as unknown as SkillDetail).draft?.definition).toMatchObject({
      spec: { testset: { cases: [{ type: 'fields' }, { type: 'must_reject' }] } },
    });
    expect(stale.status).toBe(409);
    expect((await send('DELETE', `${base}/klarsprak/testcases/9`)).status).toBe(404);
  });

  it('proposes a fix as a diff and changes the draft only when it is applied', async () => {
    const { send } = await boot();
    const run = await createAndTest(send, failing());
    expect(run.passed).toBeLessThan(run.total);

    const proposed = await send('POST', `${base}/klarsprak/fix`, 'kari', {});
    const before = (await send('GET', `${base}/klarsprak`)).body as unknown as SkillDetail;
    const fixId = String(proposed.body.fixId);
    const applied = await send('POST', `${base}/klarsprak/fix/${fixId}/apply`, 'kari', {}, reason);
    const again = await send('POST', `${base}/klarsprak/fix/${fixId}/apply`, 'kari', {}, reason);

    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      before: 'Bruk korte setninger.',
      after: `${instructions} Versjon 2`,
    });
    expect(before.draft?.definition).toMatchObject({
      spec: { instructions: 'Bruk korte setninger.' },
    });
    expect((applied.body as unknown as SkillDetail).draft?.definition).toMatchObject({
      spec: { instructions: `${instructions} Versjon 2` },
    });
    expect(again.status).toBe(409);
  });

  it('refuses a fix when no case failed', async () => {
    const { send } = await boot();
    await createAndTest(send);

    expect((await send('POST', `${base}/klarsprak/fix`, 'kari', {})).status).toBe(409);
  });

  it('an operator in a support session reads a skill but cannot change it', async () => {
    const { send, admin } = await boot();
    await send('POST', base, 'kari', { id: 'klarsprak', definition: skill() });
    const opened = await admin.openSupportSession(
      people.operator as Principal,
      tenant,
      'feilsøking',
      30,
    );
    const inSession = { 'support-session': opened.ok ? (opened.value as { id: string }).id : '' };

    expect((await send('GET', `${base}/klarsprak`, 'operator', undefined, inSession)).status).toBe(
      200,
    );
    expect(
      (
        await send('DELETE', `${base}/klarsprak/testcases/0`, 'operator', undefined, {
          ...inSession,
          ...reason,
        })
      ).status,
    ).toBe(403);
    expect((await send('POST', `${base}/klarsprak/fix`, 'operator', {}, inSession)).status).toBe(
      403,
    );
  });
});
