import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  flowUsesOf,
  InMemoryDefinitionStore,
  platformSettings,
  resolveSetting,
  resolveSettings,
  strategyKey,
  toCapabilities,
  validateDefinition,
  validateService,
  validateYaml,
  versionedRef,
  type DatasetLocation,
  type PluginSchemas,
  type ServiceDefinition,
  type SettingDefinition,
} from './index.js';

const examples = join(import.meta.dirname, '..', 'examples');
const exampleText = (name: string) => readFileSync(join(examples, name), 'utf8');
const example = (name: string) => parseYaml(exampleText(name)) as Record<string, unknown>;
const promptFiles = Object.fromEntries(
  readdirSync(join(examples, 'prompts')).map((f) => [
    `prompts/${f}`,
    readFileSync(join(examples, 'prompts', f), 'utf8'),
  ]),
);
const filesFor = (definition: unknown) =>
  Object.fromEntries(
    Object.entries(promptFiles).filter(([name]) => JSON.stringify(definition).includes(name)),
  );

const validateServiceOrThrow = (...args: Parameters<typeof validateService>) => {
  const result = validateService(...args);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.definition;
};

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    [
      strategyKey('agent-loop', 1),
      z.strictObject({
        instructions: z.string(),
        budget: z.strictObject({
          searches: z.number().int(),
          reads: z.number().int(),
          readChars: z.number().int(),
        }),
      }),
    ],
    [
      strategyKey('single-call', 1),
      z.strictObject({ instructions: z.string(), examples: z.array(z.string()).optional() }),
    ],
    [strategyKey('step-flow', 1), z.strictObject({ flow: versionedRef })],
    [
      strategyKey('rag-single-shot', 1),
      z.strictObject({ generate: z.boolean().optional(), topK: z.number().int().optional() }),
    ],
    [
      strategyKey('remote-agent', 1),
      z.strictObject({
        endpoint: z.looseObject({ url: z.string(), residency: z.enum(['norway', 'eu', 'global']) }),
        send: z.unknown().optional(),
      }),
    ],
  ]),
  tools: new Map<string, z.ZodType>([
    ['rag@1', z.strictObject({})],
    ['mcp-client@1', z.strictObject({ connection: z.string() })],
    ['digdir.klarsprak@2.3', z.strictObject({})],
    ['saker.sok@1', z.strictObject({})],
  ]),
  guardrails: new Map<string, z.ZodType>([
    ['pii-before-model', z.strictObject({ categories: z.array(z.string()).min(1) })],
    ['pii-out-of-log', z.strictObject({ categories: z.array(z.string()).min(1) })],
    ['require-sources', z.literal(true)],
    ['language', z.strictObject({ mode: z.enum(['same', 'nb', 'nn']) })],
    ['refuse-topics', z.array(z.string())],
    ['human-approval', z.literal(true)],
  ]),
  blocks: new Set([
    'classify@1',
    'route@1',
    'documents@1',
    'read-document@1',
    'extract@1',
    'table@1',
    'tool@1',
    'model@1',
  ]),
  retrieval: z.strictObject({ maxPerDocument: z.number().int().positive().optional() }),
  rerankers: new Set(['colbert']),
  strategyResidency: (id, config) =>
    id === strategyKey('remote-agent', 1)
      ? (config as { endpoint: { residency: 'norway' | 'eu' | 'global' } }).endpoint.residency
      : undefined,
  models: new Map([
    ['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream', 'tools', 'json-schema'] }],
    ['aivar/borealis', { residency: 'norway', capabilities: ['stream', 'tools'] }],
    ['aivar/tiny', { residency: 'norway', capabilities: ['stream'] }],
    [
      'foundry/claude-opus',
      { residency: 'global', capabilities: ['stream', 'tools', 'reasoning'] },
    ],
  ]),
};

const withSpec = (patch: Record<string, unknown>) => {
  const base = example('kunnskapsassistenten.yaml');
  return { ...base, spec: { ...(base.spec as object), ...patch } };
};

const errorsOf = (input: unknown) => {
  const result = validateDefinition(input, plugins);
  return result.ok ? [] : result.errors;
};

