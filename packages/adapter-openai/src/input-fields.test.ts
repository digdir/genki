import { describe, expect, it } from 'vitest';
import {
  formTextPart,
  inputFieldsSchema,
  textPart,
  type InputField,
  type Input,
  type Principal,
} from '@genai/contracts';
import { createKernel, type Emitted, type Strategy } from '@genai/kernel';
import { createOpenAiAdapter, type AskConversations, type ModelEntry } from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const fields: InputField[] = [
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

const entries: ModelEntry[] = [
  {
    id: 'maloppnaelse__default',
    capability: 'form',
    title: 'Vurdering av måloppnåelse',
    inputSchema: inputFieldsSchema(fields),
    inputFields: fields,
  },
  { id: 'fritekst__default', capability: 'form', inputSchema: {} },
];

const setup = (conversations?: AskConversations) => {
  const seen: Input[] = [];
  const echo: Strategy = {
    id: 'form',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (_ctx, input): AsyncIterable<Emitted> {
      seen.push(input);
      yield { type: 'kernel.result', data: [textPart('Vurdert.')] };
    },
  };
  const kernel = createKernel({
    strategies: [echo],
    capabilities: [
      {
        descriptor: {
          id: 'form',
          version: '1',
          tenant,
          title: 'form',
          description: 'form',
          input: {},
          interaction: ['unary', 'stream'],
          accepts: [],
          produces: [],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
        },
        strategy: { id: 'form', version: '1' },
        config: {},
        grants: [],
      },
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const app = createOpenAiAdapter({
    kernel,
    resolver: {
      list: async () => entries,
      resolve: async (_p, name) => {
        const entry = entries.find((e) => e.id === name);
        return entry
          ? { ok: true, entry }
          : { ok: false, code: 'model_not_found', message: `Model not found: ${name}` };
      },
    },
    auth: { authenticate: async () => kari },
    ...(conversations ? { conversations } : {}),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post, seen };
};

const call = (body: unknown) => setup().post('/api/tools/call/maloppnaelse__default', body);

describe('service input forms on the REST tool', () => {
  it('passes the fields to the strategy as data and as labelled lines', async () => {
    const { post, seen } = setup();
    const response = await post('/api/tools/call/maloppnaelse__default', {
      ministry: 'Kunnskapsdepartementet',
      agency: 'Utdanningsdirektoratet',
      year: '2025',
      query: 'Er målene nådd?',
    });

    expect(response.status).toBe(200);
    const text =
      'Departement: Kunnskapsdepartementet\nVirksomhet: Utdanningsdirektoratet\nÅr: 2025\n\nEr målene nådd?';
    expect(seen[0]?.data).toMatchObject({
      ministry: 'Kunnskapsdepartementet',
      agency: 'Utdanningsdirektoratet',
      year: 2025,
      query: text,
    });
    expect(seen[0]?.parts).toEqual([formTextPart(text)]);
  });

  it('runs without a free-text question when the form is filled', async () => {
    const response = await call({
      ministry: 'Kunnskapsdepartementet',
      agency: 'Utdanningsdirektoratet',
    });

    expect(response.status).toBe(200);
  });

  it('answers a missing required field with a 400 problem naming the field', async () => {
    const response = await call({ ministry: 'Kunnskapsdepartementet' });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Ugyldig input',
      status: 400,
      detail: '«Virksomhet» må fylles ut.',
      code: 'invalid_input',
      error: { code: 'invalid_input', message: '«Virksomhet» må fylles ut.' },
      errors: [{ path: 'agency', message: '«Virksomhet» må fylles ut.' }],
    });
  });

  it('answers an option outside the list with a 400 problem', async () => {
    const response = await call({ ministry: 'Finansdepartementet', agency: 'Skatteetaten' });
    const body = (await response.json()) as { errors: { path: string }[] };

    expect(response.status).toBe(400);
    expect(body.errors.map((e) => e.path)).toEqual(['ministry']);
  });

  it('publishes the fields as the request body schema', async () => {
    const response = await setup().app.request('/api/tools/openapi.json');
    const spec = (await response.json()) as {
      paths: Record<string, { post: { requestBody: { content: Record<string, unknown> } } }>;
    };
    const schema = (path: string) =>
      spec.paths[path]?.post.requestBody.content['application/json'] as {
        schema: { properties: Record<string, unknown>; required?: string[] };
      };

    const form = schema('/api/tools/call/maloppnaelse__default').schema;
    expect(form.required).toEqual(['ministry', 'agency']);
    expect(Object.keys(form.properties)).toEqual([
      'ministry',
      'agency',
      'year',
      'query',
      'conversation_id',
    ]);
    expect(form.properties.ministry).toMatchObject({ enum: fields[0]?.options });
  });

  it('documents `query`, the field the API reads, for a service without fields', async () => {
    const response = await setup().app.request('/api/tools/openapi.json');
    const text = await response.text();
    const spec = JSON.parse(text) as {
      paths: Record<string, { post: { requestBody: { content: Record<string, unknown> } } }>;
    };
    const free = spec.paths['/api/tools/call/fritekst__default']?.post.requestBody.content[
      'application/json'
    ] as { schema: { required: string[] } };

    expect(free.schema.required).toEqual(['query']);
    expect(text).not.toContain('"user-query"');
  });

  it('lists the fields on /v1/models for the workspace form', async () => {
    const response = await setup().app.request('/v1/models');
    const body = (await response.json()) as { data: { id: string; input_fields?: unknown }[] };

    expect(body.data.find((m) => m.id === 'maloppnaelse__default')?.input_fields).toEqual(fields);
    expect(body.data.find((m) => m.id === 'fritekst__default')?.input_fields).toBeUndefined();
  });
});

describe('service input forms on chat completions', () => {
  it('reads the form from `input` and puts the values before the question', async () => {
    const { post, seen } = setup();
    const response = await post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      messages: [{ role: 'user', content: '' }],
      input: { ministry: 'Kunnskapsdepartementet', agency: 'Utdanningsdirektoratet' },
    });

    expect(response.status).toBe(200);
    expect(seen[0]?.data).toMatchObject({
      ministry: 'Kunnskapsdepartementet',
      query: 'Departement: Kunnskapsdepartementet\nVirksomhet: Utdanningsdirektoratet',
    });
  });

  it('refuses a call without the required fields', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      messages: [{ role: 'user', content: 'Hei' }],
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'invalid_input',
      message: '«Departement» må fylles ut. «Virksomhet» må fylles ut.',
    });
  });
});

