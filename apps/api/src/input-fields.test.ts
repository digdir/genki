import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets, type Kernel } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { capabilityResolver, createPlatform } from './composition.js';
import { digdir, plugins } from './testkit.js';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
});

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

const fields = [
  {
    id: 'ministry',
    label: 'Departement',
    kind: 'choice',
    required: true,
    options: ['Kunnskapsdepartementet', 'Digitaliserings- og forvaltningsdepartementet'],
  },
  { id: 'agency', label: 'Virksomhet', kind: 'organisation', required: true },
  { id: 'year', label: 'År', kind: 'year' },
];

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'maloppnaelse', name: 'Vurdering av måloppnåelse' },
  spec: {
    purpose: 'Vurder måloppnåelse for en virksomhet',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'], fields },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Vurder kort.' } },
    model: { primary: 'fake/gpt', residency: 'norway' },
    exposure: { rest: true, mcp: true, openai: true },
  },
};

const boot = async () => {
  const model = await fakeHttp(() => ({
    status: 200,
    json: {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Vurdert.' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  }));
  fakes.push(model);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: `${model.url}/v1`,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
  });
  await platform.definitions.publish(service, 'test', 'test', {});
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const send = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const prompts = () =>
    model.seen.flatMap((r) =>
      ((r.body.messages as { role: string; content: string }[] | undefined) ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    );
  return { send, prompts };
};

describe('a service with an input form', () => {
  it('renders the filled fields into the single-call prompt as labelled lines', async () => {
    const { send, prompts } = await boot();
    const response = await send('/api/tools/call/maloppnaelse__default', {
      ministry: 'Kunnskapsdepartementet',
      agency: 'Utdanningsdirektoratet',
      year: 2025,
    });

    expect(response.status).toBe(200);
    expect(prompts()[0]).toBe(
      'Departement: Kunnskapsdepartementet\nVirksomhet: Utdanningsdirektoratet\nÅr: 2025',
    );
  });

  it('refuses a missing required field and a wrong option before any model call', async () => {
    const { send, prompts } = await boot();
    const missing = await send('/api/tools/call/maloppnaelse__default', {
      ministry: 'Kunnskapsdepartementet',
    });
    const wrong = await send('/api/tools/call/maloppnaelse__default', {
      ministry: 'Finansdepartementet',
      agency: 'Skatteetaten',
    });

    expect(missing.status).toBe(400);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect(((await missing.json()) as { errors: unknown[] }).errors).toEqual([
      { path: 'agency', message: '«Virksomhet» må fylles ut.' },
    ]);
    expect(wrong.status).toBe(400);
    expect(prompts()).toEqual([]);
  });

  it('publishes the form in the OpenAPI document, MCP tools/list and /v1/models', async () => {
    const { send } = await boot();
    const openapi = (await (await send('/api/tools/openapi.json')).json()) as {
      paths: Record<string, { post: { requestBody: { content: Record<string, unknown> } } }>;
    };
    const body = openapi.paths['/api/tools/call/maloppnaelse__default']?.post.requestBody.content[
      'application/json'
    ] as { schema: { required: string[] } };
    const tools = (await (
      await send(
        '/api/mcp',
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
      )
    ).json()) as { result: { tools: { inputSchema: { required: string[] } }[] } };
    const models = (await (await send('/v1/models')).json()) as {
      data: { input_fields?: { id: string }[] }[];
    };

    expect(body.schema.required).toEqual(['ministry', 'agency']);
    expect(tools.result.tools[0]?.inputSchema.required).toEqual(['ministry', 'agency']);
    expect(models.data[0]?.input_fields?.map((f) => f.id)).toEqual(['ministry', 'agency', 'year']);
  });
});

describe('options drawn from dataset facets', () => {
  it('fills the options of a field from the facet values when the service is listed', async () => {
    const store = new InMemoryDefinitionStore({
      ...plugins,
      datasets: new Set(['kudos']),
      models: new Map([['fake/gpt', { residency: 'norway', capabilities: [] }]]),
    });
    await store.publish(
      {
        ...service,
        spec: {
          ...service.spec,
          knowledge: { datasets: [{ dataset: 'kudos' }] },
          input: {
            accepts: ['text/plain'],
            fields: [
              {
                id: 'agency',
                label: 'Virksomhet',
                kind: 'organisation',
                optionsFrom: { dataset: 'kudos', facet: 'organisation' },
              },
            ],
          },
        },
      },
      'test',
      'test',
      {},
    );
    const [compiled] = await store.capabilities();
    const kernel = {
      describe: async () => [compiled?.capability.descriptor],
    } as unknown as Kernel;
    const asked: unknown[] = [];
    const resolver = capabilityResolver(store, kernel, {
      fieldOptions: async (_principal, tenant, from) => {
        asked.push({ tenant, ...from });
        return [
          { value: 'Udir', count: 2 },
          { value: 'Digdir', count: 5 },
        ];
      },
    });

    const [entry] = await resolver.list(kari);

    expect(asked).toEqual([{ tenant: digdir, dataset: 'kudos', facet: 'organisation' }]);
    expect(entry?.inputFields?.[0]?.options).toEqual(['Digdir', 'Udir']);
    expect(entry?.inputSchema).toMatchObject({
      properties: { agency: { enum: ['Digdir', 'Udir'] } },
    });
  });
});

describe('test runs of a draft with an input form', () => {
  const draft = { ...service, metadata: { ...service.metadata, id: 'maloppnaelse-utkast' } };

  it('refuses a builder test run without the required fields with the same 400 problem', async () => {
    const { send, prompts } = await boot();
    const response = await send(`/tenants/${digdir}/definitions/test-run`, {
      definition: draft,
      query: 'Er målene nådd?',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Ugyldig input',
      status: 400,
      detail: '«Departement» må fylles ut. «Virksomhet» må fylles ut.',
      code: 'invalid_input',
      errors: [
        { path: 'ministry', message: '«Departement» må fylles ut.' },
        { path: 'agency', message: '«Virksomhet» må fylles ut.' },
      ],
    });
    expect(prompts()).toEqual([]);
  });

  it('runs a builder test run from the form alone', async () => {
    const { send, prompts } = await boot();
    const response = await send(`/tenants/${digdir}/definitions/test-run`, {
      definition: draft,
      input: { ministry: 'Kunnskapsdepartementet', agency: 'Udir' },
    });

    expect(response.status).toBe(200);
    expect(prompts()[0]).toBe('Departement: Kunnskapsdepartementet\nVirksomhet: Udir');
  });

  it('checks the form on a playground run of the draft', async () => {
    const { send, prompts } = await boot();
    const run = (input: unknown) =>
      send(`/tenants/${digdir}/playground/runs`, {
        setup: {
          service: { id: draft.metadata.id, version: 'draft', definition: draft },
          output: 'text',
        },
        input,
      });

    const refused = await run({ text: 'Er målene nådd?' });
    const wrong = await run({ fields: { ministry: 'Finansdepartementet', agency: 'Udir' } });
    const ran = await run({
      fields: { ministry: 'Kunnskapsdepartementet', agency: 'Udir', year: 2024 },
      text: 'Er målene nådd?',
    });

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('invalid_input');
    expect(((await wrong.json()) as { errors: { path: string }[] }).errors).toEqual([
      expect.objectContaining({ path: 'ministry' }),
    ]);
    expect(ran.status).toBe(200);
    expect(prompts()[0]).toContain(
      'Departement: Kunnskapsdepartementet\nVirksomhet: Udir\nÅr: 2024\n\nEr målene nådd?',
    );
  });
});
