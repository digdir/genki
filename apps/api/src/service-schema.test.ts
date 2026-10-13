import Ajv from 'ajv';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { checkInputFields, missingLabels, type InputField } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { serviceSchemaOf } from './service-schema.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, klarsprak, other, plugins, principals } from './testkit.js';

type Json = Record<string, unknown>;

const fields: InputField[] = [
  {
    id: 'ministry',
    label: 'Departement',
    kind: 'choice',
    required: true,
    options: ['Kunnskapsdepartementet', 'Finansdepartementet'],
  },
  { id: 'year', label: 'År', kind: 'year', required: true, help: 'Året vurderingen gjelder' },
  { id: 'themes', label: 'Temaer', kind: 'multi-choice', options: ['digital', 'grønn'] },
  { id: 'remark', label: 'Merknad', kind: 'long-text' },
];

const withForm = (id: string, tenant?: string) => {
  const base = klarsprak({ id, ...(tenant ? { tenant } : {}) });
  return {
    ...base,
    spec: {
      ...base.spec,
      input: { accepts: ['text/plain'], fields },
      output: {
        kind: 'fields',
        fields: [
          { name: 'score', type: 'number', description: 'Samlet vurdering' },
          { name: 'summary', type: 'string', description: 'Kort oppsummering' },
        ],
      },
    },
  };
};