describe('a form service without a question', () => {
  const filled = { ministry: 'Kunnskapsdepartementet', agency: 'Utdanningsdirektoratet' };

  it('accepts input with no messages at all', async () => {
    const { post, seen } = setup();

    const response = await post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      input: filled,
    });

    expect(response.status).toBe(200);
    expect(seen[0]?.data).toMatchObject({ ministry: 'Kunnskapsdepartementet' });
  });

  it('accepts input with an empty messages list', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      messages: [],
      input: filled,
    });

    expect(response.status).toBe(200);
  });

  it('still answers invalid_input for empty input and no question', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      messages: [],
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
  });

  it('keeps missing_messages for a service without a form', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'fritekst__default',
      messages: [],
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(body.error.code).toBe('missing_messages');
  });

  it('stores the form input with the user turn of a conversation', async () => {
    const turns: Parameters<AskConversations['append']>[2][] = [];
    const { post } = setup({
      open: async () => ({ ok: true, id: 'c1', history: [] }),
      append: async (_request, _id, turn) => {
        turns.push(turn);
      },
    });

    await post('/v1/chat/completions', {
      model: 'maloppnaelse__default',
      input: { ...filled, year: '2025' },
      genai_conversation: true,
    });

    expect(turns[0]).toMatchObject({ role: 'user', input: { ...filled, year: 2025 } });
  });
});
