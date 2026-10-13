import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  platformSettings,
  SettingsRegistry,
  validateDefinition,
  type StepFlowDefinition,
} from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { builtinBlocks, checkFlow } from '@genai/strategy-step-flow';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { recipesOf } from './recipes.js';
import { describeBlocks } from './step-blocks.js';

const tenant = '991825827';
const kari = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
} as Principal;

const boot = async () => {
  const platform = await createPlatform({
    settings: new SettingsRegistry(platformSettings),
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'https://modell.example.no/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/c-eu',
            endpoint: 'fake',
            deployment: 'c-eu',
            residency: 'eu',
            capabilities: ['stream', 'json-schema'],
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  return { platform, app };
};

const root = join(import.meta.dirname, '..', '..', '..');
const portalFixture = (...path: string[]) =>
  JSON.parse(readFileSync(join(root, 'apps', 'portal', 'src', ...path), 'utf8')) as unknown;

interface StepBlockSchema {
  ref: string;
  params: { required?: string[]; properties?: Record<string, unknown> };
}

describe('step blocks for the step flow editor', () => {
  it('lists every building block with the JSON schemas of its input, params and output', async () => {
    const { app } = await boot();

    const res = await app.request(`/tenants/${tenant}/step-flows/blocks`, {
      headers: { authorization: 'Bearer kari' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: StepBlockSchema[] };
    const table = body.blocks.find((b) => b.ref === 'table@1');
    expect(table?.params.required).toEqual(['columns']);
    expect(Object.keys(table?.params.properties ?? {})).toEqual([
      'title',
      'rows',
      'pair',
      'columns',
    ]);
    expect(body.blocks.map((b) => b.ref)).toEqual(builtinBlocks().refs());
    expect((await app.request(`/tenants/${tenant}/step-flows/blocks`)).status).toBe(401);
  });

  it('answers a missing login with 401 and an unreachable tenant with 404, both as problem+json', async () => {
    const { app } = await boot();

    const anonymous = await app.request(`/tenants/${tenant}/step-flows/blocks`);
    const elsewhere = await app.request('/tenants/974760673/step-flows/blocks', {
      headers: { authorization: 'Bearer kari' },
    });

    expect([anonymous.status, elsewhere.status]).toEqual([401, 404]);
    for (const res of [anonymous, elsewhere])
      expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('names every block in bokmål and English, the same as the building-block catalogue', () => {
    const blocks = describeBlocks(builtinBlocks());
    const model = blocks.find((b) => b.name === 'model');
    const tool = blocks.find((b) => b.name === 'tool');

    expect(model?.title).toEqual({ nb: 'Spør språkmodellen', en: 'Ask the language model' });
    expect(tool?.title).toEqual({ nb: 'Kall et verktøy', en: 'Call a tool' });
    expect(blocks.every((b) => b.title.nb && b.title.en && b.summary.nb && b.summary.en)).toBe(
      true,
    );
  });

  it('labels the params of a block in bokmål and English so a client shows no names of its own', () => {
    const model = describeBlocks(builtinBlocks()).find((b) => b.name === 'model');
    const temperature = (model?.params.properties as Record<string, Record<string, unknown>>)
      .temperature;

    expect(temperature?.['x-label']).toEqual({ nb: 'Temperatur', en: 'Temperature' });
  });

  it('matches the snapshot the portal mock serves', () => {
    expect(describeBlocks(builtinBlocks())).toEqual(portalFixture('mock', 'step-blocks.json'));
  });

  it('keeps the portal copy of the måloppnåelse example in step with the example', () => {
    const example = parseYaml(
      readFileSync(
        join(root, 'packages', 'definitions', 'examples', 'maloppnaelse-flyt.yaml'),
        'utf8',
      ),
    ) as unknown;

    expect(portalFixture('screens', 'stepflows', 'fixtures', 'maloppnaelse-flyt.json')).toEqual(
      example,
    );
  });

  it('validates and checks the flow the editor writes', async () => {
    const { platform } = await boot();
    const definition = portalFixture(
      'screens',
      'stepflows',
      'fixtures',
      'editor-built-flow.json',
    ) as StepFlowDefinition;
    const validated = validateDefinition(definition, platform.plugins);

    expect(validated.ok ? [] : validated.errors).toEqual([]);
    if (validated.ok)
      expect(checkFlow(validated.definition as StepFlowDefinition, builtinBlocks())).toEqual([]);
    expect(definition.spec.steps[1]).toMatchObject({
      onError: 'skip',
      forEach: { in: 'steps.finn.documents', as: 'dok' },
    });
    expect(definition.spec.steps[2]).toMatchObject({
      block: 'table@1',
      input: { items: '{{steps.hver}}', documents: '{{steps.finn.documents}}' },
    });
  });
});

describe('a service that runs a step flow', () => {
  const flow = {
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id: 'aar-flyt', name: 'Årsflyt' },
    spec: {
      purpose: 'Skriver året',
      input: { aar: 'tekst' },
      steps: [
        { id: 'skriv', block: 'template@1', input: { text: 'År: {{input.aar}} {{input.query}}' } },
      ],
    },
  };
  const service = (fieldId: string) => ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id: 'arsrapport', name: 'Årsrapport' },
    spec: {
      purpose: 'Oppsummer et år',
      riskClass: 'minimal',
      input: { accepts: ['text/plain'], fields: [{ id: fieldId, label: 'År', kind: 'year' }] },
      output: { kind: 'answer' },
      strategy: { id: 'step-flow', version: 1, config: { flow: 'aar-flyt@1' } },
      model: { primary: 'fake/c-eu', residency: 'eu' },
    },
  });
  it('refuses to publish when the flow reads an input no form field provides', async () => {
    const { platform } = await boot();
    const publish = (definition: unknown) =>
      platform.definitions.publish(definition, 'kari', 'Test', {});
    expect((await publish(flow)).ok).toBe(true);

    const wrong = await publish(service('ar'));
    expect(wrong.ok ? [] : wrong.errors).toEqual([
      {
        path: 'spec.input.fields',
        message:
          'the step flow aar-flyt@1 reads input.aar, but no input field has the id aar (fields: ar)',
      },
    ]);
    expect((await publish(service('aar'))).ok).toBe(true);
  });

  it('a variant can run its own step flow while the service keeps its way of working', async () => {
    const { platform } = await boot();
    const publish = (definition: unknown) =>
      platform.definitions.publish(definition, 'kari', 'Test', {});
    const base = service('aar');
    const withVariant = {
      ...base,
      spec: {
        ...base.spec,
        strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
        variants: [
          { id: 'default' },
          {
            id: 'aar',
            title: { nb: 'Året først', en: 'Year first' },
            strategy: { id: 'step-flow', version: 1, config: { flow: 'aar-flyt@1' } },
          },
        ],
      },
    };
    expect((await publish(flow)).ok).toBe(true);
    const published = await publish(withVariant);
    expect(published.ok ? [] : published.errors).toEqual([]);

    const strategies = (await platform.definitions.capabilities()).map((c) => [
      c.variant,
      c.capability.strategy.id,
    ]);
    const served = await platform.kernel.invoke(kari, `${tenant}/arsrapport/aar`, {
      data: { query: 'Hei', aar: '2025', history: [] },
    });
    const drafted = await platform.drafts.run({
      principal: kari,
      tenant,
      definition: withVariant,
      parts: [{ kind: 'text', text: 'Hei' }],
      input: { aar: '2025' },
      origin: 'builder',
      variant: 'aar',
    });

    expect(strategies).toEqual([
      ['default', 'single-call'],
      ['aar', 'step-flow'],
    ]);
    expect(JSON.stringify(await served.result)).toContain('År: 2025 Hei');
    expect(drafted.ok && drafted.answer).toContain('År: 2025');
  });
});

describe('a service with a table output', () => {
  const flow = {
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id: 'tabell-flyt', name: 'Tabellflyt' },
    spec: {
      purpose: 'Lager en tabell',
      steps: [
        {
          id: 'tabell',
          block: 'table@1',
          input: { items: '{{input.parts}}' },
          params: { columns: [{ key: 'goal', label: 'Mål', from: 'goal' }] },
        },
      ],
    },
  };
  const service = (key: string) => ({
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id: 'maltabell', name: 'Måltabell' },
    spec: {
      purpose: 'Lag en tabell over mål',
      riskClass: 'minimal',
      input: { accepts: ['text/plain'] },
      output: { kind: 'table', rowKey: key, columns: [{ key, name: 'Mål' }] },
      strategy: { id: 'step-flow', version: 1, config: { flow: 'tabell-flyt@1' } },
      model: { primary: 'fake/c-eu', residency: 'eu' },
    },
  });
  it('refuses columns the step flow does not make', async () => {
    const { platform } = await boot();
    const publish = (definition: unknown) =>
      platform.definitions.publish(definition, 'kari', 'Test', {});
    expect((await publish(flow)).ok).toBe(true);

    const wrong = await publish(service('goals'));
    expect(wrong.ok ? [] : wrong.errors).toEqual([
      {
        path: 'spec.output.columns',
        message: 'the step flow tabell-flyt@1 makes no column goals (columns: goal)',
      },
    ]);
    expect((await publish(service('goal'))).ok).toBe(true);
  });
});