describe('service definitions', () => {
  it.each(readdirSync(examples).filter((f) => f.endsWith('.yaml')))(
    'validates the example %s',
    (file) => {
      const result = validateYaml(exampleText(file), plugins);
      expect(result.ok ? [] : result.errors).toEqual([]);
    },
  );

  it('refuses keys the schema does not know', () => {
    expect(errorsOf(withSpec({ agents: [] }))).toEqual([
      expect.objectContaining({ path: 'spec', message: expect.stringMatching(/agents/) }),
    ]);
  });

  it("validates the strategy's config with the strategy's own schema", () => {
    const errors = errorsOf(
      withSpec({
        strategy: {
          id: 'agent-loop',
          version: 1,
          config: { instructions: 'x', budget: { searches: 'many' } },
        },
      }),
    );
    expect(errors.map((e) => e.path)).toContain('spec.strategy.config.budget.searches');
  });

  it('refuses an unknown strategy, an unknown tool version and an unknown guardrail', () => {
    const errors = errorsOf(
      withSpec({
        strategy: { id: 'telepathy', version: 1, config: {} },
        tools: ['digdir.klarsprak@9.9'],
        guardrails: { 'mind-reading': true },
      }),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'spec.strategy',
      'spec.tools[0]',
      'spec.guardrails.mind-reading',
    ]);
  });

  it('requires tools to be pinned to a version', () => {
    expect(errorsOf(withSpec({ tools: ['digdir.klarsprak'] })).map((e) => e.path)).toEqual([
      'spec.tools[0]',
    ]);
  });

  it("validates each guardrail's settings with its own schema", () => {
    const errors = errorsOf(withSpec({ guardrails: { language: { mode: 'klingon' } } }));
    expect(errors.map((e) => e.path)).toEqual(['spec.guardrails.language.mode']);
  });

  it('refuses high-risk services and services for the public until they are offered', () => {
    const errors = errorsOf(withSpec({ riskClass: 'high', audience: ['public'] }));
    expect(errors.map((e) => e.path)).toEqual(['spec.riskClass', 'spec.audience']);
  });

  it('refuses a model outside the catalog, and a model that runs outside the service residency', () => {
    const errors = errorsOf(
      withSpec({
        model: { primary: 'foundry/claude-opus', fallback: 'nowhere/x', residency: 'norway' },
      }),
    );
    expect(errors).toEqual([
      {
        path: 'spec.model.primary',
        message: 'model foundry/claude-opus runs in global, outside norway',
      },
      { path: 'spec.model.fallback', message: 'unknown model nowhere/x' },
    ]);
  });

  it('refuses a dataset stored or embedded outside the service residency, and content traces sent there', () => {
    const located: PluginSchemas = {
      ...plugins,
      datasetLocation: (dataset) =>
        ({
          'digdir/kudos': { stored: 'norway' },
          'nav/eu-lagret': {
            stored: 'eu',
            embedding: { model: 'foundry/text-embedding-3-small', residency: 'global' },
          },
          'nav/norsk': {
            stored: 'norway',
            embedding: { model: 'nav/norsk-embed', residency: 'norway' },
          },
        })[dataset] as DatasetLocation | undefined,
      traceSink: () => ({ residency: 'global', content: true }),
    };
    const service = (residency: string, datasets: string[]) =>
      withSpec({
        model: { primary: 'foundry/gpt-4o', residency },
        knowledge: { datasets: datasets.map((dataset) => ({ dataset })) },
      });
    const result = validateDefinition(
      service('norway', ['digdir/kudos', 'nav/eu-lagret', 'nav/norsk']),
      located,
    );

    expect(result.ok ? [] : result.errors).toEqual([
      {
        path: 'spec.knowledge.datasets[1].dataset',
        message:
          'Datasettet nav/eu-lagret lagres i EU/EØS. Tjenesten krever at data behandles i Norge.',
      },
      {
        path: 'spec.knowledge.datasets[1].dataset',
        message:
          'Datasettet nav/eu-lagret søkes med embeddingmodellen foundry/text-embedding-3-small, som behandler data utenfor EU/EØS. Tjenesten krever at data behandles i Norge.',
      },
      {
        path: 'spec.model.residency',
        message:
          'Sporingen sender innholdet i samtalene til en mottaker utenfor EU/EØS. Tjenesten krever at data behandles i Norge.',
      },
    ]);
    expect(
      validateDefinition(service('norway', ['nav/norsk']), {
        ...located,
        traceSink: () => ({ residency: 'global', content: false }),
      }).ok,
    ).toBe(true);
  });

  it('refuses a reranker that processes data outside the residency the service requires', () => {
    const service = (residency: string) =>
      withSpec({
        model: { primary: 'foundry/gpt-4o', residency },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }], reranker: 'colbert' },
      });
    const outsideEu = { ...plugins, rerankerResidency: () => 'global' as const };

    expect(validateDefinition(service('eu'), outsideEu)).toMatchObject({
      ok: false,
      errors: [
        {
          path: 'spec.knowledge.reranker',
          message:
            'Omrangeringen colbert behandler data utenfor EU/EØS. Tjenesten krever at data behandles i EU/EØS.',
        },
      ],
    });
    expect(validateDefinition(service('global'), outsideEu).ok).toBe(true);
  });

  it('refuses a remote agent that declares a wider residency than the service requires', () => {
    const service = (endpoint: string, residency: string) =>
      withSpec({
        model: { primary: 'foundry/gpt-4o', residency },
        strategy: {
          id: 'remote-agent',
          version: 1,
          config: { endpoint: { url: 'https://agent.example.no/turn', residency: endpoint } },
        },
      });

    expect(errorsOf(service('global', 'eu'))).toEqual([
      {
        path: 'spec.strategy.config.endpoint.residency',
        message:
          'Den eksterne agenten behandler data utenfor EU/EØS. Tjenesten krever at data behandles i EU/EØS.',
      },
    ]);
    expect(errorsOf(service('eu', 'eu'))).toEqual([]);
    expect(errorsOf(service('norway', 'eu'))).toEqual([]);
  });

  it('accepts a global model for a service that allows global residency', () => {
    expect(
      errorsOf(withSpec({ model: { primary: 'foundry/claude-opus', residency: 'global' } })),
    ).toEqual([]);
  });

  it('checks retrieval settings with the retrieval schema and refuses an unknown reranker', () => {
    const knowledge = (extra: Record<string, unknown>) =>
      withSpec({ knowledge: { datasets: [{ dataset: 'digdir/kudos' }], ...extra } });

    expect(errorsOf(knowledge({ retrieval: { maxPerDocument: 0 } })).map((e) => e.path)).toEqual([
      'spec.knowledge.retrieval.maxPerDocument',
    ]);
    expect(
      validateDefinition(withSpec({ knowledge: { datasets: [{ dataset: 'nav/x' }] } }), {
        ...plugins,
        datasets: new Set(['digdir/kudos']),
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ path: 'spec.knowledge.datasets[0].dataset', message: 'unknown dataset nav/x' }],
    });
    expect(errorsOf(knowledge({ reranker: 'cohere' }))).toEqual([
      { path: 'spec.knowledge.reranker', message: 'unknown reranker cohere' },
    ]);
  });

  it('refuses a model that lacks what the service strategy needs', () => {
    const strict = {
      ...plugins,
      modelNeeds: new Map([[strategyKey('agent-loop', 1), ['tools', 'json-schema']]]),
    };
    const result = validateDefinition(
      withSpec({ tools: [], model: { primary: 'aivar/tiny', residency: 'norway' } }),
      strict,
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          path: 'spec.model.primary',
          message: 'model aivar/tiny lacks tools, json-schema, which agent-loop needs',
        },
      ],
    });
  });

  it('refuses a model that cannot call tools for a service that uses tools', () => {
    expect(errorsOf(withSpec({ model: { primary: 'aivar/tiny', residency: 'norway' } }))).toEqual([
      { path: 'spec.model.primary', message: 'model aivar/tiny cannot call tools' },
    ]);
    expect(
      errorsOf(withSpec({ tools: [], model: { primary: 'aivar/tiny', residency: 'norway' } })),
    ).toEqual([]);
  });

  it('refuses input types that are not MIME types', () => {
    expect(errorsOf(withSpec({ input: { accepts: ['tekst'] } })).map((e) => e.path)).toEqual([
      'spec.input.accepts[0]',
    ]);
  });

  it('compiles aliases as extra public names and refuses a name used twice', () => {
    const result = validateService(
      withSpec({ variants: [{ id: 'default', aliases: ['ka'] }] }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    expect(toCapabilities(result.definition, 1)[0]).toMatchObject({ aliases: ['ka'] });
    expect(
      errorsOf(
        withSpec({
          variants: [
            { id: 'a', aliases: ['ka'] },
            { id: 'b', aliases: ['ka'] },
          ],
        }),
      ).map((e) => e.message),
    ).toContain('public name ka is used twice');
  });

  it('takes an alias as a public name or as {name}, and refuses alias titles, descriptions and defaults', () => {
    const result = validateService(
      withSpec({ variants: [{ id: 'default', aliases: ['ka', { name: 'ka-chat' }] }] }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    expect(toCapabilities(result.definition, 1)[0]).toMatchObject({ aliases: ['ka', 'ka-chat'] });
    for (const extra of [{ title: 'KA' }, { description: 'Kort' }, { default: true }])
      expect(
        errorsOf(withSpec({ variants: [{ id: 'default', aliases: [{ name: 'ka', ...extra }] }] })),
      ).not.toEqual([]);
  });

  it('takes sample questions as plain text or in both bokmål and English, never in only one of them', () => {
    expect(
      errorsOf(
        withSpec({
          exampleQuestions: ['Hei', { nb: 'Hva er fristen?', en: 'What is the deadline?' }],
        }),
      ),
    ).toEqual([]);
    expect(errorsOf(withSpec({ exampleQuestions: [{ nb: 'Hva er fristen?' }] }))).not.toEqual([]);
  });

  it('refuses the same public name on two variants', () => {
    const errors = errorsOf(
      withSpec({
        variants: [{ id: 'default' }, { id: 'quick', aliases: ['kunnskapsassistenten__default'] }],
      }),
    );
    expect(errors.map((e) => e.message)).toEqual([
      'public name kunnskapsassistenten__default is used twice',
    ]);
  });

  it('checks a mode model like the service model', () => {
    expect(
      errorsOf(
        withSpec({
          variants: [{ id: 'default' }, { id: 'open', model: 'nowhere/model' }],
        }),
      ),
    ).toEqual([{ path: 'spec.variants[1].model', message: 'unknown model nowhere/model' }]);
  });

  it('checks a mode strategy and its config with that strategy schema', () => {
    const mode = (strategy: unknown) =>
      errorsOf(withSpec({ variants: [{ id: 'default' }, { id: 'search', strategy }] }));
    expect(mode({ id: 'rag-single-shot', version: 1, config: { generate: false } })).toEqual([]);
    expect(mode({ id: 'rag-single-shot', version: 1, config: { generate: 'no' } })).toEqual([
      expect.objectContaining({ path: 'spec.variants[1].strategy.config.generate' }),
    ]);
    expect(mode({ id: 'nowhere', version: 1, config: {} })).toEqual([
      { path: 'spec.variants[1].strategy', message: 'unknown strategy nowhere@1' },
    ]);
  });

  it('checks mode overrides against the strategy the mode switches to', () => {
    const strategy = { id: 'rag-single-shot', version: 1, config: { generate: false } };
    expect(
      errorsOf(
        withSpec({ variants: [{ id: 'default' }, { id: 's', strategy, overrides: { topK: 5 } }] }),
      ),
    ).toEqual([]);
    expect(
      errorsOf(
        withSpec({
          variants: [{ id: 'default' }, { id: 's', strategy, overrides: { budget: {} } }],
        }),
      ).map((e) => e.path),
    ).toEqual(['spec.variants[1].overrides']);
  });

  it('checks the models of a mode against the needs of the strategy the mode switches to', () => {
    const needs = { ...plugins, modelNeeds: new Map([['single-call@1', ['json-schema']]]) };
    const result = validateDefinition(
      withSpec({
        variants: [
          { id: 'default' },
          {
            id: 'short',
            strategy: { id: 'single-call', version: 1, config: { instructions: 'x' } },
          },
        ],
      }),
      needs,
    );
    expect(result.ok ? [] : result.errors).toEqual([
      {
        path: 'spec.variants[1].strategy',
        message: 'model aivar/borealis lacks json-schema, which single-call needs',
      },
    ]);
  });

  it('lets a service run by an external agent leave out the model, while every other strategy must name one', () => {
    const external = example('ekstern-agent.yaml');
    const spec = external.spec as { model: Record<string, unknown> };
    const withoutModel = { ...external, spec: { ...spec, model: { residency: 'eu' } } };

    const result = validateService(withoutModel, plugins);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(toCapabilities(result.definition, 1)[0]?.capability.grants).not.toContainEqual(
      expect.objectContaining({ port: 'model' }),
    );
    expect(errorsOf(withSpec({ model: { residency: 'norway' } }))).toEqual([
      {
        path: 'spec.model.primary',
        message: 'a model is required unless the strategy is an external agent',
      },
    ]);
  });

  it('checks the residency of an external agent a mode switches to', () => {
    const remote = {
      id: 'remote-agent',
      version: 1,
      config: { endpoint: { url: 'https://agent.example', residency: 'global' } },
    };
    expect(
      errorsOf(withSpec({ variants: [{ id: 'default' }, { id: 'ext', strategy: remote }] })).map(
        (e) => e.path,
      ),
    ).toEqual(['spec.variants[1].strategy.config.endpoint.residency']);
  });

  it('a variant can run its own step flow', () => {
    const flow = { id: 'step-flow', version: 1, config: { flow: 'arsrapport-forst@1' } };
    const result = validateService(
      withSpec({ variants: [{ id: 'default' }, { id: 'arsrapport-forst', strategy: flow }] }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const [service, variant] = toCapabilities(result.definition, 1);

    expect(service?.capability.strategy).toEqual({ id: 'agent-loop', version: '1' });
    expect(variant?.capability.strategy).toEqual({ id: 'step-flow', version: '1' });
    expect((variant?.capability.config as { strategy: unknown }).strategy).toEqual({
      flow: 'arsrapport-forst@1',
    });
    expect(flowUsesOf(result.definition.spec)).toEqual([
      {
        flow: 'arsrapport-forst@1',
        path: 'spec.variants[1].strategy.config.flow',
        variant: 'arsrapport-forst',
      },
    ]);
  });

  it("a variant without its own way of working uses the service's", () => {
    const result = validateService(
      withSpec({
        strategy: { id: 'step-flow', version: 1, config: { flow: 'basic-rag@1' } },
        variants: [{ id: 'default' }, { id: 'rask', overrides: { flow: 'fast-rag@1' } }],
      }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const [service, variant] = toCapabilities(result.definition, 1);

    expect(variant?.capability.strategy).toEqual(service?.capability.strategy);
    expect((service?.capability.config as { strategy: unknown }).strategy).toEqual({
      flow: 'basic-rag@1',
    });
    expect((variant?.capability.config as { strategy: unknown }).strategy).toEqual({
      flow: 'fast-rag@1',
    });
    expect(flowUsesOf(result.definition.spec).map((u) => u.path)).toEqual([
      'spec.strategy.config.flow',
      'spec.variants[1].overrides.flow',
    ]);
  });

  it('refuses a variant that switches away from a step flow for a table output', () => {
    expect(
      errorsOf(
        withSpec({
          output: { kind: 'table' },
          strategy: { id: 'step-flow', version: 1, config: { flow: 'a@1' } },
          variants: [
            { id: 'default' },
            {
              id: 'chat',
              strategy: { id: 'single-call', version: 1, config: { instructions: 'x' } },
            },
          ],
        }),
      ),
    ).toEqual([
      { path: 'spec.variants[1].strategy.id', message: 'only a step flow can produce a table' },
    ]);
  });

  it('refuses a non-chat first variant, since the first variant is the default', () => {
    expect(
      errorsOf(withSpec({ variants: [{ id: 'search', chat: false }, { id: 'default' }] })),
    ).toEqual([
      {
        path: 'spec.variants[0].chat',
        message: 'the first variant is the default and must be a chat variant',
      },
    ]);
  });

  it('refuses a fields output without fields', () => {
    expect(errorsOf(withSpec({ output: { kind: 'fields' } })).map((e) => e.path)).toEqual([
      'spec.output.fields',
    ]);
  });

  it('refuses required sources on a fields output, which has no answer to cite', () => {
    const fields = {
      kind: 'fields',
      fields: [{ name: 'amount', type: 'number', description: 'Beløp', required: false }],
    };
    expect(errorsOf(withSpec({ output: fields, guardrails: { 'require-sources': true } }))).toEqual(
      [
        {
          path: 'spec.guardrails.require-sources',
          message: 'an output of kind fields has no answer to cite, so it cannot require sources',
        },
      ],
    );
    expect(errorsOf(withSpec({ output: fields, guardrails: {} }))).toEqual([]);
  });

  it('accepts a table output only from a step flow', () => {
    expect(errorsOf(withSpec({ output: { kind: 'table' } })).map((e) => e.message)).toEqual([
      'only a step flow can produce a table',
    ]);
    expect(
      errorsOf(
        withSpec({
          output: { kind: 'table' },
          strategy: { id: 'step-flow', version: 1, config: { flow: 'maloppnaelse-flyt@1' } },
        }),
      ),
    ).toEqual([]);
  });

  it('checks the columns of a table output', () => {
    const flow = { id: 'step-flow', version: 1, config: { flow: 'maloppnaelse-flyt@1' } };
    const table = (output: Record<string, unknown>) =>
      errorsOf(withSpec({ output: { kind: 'table', ...output }, strategy: flow }));
    expect(
      table({
        rowKey: 'goal',
        columns: [
          { key: 'goal', name: 'Mål' },
          {
            key: 'assessment',
            name: 'Vurdering',
            type: 'enum',
            kind: 'assessment',
            values: ['Nådd'],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      table({
        rowKey: 'missing',
        columns: [
          { key: 'goal', name: 'Mål' },
          { key: 'goal', name: 'Mål igjen', type: 'enum' },
        ],
      }).map((e) => e.path),
    ).toEqual([
      'spec.output.columns[1].key',
      'spec.output.columns[1].values',
      'spec.output.rowKey',
    ]);
    expect(
      errorsOf(withSpec({ output: { kind: 'answer', columns: [{ key: 'a', name: 'A' }] } })).map(
        (e) => e.message,
      ),
    ).toEqual(['only a table output takes columns']);
  });

  it('refuses a tenant that is not an organisation number', () => {
    const input = {
      ...example('kunnskapsassistenten.yaml'),
      metadata: { tenant: 'digdir', id: 'ka' },
    };
    expect(errorsOf(input).map((e) => e.path)).toEqual(['metadata.tenant']);
  });
});

describe('step flows', () => {
  const flow = (steps: unknown[]) => ({
    ...example('postsortering-flyt.yaml'),
    spec: { purpose: 'test', steps },
  });

  it('refuses a step with no action or two actions', () => {
    const errors = errorsOf(flow([{ id: 'a' }, { id: 'b', block: 'classify@1', subflow: 'x@1' }]));
    expect(errors.map((e) => e.path)).toEqual(['spec.steps[0]', 'spec.steps[1]']);
  });

  it('refuses a repeat without a maximum, and use-default without a default', () => {
    const errors = errorsOf(
      flow([
        { id: 'loop', repeat: { until: 'done', steps: [{ id: 'x', block: 'classify@1' }] } },
        { id: 'y', block: 'route@1', onError: 'use-default' },
      ]),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'spec.steps[0].repeat.max',
      'spec.steps[1].default',
    ]);
  });

  it('refuses unknown building blocks and duplicate step ids, also inside branches', () => {
    const errors = errorsOf(
      flow([
        { id: 'a', block: 'classify@1' },
        {
          id: 'b',
          switchOn: 'a.label',
          cases: [{ when: 'x', steps: [{ id: 'a', block: 'teleport@1' }] }],
        },
      ]),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'spec.steps[1].cases[0].steps[0].id',
      'spec.steps[1].cases[0].steps[0].block',
    ]);
  });
});

describe('compiling a service into capabilities', () => {
  it('carries per-entry-point call override allowlists to the capability and refuses unknown settings in them', () => {
    const withLists = { ...plugins, settings: platformSettings };
    const result = validateService(
      withSpec({ callOverrides: { mcp: ['retrieval.*'], openai: ['rag.topK'] } }),
      withLists,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const config = toCapabilities(result.definition, 1)[0]?.capability.config as {
      callOverrides?: unknown;
    };
    expect(config.callOverrides).toEqual({
      mcp: ['retrieval.*'],
      openai: ['rag.topK'],
    });
    expect(
      toCapabilities(validateServiceOrThrow(withSpec({}), withLists), 1)[0]?.capability.config,
    ).not.toHaveProperty('callOverrides');

    const refused = validateService(withSpec({ callOverrides: { a2a: ['nope.key'] } }), withLists);
    expect(refused).toMatchObject({
      ok: false,
      errors: [{ path: 'spec.callOverrides.a2a[0]', message: 'unknown setting nope.key' }],
    });
  });

  it('compiles a mode with its own strategy, its config with overrides, and marks a non-chat mode', () => {
    const result = validateService(
      withSpec({
        variants: [
          { id: 'default' },
          {
            id: 'retrieve-only',
            title: { nb: 'Bare søk', en: 'Search only' },
            chat: false,
            strategy: { id: 'rag-single-shot', version: 1, config: { generate: false } },
            overrides: { topK: 5 },
          },
        ],
      }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const [answer, search] = toCapabilities(result.definition, 1);

    expect(answer?.capability.strategy).toEqual({ id: 'agent-loop', version: '1' });
    expect(answer?.chat).toBeUndefined();
    expect(search?.capability.strategy).toEqual({ id: 'rag-single-shot', version: '1' });
    expect(search?.capability.config).toMatchObject({ strategy: { generate: false, topK: 5 } });
    expect(search?.chat).toBe(false);
    expect(search?.serviceName).toBe('Kunnskapsassistenten');
    expect(search?.capability.grants).toEqual(answer?.capability.grants);
  });

  it('makes one capability per variant with a public name, keeps aliases, and grants only what is declared', () => {
    const result = validateService(example('kunnskapsassistenten.yaml'), plugins);
    if (!result.ok) throw new Error('example does not validate');

    const compiled = toCapabilities(result.definition, 3);

    expect(compiled.map((c) => [c.capability.descriptor.id, c.publicName, c.aliases])).toEqual([
      ['991825827/kunnskapsassistenten/default', 'kunnskapsassistenten__default', ['ka']],
      [
        '991825827/kunnskapsassistenten/retrieve-only',
        'kunnskapsassistenten__retrieve-only',
        ['ka-retrieve-only'],
      ],
    ]);
    expect(compiled[0]?.capability.descriptor.title).toBe('Kunnskapsassistenten');
    expect(compiled[0]?.capability.grants.map((g) => `${g.port}:${g.ref.id}`)).toEqual([
      'knowledge:digdir/kudos',
      'tools:rag@1',
      'rerank:colbert',
      'model:foundry/gpt-4o',
      'model:aivar/borealis',
    ]);
    expect(compiled[0]?.capability.config).toMatchObject({
      knowledge: {
        datasets: [{ dataset: 'digdir/kudos' }],
        reranker: 'colbert',
        retrieval: { maxPerDocument: 10 },
      },
      tools: ['rag@1'],
    });
  });

  it('runs a mode on its own model and grants that model instead of the service model', () => {
    const result = validateService(
      withSpec({ variants: [{ id: 'default' }, { id: 'borealis', model: 'aivar/borealis' }] }),
      plugins,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    const [standard, borealis] = toCapabilities(result.definition, 1);

    expect((standard?.capability.config as { model: { primary: string } }).model.primary).toBe(
      'foundry/gpt-4o',
    );
    expect((borealis?.capability.config as { model: { primary: string } }).model.primary).toBe(
      'aivar/borealis',
    );
    expect(
      borealis?.capability.grants.filter((g) => g.port === 'model').map((g) => g.ref.id),
    ).not.toContain('foundry/gpt-4o');
  });

  it('shares a capability with every tenant when the service says so', () => {
    const result = validateService(example('klarsprak.yaml'), plugins);
    if (!result.ok) throw new Error('example does not validate');

    expect(toCapabilities(result.definition, 1)[0]?.capability.descriptor.availableTo).toBe('*');
  });
});

describe('definition store', () => {
  it('numbers versions, keeps published versions unchanged, and resolves public names and aliases', async () => {
    const store = new InMemoryDefinitionStore(plugins, () => new Date('2026-10-06T08:00:00Z'));
    const definition = example('kunnskapsassistenten.yaml');

    const first = await store.publish(definition, 'kari', 'første versjon', filesFor(definition));
    (definition.spec as { purpose: string }).purpose = 'endret etterpå';
    const second = await store.publish(
      withSpec({ purpose: 'Ny formålstekst' }),
      'kari',
      'ny tekst',
      filesFor(definition),
    );

    expect(first.ok && first.version.version).toBe(1);
    expect(second.ok && second.version.definition.metadata.version).toBe(2);
    expect(
      (
        (await store.get('Service', '991825827', 'kunnskapsassistenten', 1))
          ?.definition as ServiceDefinition
      ).spec.purpose,
    ).toBe('Svar med kilder fra offentlige rapporter i Kudos');
    expect((await store.resolve('kunnskapsassistenten__default'))?.service.version).toBe(2);
    expect((await store.resolve('ka', 1))?.service.version).toBe(1);
  });

  it('refuses a public name another service already uses, an invalid definition, and a publish without a reason', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const ka = example('kunnskapsassistenten.yaml');
    await store.publish(ka, 'kari', 'første', filesFor(ka));
    const copy = example('kunnskapsassistenten.yaml');
    const stolen = { ...copy, metadata: { tenant: '999888777', id: 'kopi' } };

    const collision = await store.publish(stolen, 'ola', 'kopi', filesFor(ka));
    const invalid = await store.publish(withSpec({ riskClass: 'high' }), 'kari', 'høy risiko');
    const noReason = await store.publish(example('klarsprak.yaml'), 'kari', '  ');

    expect(collision.ok ? [] : collision.errors.map((e) => e.message)).toEqual([
      'public name ka is used by Service:991825827/kunnskapsassistenten',
      'public name ka-retrieve-only is used by Service:991825827/kunnskapsassistenten',
    ]);
    expect(invalid.ok).toBe(false);
    expect(noReason.ok).toBe(false);
  });

  it('publishes a service that uses a step flow only after the flow is published', async () => {
    const store = new InMemoryDefinitionStore(plugins);

    const early = await store.publish(example('postsortering.yaml'), 'kari', 'for tidlig');
    await store.publish(example('postsortering-flyt.yaml'), 'kari', 'flyten');
    const later = await store.publish(example('postsortering.yaml'), 'kari', 'nå');

    expect(early.ok ? [] : early.errors.map((e) => e.path)).toEqual(['spec.strategy.config.flow']);
    expect(later.ok).toBe(true);
  });

  it('publishes a variant with its own step flow only after that flow is published', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const service = example('kunnskapsassistenten.yaml');
    const flow = example('postsortering-flyt.yaml');
    const base = {
      ...flow,
      metadata: { ...(flow.metadata as object), tenant: '991825827' },
    };
    const spec = service.spec as Record<string, unknown>;
    const withVariantFlow = {
      ...service,
      spec: {
        ...spec,
        variants: [
          { id: 'default' },
          {
            id: 'flyt',
            strategy: { id: 'step-flow', version: 1, config: { flow: 'postsortering-flyt@1' } },
          },
        ],
      },
    };

    const early = await store.publish(
      withVariantFlow,
      'kari',
      'for tidlig',
      filesFor(withVariantFlow),
    );
    await store.publish(base, 'kari', 'flyten');
    const later = await store.publish(withVariantFlow, 'kari', 'nå', filesFor(withVariantFlow));

    expect(early.ok ? [] : early.errors).toEqual([
      {
        path: 'spec.variants[1].strategy.config.flow',
        message: 'no published step flow postsortering-flyt@1',
      },
    ]);
    expect(later.ok ? [] : later.errors).toEqual([]);
  });

  it('refuses to publish a service whose step flow calls a tool the service does not list in spec.tools', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const base = example('postsortering-flyt.yaml');
    const flow = {
      ...base,
      metadata: { ...(base.metadata as object), id: 'saksflyt' },
      spec: {
        purpose: 'Slå opp en sak',
        steps: [
          {
            id: 'oppslag',
            block: 'tool@1',
            params: { source: 'saker', tool: 'sok', arguments: {} },
          },
        ],
      },
    };
    const published = await store.publish(flow, 'kari', 'flyten');
    if (!published.ok) throw new Error(JSON.stringify(published.errors));
    const service = example('postsortering.yaml');
    const spec = service.spec as Record<string, unknown>;
    const using = (tools: string[]) => ({
      ...service,
      spec: {
        ...spec,
        tools,
        strategy: { id: 'step-flow', version: 1, config: { flow: 'saksflyt@1' } },
      },
    });

    const missing = await store.publish(using([]), 'kari', 'uten verktøy');
    const listed = await store.publish(using(['saker.sok@1']), 'kari', 'med verktøy');

    expect(missing.ok ? [] : missing.errors).toEqual([
      {
        path: 'spec.tools',
        message:
          'step oppslag in saksflyt@1 calls the tool saker.sok, which the service does not have in spec.tools',
      },
    ]);
    expect(listed.ok ? [] : listed.errors).toEqual([]);
  });
});

describe('settings', () => {
  const topK: SettingDefinition<number> = {
    key: 'search.topK',
    description: 'How many results a search returns',
    category: 'Søk',
    axis: 'service',
    sensitivity: 'normal',
    schema: z.number().int().min(1).max(200),
    default: 100,
    settableAt: ['platform', 'tenant', 'service', 'call'],
  };

  it('resolves platform, tenant, service and call in order, and says which layer won', () => {
    const resolved = resolveSetting(topK, {
      values: {
        platform: { 'search.topK': 80 },
        tenant: { 'search.topK': 60 },
        service: { 'search.topK': 40 },
      },
    });
    expect(resolved).toMatchObject({ value: 40, source: 'service' });
    expect(resolved.overridden.map((o) => o.layer)).toEqual(['default', 'platform', 'tenant']);
  });

  it('ignores a layer the setting cannot be set at, and an invalid value', () => {
    const resolved = resolveSetting(
      { ...topK, settableAt: ['platform', 'service'] },
      { values: { tenant: { 'search.topK': 10 }, service: { 'search.topK': 999 } } },
    );
    expect(resolved).toMatchObject({ value: 100, source: 'default' });
    expect(resolved.rejected.map((r) => r.layer)).toEqual(['tenant', 'service']);
  });

  it('lets a platform lock cap every lower layer', () => {
    const resolved = resolveSetting(topK, {
      values: { platform: { 'search.topK': 50 }, service: { 'search.topK': 200 } },
      locks: { 'search.topK': { reason: 'fastsatt av Digdir' } },
    });
    expect(resolved).toMatchObject({ value: 50, source: 'platform', locked: 'fastsatt av Digdir' });
  });

  it('never lets a consuming service override a setting the dataset owns', () => {
    const chunking: SettingDefinition<number> = {
      ...topK,
      key: 'chunks.maxLength',
      axis: 'dataset',
      schema: z.number().int().min(100).max(10_000),
      default: 4000,
      settableAt: ['platform', 'dataset'],
    };
    const resolved = resolveSetting(chunking, {
      values: { dataset: { 'chunks.maxLength': 2000 }, service: { 'chunks.maxLength': 8000 } },
    });
    expect(resolved).toMatchObject({ value: 2000, source: 'dataset' });
  });

  it('keeps a pinned platform default until a lower layer sets the value', () => {
    const resolved = resolveSetting(topK, {
      values: { platform: { 'search.topK': 80 } },
      pins: { 'search.topK': { version: 11, value: 60 } },
    });
    expect(resolved).toMatchObject({ value: 60, source: 'pin' });
  });

  it('merges objects and replaces lists', () => {
    const filters: SettingDefinition<Record<string, unknown>> = {
      ...topK,
      key: 'search.defaults',
      schema: z.record(z.string(), z.unknown()),
      default: { autoFilter: true, fields: ['type'] },
    };
    const resolved = resolveSetting(filters, {
      values: { service: { 'search.defaults': { fields: ['year'] } } },
    });
    expect(resolved.value).toEqual({ autoFilter: true, fields: ['year'] });
  });

  it('accepts a secret only as a reference', () => {
    const secret: SettingDefinition<string> = {
      ...topK,
      key: 'tools.lovdata.key',
      sensitivity: 'secret',
      schema: z.string(),
      default: '',
    };
    const plain = resolveSetting(secret, { values: { tenant: { 'tools.lovdata.key': 'sk-123' } } });
    const ref = resolveSetting(secret, {
      values: { tenant: { 'tools.lovdata.key': 'secret://999888777/lovdata' } },
    });
    expect(plain.source).toBe('default');
    expect(ref).toMatchObject({ value: 'secret://999888777/lovdata', source: 'tenant' });
  });
});

const skill = (patch: Record<string, unknown> = {}, id = 'klarsprak-sjekk') => ({
  apiVersion: 'genai/v1',
  kind: 'Skill',
  metadata: { tenant: '991825827', id, name: 'Klarspråksjekk' },
  spec: {
    description: 'Bruk når teksten skal sjekkes for klarspråk. Ikke bruk for oversettelse.',
    instructions: '# Klarspråk\n\nPek på lange setninger og forklar fagord.',
    examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt saken din.' }],
    tools: ['rag@1'],
    attachments: [{ name: 'sprakradet.pdf', blob: 'blob://991825827/skills/sprakradet.pdf' }],
    testset: {
      passThreshold: 0.8,
      cases: [
        { input: 'Søknaden er innvilget.', expected: 'Bruker du', type: 'criteria' },
        { input: 'Skriv et dikt', expected: 'Avvis', type: 'must_reject' },
      ],
    },
    ...patch,
  },
});

describe('skills', () => {
  it('a Skill validates with genai/v1 and refuses unknown keys', () => {
    expect(errorsOf(skill())).toEqual([]);
    expect(errorsOf({ ...skill(), apiVersion: 'ki.digdir.no/v1' }).map((e) => e.path)).toEqual([
      'apiVersion',
    ]);
    expect(errorsOf(skill({ owner: 'Testetaten' }))).toEqual([
      expect.objectContaining({ path: 'spec', message: expect.stringMatching(/owner/) }),
    ]);
    expect(
      errorsOf(
        skill({ testset: { cases: [{ input: 'x', expected: 'y', type: 'vibes', weight: 2 }] } }),
      ).map((e) => e.path),
    ).toEqual(expect.arrayContaining(['spec.testset.cases[0].type', 'spec.testset.cases[0]']));
    expect(errorsOf(skill({ tools: ['ukjent@1'] }))).toEqual([
      { path: 'spec.tools[0]', message: 'unknown tool or tool version ukjent@1' },
    ]);
  });

  it('a Skill is versioned with whole numbers and a reason', async () => {
    const store = new InMemoryDefinitionStore(plugins, () => new Date('2026-10-07T08:00:00Z'));

    const noReason = await store.publish(skill(), 'kari', ' ');
    const first = await store.publish(skill(), 'kari', 'første versjon');
    const second = await store.publish(skill({ tools: [] }), 'kari', 'uten verktøy');

    expect(noReason.ok).toBe(false);
    expect(first.ok && first.version).toMatchObject({ version: 1, reason: 'første versjon' });
    expect(second.ok && second.version.definition.metadata.version).toBe(2);
    expect(
      (await store.versions('Skill', '991825827', 'klarsprak-sjekk')).map((v) => v.version),
    ).toEqual([1, 2]);
    expect(await store.list('991825827')).toEqual([{ kind: 'Skill', id: 'klarsprak-sjekk' }]);
    expect(
      validateDefinition({ ...skill(), metadata: { ...skill().metadata, version: 1.3 } }, plugins)
        .ok,
    ).toBe(false);
  });

  it('a service cannot pin an unpublished skill', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    const service = withSpec({ skills: ['klarsprak-sjekk@1'] });

    const early = await store.publish(service, 'kari', 'for tidlig', filesFor(service));
    await store.publish(skill(), 'kari', 'første');
    const wrongVersion = await store.publish(
      withSpec({ skills: ['klarsprak-sjekk@2'] }),
      'kari',
      'feil versjon',
      filesFor(service),
    );
    const pinned = await store.publish(service, 'kari', 'nå finnes den', filesFor(service));

    expect(early.ok ? [] : early.errors).toEqual([
      { path: 'spec.skills[0]', message: 'no published skill klarsprak-sjekk@1' },
    ]);
    expect(wrongVersion.ok).toBe(false);
    expect(pinned.ok && pinned.version.definition).toMatchObject({
      spec: { skills: ['klarsprak-sjekk@1'] },
    });
    expect(validateService(example('klarsprak.yaml'), plugins)).toMatchObject({
      ok: true,
      definition: { spec: { skills: [] } },
    });
  });

  it('a service cannot use a skill whose tools it does not have', async () => {
    const store = new InMemoryDefinitionStore(plugins);
    await store.publish(skill({ tools: ['rag@1', 'digdir.klarsprak@2.3'] }), 'kari', 'første');
    const service = withSpec({ skills: ['klarsprak-sjekk@1'] });

    const widened = await store.publish(service, 'kari', 'mer tilgang', filesFor(service));

    expect(widened.ok ? [] : widened.errors).toEqual([
      {
        path: 'spec.skills[0]',
        message:
          'skill klarsprak-sjekk@1 uses the tool digdir.klarsprak@2.3, which the service does not have in spec.tools',
      },
    ]);
  });

  it('asks the shared-skill hook when the tenant has no such skill', async () => {
    const shared = skillDefinitionOf(skill({ tools: [] }, 'felles'));
    const store = new InMemoryDefinitionStore(plugins, undefined, (_t, id, version) =>
      id === 'felles' && version === 3 ? shared : undefined,
    );
    const service = withSpec({ skills: ['felles@3'] });

    expect((await store.publish(service, 'kari', 'delt', filesFor(service))).ok).toBe(true);
  });

  it('skills are not invocable capabilities', async () => {
    const store = new InMemoryDefinitionStore(plugins);

    const published = await store.publish(skill(), 'kari', 'første');

    expect(published.ok && published.capabilities).toEqual([]);
    expect(await store.capabilities()).toEqual([]);
    expect(await store.resolve('klarsprak-sjekk')).toBeUndefined();
  });
});

const skillDefinitionOf = (input: unknown) => {
  const result = validateDefinition(input, plugins);
  if (!result.ok || result.definition.kind !== 'Skill') throw new Error('not a skill');
  return result.definition;
};

describe('platform settings', () => {
  it('the new platform settings have their defaults', () => {
    const resolved = resolveSettings(platformSettings, { values: {} });
    const values = Object.fromEntries(
      [
        'knowledge.switchRetentionDays',
        'assistant.enabled',
        'assistant.dailyTokens',
        'skills.defaultPassThreshold',
        'services.defaultModel',
        'playground.enabled',
        'usage.monthlyTokens',
        'usage.tenantCallsPerMinute',
        'batch.approvalLimitNok',
      ].map((k) => [k, resolved[k]?.value]),
    );

    expect(values).toEqual({
      'knowledge.switchRetentionDays': 14,
      'assistant.enabled': true,
      'assistant.dailyTokens': 200000,
      'skills.defaultPassThreshold': 0.9,
      'services.defaultModel': '',
      'playground.enabled': true,
      'usage.monthlyTokens': 50_000_000,
      'usage.tenantCallsPerMinute': 600,
      'batch.approvalLimitNok': 150,
    });
    expect(new Set(platformSettings.map((s) => s.key)).size).toBe(platformSettings.length);
  });

  it('lets a tenant change the new settings within their ranges, and nothing below the tenant', () => {
    const resolved = resolveSettings(platformSettings, {
      values: {
        tenant: { 'skills.defaultPassThreshold': 1.5, 'assistant.dailyTokens': 50000 },
        service: { 'playground.enabled': false },
      },
    });

    expect(resolved['skills.defaultPassThreshold']).toMatchObject({ value: 0.9 });
    expect(resolved['assistant.dailyTokens']).toMatchObject({ value: 50000, source: 'tenant' });
    expect(resolved['playground.enabled']).toMatchObject({
      value: true,
      rejected: [{ layer: 'service', reason: 'cannot be set at the service layer' }],
    });
  });
});