const boot = async () => {
  const keys = new InMemoryTenantApiKeys();
  const keyAuth = createAuthenticator({ apiKeys: keys });
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore({ ...p, models: plugins.models }),
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    authenticate: async (request) => {
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const person = principals[bearer];
      if (person) return { principal: person };
      const found = await keyAuth.authenticate(request);
      return (
        found && {
          principal: found.principal,
          ...(found.principal.confinedTo ? { externalUsers: true } : {}),
        }
      );
    },
  });
  for (const definition of [
    withForm('skjema'),
    klarsprak({ id: 'enkel' }),
    withForm('fremmed', other),
  ])
    expect((await platform.definitions.publish(definition, 'test', 'test', files)).ok).toBe(true);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, init: { as?: string; key?: string; body?: unknown; lang?: string }) =>
    app.request(path, {
      method: init.body === undefined && !path.startsWith('/tenants') ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'change-reason': 'Kobler til egen frontend',
        ...(init.as ? { authorization: `Bearer ${init.as}` } : {}),
        ...(init.key ? { 'x-api-key': init.key } : {}),
        ...(init.lang ? { 'accept-language': init.lang } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const serviceKey = async (service: string) =>
    (
      (await (
        await call(`/tenants/${digdir}/services/${service}/api-keys`, {
          as: 'kari',
          body: { name: 'Frontend' },
        })
      ).json()) as { key: string }
    ).key;
  const schemaOf = (id: string, init: Parameters<typeof call>[1]) =>
    call(`/v1/models/${id}/schema`, init);
  return { call, schemaOf, serviceKey };
};

const ajv = (schema: Json) => {
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'));
  return new Ajv({ unknownFormats: 'ignore' }).compile(rest);
};

describe('the schema of one service (/v1/models/{id}/schema)', () => {
  it('a service key sees the form schema of its own service', async () => {
    const { schemaOf, serviceKey } = await boot();
    const res = await schemaOf('skjema__default', { key: await serviceKey('skjema') });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; input: Json; output: Json };
    expect(body.id).toBe('skjema__default');
    expect(Object.keys((body.input.properties ?? {}) as Json)).toEqual([
      'ministry',
      'year',
      'themes',
      'remark',
    ]);
    expect(body.input.required).toEqual(['ministry', 'year']);
    expect(body.output).toMatchObject({ type: 'object', required: ['score', 'summary'] });
  });

  it('a service key cannot see the schema of another service or another tenant', async () => {
    const { schemaOf, serviceKey } = await boot();
    const key = await serviceKey('skjema');

    expect((await schemaOf('enkel__default', { key })).status).toBe(404);
    expect((await schemaOf('fremmed__default', { key })).status).toBe(404);
    expect((await schemaOf('skjema__default', {})).status).toBe(401);
  });

  it('a tenant key does not see the services of another tenant', async () => {
    const { schemaOf, call } = await boot();
    const created = (await (
      await call(`/tenants/${digdir}/api-keys`, { as: 'kari', body: { name: 'Tenant' } })
    ).json()) as { key: string };

    expect((await schemaOf('skjema__default', { key: created.key })).status).toBe(200);
    expect((await schemaOf('fremmed__default', { key: created.key })).status).toBe(404);
  });

  it('a service without a form gets an empty form and an answer output', async () => {
    const { schemaOf, serviceKey } = await boot();
    const body = (await (
      await schemaOf('enkel__default', { key: await serviceKey('enkel') })
    ).json()) as { input: Json; output: Json };

    expect(body.input.properties).toEqual({});
    expect(body.output).toMatchObject({ type: 'string', 'x-kind': 'answer' });
  });

  it('every property of the form and the output carries x-label in both languages', async () => {
    const { schemaOf, serviceKey } = await boot();
    const body = (await (
      await schemaOf('skjema__default', { key: await serviceKey('skjema') })
    ).json()) as { input: Json; output: Json };

    expect(missingLabels(body.input)).toEqual([]);
    expect(missingLabels(body.output)).toEqual([]);
    expect(body.input.properties).toMatchObject({
      year: { 'x-label': { nb: 'År', en: 'År' }, 'x-help': { nb: 'Året vurderingen gjelder' } },
      ministry: { 'x-widget': 'select', 'x-options': { enum: expect.any(Array) } },
      remark: { 'x-widget': 'textarea' },
      themes: { 'x-widget': 'multiselect' },
    });
  });

  it('Accept-Language resolves the labels to one language and no header keeps both', async () => {
    const { schemaOf, serviceKey } = await boot();
    const key = await serviceKey('skjema');
    const labelOf = async (lang?: string) => {
      const body = (await (
        await schemaOf('skjema__default', { key, ...(lang ? { lang } : {}) })
      ).json()) as {
        input: { 'x-label': unknown };
        output: { 'x-label': unknown };
      };
      return [body.input['x-label'], body.output['x-label']];
    };

    expect(await labelOf('en-GB,en;q=0.9')).toEqual(['Form', 'Result']);
    expect(await labelOf('nb-NO')).toEqual(['Skjema', 'Resultat']);
    expect(await labelOf()).toEqual([
      { nb: 'Skjema', en: 'Form' },
      { nb: 'Resultat', en: 'Result' },
    ]);
  });

  it('the form schema accepts and rejects the same input as the API validation', async () => {
    const { schemaOf, serviceKey, call } = await boot();
    const key = await serviceKey('skjema');
    const body = (await (await schemaOf('skjema__default', { key })).json()) as { input: Json };
    const validate = ajv(body.input);
    const inputs: Json[] = [
      { ministry: 'Kunnskapsdepartementet', year: 2025 },
      { ministry: 'Finansdepartementet', year: 2020, themes: ['digital', 'grønn'], remark: 'Ok' },
      { year: 2025 },
      { ministry: 'Kunnskapsdepartementet' },
      { ministry: 'Helsedepartementet', year: 2025 },
      { ministry: 'Kunnskapsdepartementet', year: 1500 },
      { ministry: 'Kunnskapsdepartementet', year: 2025, themes: ['ukjent'] },
    ];

    for (const input of inputs) {
      const byApi = checkInputFields(fields, input).ok;
      expect({ input, byJson: validate(input) }).toEqual({ input, byJson: byApi });
      const asked = await call('/v1/chat/completions', {
        key,
        body: { model: 'skjema__default', messages: [{ role: 'user', content: 'Vurder' }], input },
      });
      expect({ input, refused: asked.status === 400 }).toEqual({ input, refused: !byApi });
    }
  });
});

describe('the output shape of a table service', () => {
  it('describes columns and cells with labels in both languages', () => {
    const { output } = serviceSchemaOf({
      id: 'tabell__default',
      output: {
        kind: 'table',
        withSources: false,
        columns: [
          { key: 'mal', name: 'Mål', type: 'string', kind: 'document' },
          { key: 'grad', name: 'Grad', type: 'enum', kind: 'assessment', values: ['høy', 'lav'] },
        ],
      },
    }) as { output: Json };

    expect(missingLabels(output)).toEqual([]);
    expect(output['x-kind']).toBe('table');
  });
});