describe('recipes', () => {
  const flowsDir = join(root, 'apps', 'api', 'config', 'local', 'flows');
  const publishShipped = async (platform: Awaited<ReturnType<typeof boot>>['platform']) => {
    for (const file of readdirSync(flowsDir).filter((f) => f.endsWith('.yaml'))) {
      const published = await platform.definitions.publish(
        parseYaml(readFileSync(join(flowsDir, file), 'utf8')),
        'kari',
        'Oppskrifter',
        {},
      );
      expect(published.ok ? [] : published.errors, file).toEqual([]);
    }
  };

  it('lists only the published step flows marked as recipes, with their plain settings and steps', async () => {
    const { app, platform } = await boot();
    await publishShipped(platform);

    const res = await app.request(`/tenants/${tenant}/step-flows/recipes`, {
      headers: { authorization: 'Bearer kari' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recipes: {
        ref: string;
        settings: { properties: Record<string, unknown> };
        steps: unknown[];
      }[];
    };
    expect(body.recipes.map((r) => r.ref)).toEqual([
      'compare-documents@1',
      'answer-briefly-with-sources@1',
      'ordered-sources-answer@1',
    ]);
    expect(Object.keys(body.recipes[2]?.settings.properties ?? {})).toEqual([
      'documentTypes',
      'answerLength',
      'documentField',
    ]);
    expect(body.recipes.every((r) => r.steps.length > 0)).toBe(true);
    expect((await app.request(`/tenants/${tenant}/step-flows/recipes`)).status).toBe(401);
  });

  it('matches the recipes the portal mock serves', async () => {
    const { platform } = await boot();
    await publishShipped(platform);

    expect(await recipesOf(platform.definitions, tenant)).toEqual(
      portalFixture('mock', 'recipes.json'),
    );
  });
});
