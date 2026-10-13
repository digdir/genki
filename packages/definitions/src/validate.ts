import { checkInputFields, reservedInputFieldIds } from '@genai/contracts';
import { parse as parseYaml } from 'yaml';
import { flowSettingRefs } from './flow-settings.js';
import { checkSettingValue, type SettingDefinition } from './settings.js';
import type { z } from 'zod';
import {
  publicNamesOf,
  residencies,
  serviceDefinition,
  skillDefinition,
  stepFlowDefinition,
  toolRef,
  variantId,
  variantModelOf,
  variantStrategyOf,
  type Definition,
  type FlowStep,
  type ServiceDefinition,
  type SkillDefinition,
  type StepFlowDefinition,
} from './schema.js';

export type Residency = (typeof residencies)[number];

export interface DatasetLocation {
  stored: Residency;
  embedding?: { model: string; residency: Residency | undefined };
}

export interface TraceSink {
  residency: Residency;
  content: boolean;
}

export interface PluginSchemas {
  strategies: Map<string, z.ZodType>;
  tools: Map<string, z.ZodType>;
  guardrails: Map<string, z.ZodType>;
  blocks: Set<string>;
  models: Map<string, { residency: (typeof residencies)[number]; capabilities: string[] }>;
  settings?: SettingDefinition[];
  retrieval?: z.ZodType;
  rerankers?: Set<string>;
  rerankerResidency?: (id: string) => Residency | undefined;
  datasets?: Set<string>;
  datasetLocation?: (dataset: string) => DatasetLocation | undefined;
  traceSink?: () => TraceSink | undefined;
  strategyResidency?: (strategy: string, config: unknown) => Residency | undefined;
  modelNeeds?: Map<string, string[]>;
  allowHighRisk?: boolean;
  allowPublicAudience?: boolean;
}

export interface ValidationError {
  path: string;
  message: string;
}

export type Validated<D = Definition> =
  { ok: true; definition: D } | { ok: false; errors: ValidationError[] };

export const strategyKey = (id: string, version: number) => `${id}@${version}`;

const joinPath = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path]
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');

const check = (
  schema: z.ZodType,
  value: unknown,
  base: (string | number)[],
  errors: ValidationError[],
) => {
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues)
      errors.push({ path: joinPath(base, issue), message: issue.message });
  }
};

const parse = <T>(schema: z.ZodType<T>, input: unknown): Validated<T> => {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          path: joinPath([], issue),
          message: issue.message,
        })),
      };
};

const placeWords: Record<Residency, string> = {
  norway: 'i Norge',
  eu: 'i EU/EØS',
  global: 'utenfor EU/EØS',
};

const wider = (actual: Residency, allowed: Residency) =>
  residencies.indexOf(actual) > residencies.indexOf(allowed);

const residencyProblems = (
  spec: ServiceDefinition['spec'],
  plugins: PluginSchemas,
): ValidationError[] => {
  const allowed = spec.model.residency;
  const required = `Tjenesten krever at data behandles ${placeWords[allowed]}.`;
  const errors: ValidationError[] = [];
  spec.knowledge.datasets.forEach((d, i) => {
    const location = plugins.datasetLocation?.(d.dataset);
    if (!location) return;
    const path = `spec.knowledge.datasets[${i}].dataset`;
    if (wider(location.stored, allowed))
      errors.push({
        path,
        message: `Datasettet ${d.dataset} lagres ${placeWords[location.stored]}. ${required}`,
      });
    const embedding = location.embedding;
    if (!embedding) return;
    if (embedding.residency === undefined)
      errors.push({
        path,
        message: `Datasettet ${d.dataset} søkes med embeddingmodellen ${embedding.model}, som ikke er klassifisert. ${required}`,
      });
    else if (wider(embedding.residency, allowed))
      errors.push({
        path,
        message: `Datasettet ${d.dataset} søkes med embeddingmodellen ${embedding.model}, som behandler data ${placeWords[embedding.residency]}. ${required}`,
      });
  });
  const reranker = spec.knowledge.reranker;
  const reranked = reranker ? plugins.rerankerResidency?.(reranker) : undefined;
  if (reranker && reranked && wider(reranked, allowed))
    errors.push({
      path: 'spec.knowledge.reranker',
      message: `Omrangeringen ${reranker} behandler data ${placeWords[reranked]}. ${required}`,
    });
  const strategies = [
    { strategy: spec.strategy, path: 'spec.strategy' },
    ...spec.variants.flatMap((v, i) =>
      typeof v !== 'string' && v.strategy
        ? [{ strategy: v.strategy, path: `spec.variants[${i}].strategy` }]
        : [],
    ),
  ];
  for (const { strategy, path } of strategies) {
    const external = plugins.strategyResidency?.(
      strategyKey(strategy.id, strategy.version),
      strategy.config,
    );
    if (external && wider(external, allowed))
      errors.push({
        path: `${path}.config.endpoint.residency`,
        message: `Den eksterne agenten behandler data ${placeWords[external]}. ${required}`,
      });
  }
  const traces = plugins.traceSink?.();
  if (traces?.content && wider(traces.residency, allowed))
    errors.push({
      path: 'spec.model.residency',
      message: `Sporingen sender innholdet i samtalene til en mottaker ${placeWords[traces.residency]}. ${required}`,
    });
  return errors;
};

const withOptions = new Set(['choice', 'multi-choice', 'organisation']);

const inputFieldProblems = (spec: ServiceDefinition['spec']): ValidationError[] => {
  const errors: ValidationError[] = [];
  const fields = spec.input.fields ?? [];
  const datasets = new Set(spec.knowledge.datasets.map((d) => d.dataset));
  fields.forEach((field, i) => {
    const path = `spec.input.fields[${i}]`;
    if (fields.findIndex((f) => f.id === field.id) !== i)
      errors.push({ path: `${path}.id`, message: `duplicate input field ${field.id}` });
    if ((reservedInputFieldIds as readonly string[]).includes(field.id))
      errors.push({ path: `${path}.id`, message: `${field.id} is reserved for the platform` });
    const hasOptions = field.options !== undefined || field.optionsFrom !== undefined;
    if (field.kind === 'year' && field.options)
      errors.push({ path, message: 'a year field takes optionsFrom, not options' });
    if (hasOptions && !withOptions.has(field.kind) && field.kind !== 'year')
      errors.push({ path, message: `a ${field.kind} field takes no options` });
    if (field.options && field.optionsFrom)
      errors.push({ path, message: 'use either options or optionsFrom, not both' });
    if ((field.kind === 'choice' || field.kind === 'multi-choice') && !hasOptions)
      errors.push({ path, message: `a ${field.kind} field needs options or optionsFrom` });
    if (field.options && new Set(field.options).size !== field.options.length)
      errors.push({ path: `${path}.options`, message: 'options must be unique' });
    if (field.dependsOn !== undefined) {
      const parent = fields.findIndex((f) => f.id === field.dependsOn);
      if (parent < 0 || parent >= i)
        errors.push({
          path: `${path}.dependsOn`,
          message: `${field.dependsOn} is not an earlier input field`,
        });
      else if (!withOptions.has(fields[parent]?.kind ?? ''))
        errors.push({
          path: `${path}.dependsOn`,
          message: `${field.dependsOn} has no choices to depend on`,
        });
    }
    if (field.default !== undefined) {
      const checked = checkInputFields([{ ...field, required: false, default: undefined }], {
        [field.id]: field.default,
      });
      if (!checked.ok)
        errors.push({
          path: `${path}.default`,
          message: checked.errors.map((e) => e.message).join(' '),
        });
    }
    if (field.optionsFrom && !datasets.has(field.optionsFrom.dataset))
      errors.push({
        path: `${path}.optionsFrom.dataset`,
        message: `dataset ${field.optionsFrom.dataset} is not in spec.knowledge.datasets`,
      });
  });
  return errors;
};

const tableColumnProblems = (output: ServiceDefinition['spec']['output']): ValidationError[] => {
  const errors: ValidationError[] = [];
  const columns = output.columns ?? [];
  if (output.kind !== 'table' && (output.columns || output.rowKey))
    errors.push({ path: 'spec.output.columns', message: 'only a table output takes columns' });
  columns.forEach((column, i) => {
    const path = `spec.output.columns[${i}]`;
    if (columns.findIndex((c) => c.key === column.key) !== i)
      errors.push({ path: `${path}.key`, message: `duplicate column ${column.key}` });
    if (column.type === 'enum' && !column.values)
      errors.push({ path: `${path}.values`, message: 'a column of type enum needs values' });
  });
  if (output.rowKey && !columns.some((c) => c.key === output.rowKey))
    errors.push({ path: 'spec.output.rowKey', message: `${output.rowKey} is not a column` });
  return errors;
};

const missingLanguageInstructions = (spec: ServiceDefinition['spec']): ValidationError[] => {
  const configs = [
    { config: spec.strategy.config, path: 'spec.strategy.config.instructions' },
    ...spec.variants.flatMap((v, i) =>
      typeof v === 'string'
        ? []
        : [
            {
              config: v.strategy?.config,
              path: `spec.variants[${i}].strategy.config.instructions`,
            },
            { config: v.overrides, path: `spec.variants[${i}].overrides.instructions` },
          ],
    ),
  ];
  return configs.flatMap(({ config, path }) => {
    const instructions = (config as { instructions?: unknown } | undefined)?.instructions;
    if (!instructions || typeof instructions !== 'object' || Array.isArray(instructions)) return [];
    return spec.languages
      .filter((l) => !(l in instructions))
      .map((l) => ({
        path: `${path}.${l}`,
        message: `the service answers in ${l} but has no instructions for it`,
      }));
  });
};

const checkService = (definition: ServiceDefinition, plugins: PluginSchemas): ValidationError[] => {
  const { spec } = definition;
  const errors: ValidationError[] = [];

  if (spec.riskClass === 'high' && !plugins.allowHighRisk) {
    errors.push({ path: 'spec.riskClass', message: 'high-risk services are not offered yet' });
  }
  if (spec.audience.includes('public') && !plugins.allowPublicAudience) {
    errors.push({ path: 'spec.audience', message: 'services for the public are not offered yet' });
  }

  if (spec.output.kind === 'table' && spec.strategy.id !== 'step-flow') {
    errors.push({ path: 'spec.output.kind', message: 'only a step flow can produce a table' });
  }
  if (spec.output.kind === 'fields' && spec.guardrails['require-sources'] !== undefined) {
    errors.push({
      path: 'spec.guardrails.require-sources',
      message: 'an output of kind fields has no answer to cite, so it cannot require sources',
    });
  }

  const strategySchema = plugins.strategies.get(
    strategyKey(spec.strategy.id, spec.strategy.version),
  );
  if (!strategySchema) {
    errors.push({
      path: 'spec.strategy',
      message: `unknown strategy ${strategyKey(spec.strategy.id, spec.strategy.version)}`,
    });
  } else {
    check(strategySchema, spec.strategy.config, ['spec', 'strategy', 'config'], errors);
  }
  spec.variants.forEach((v, i) => {
    if (typeof v === 'string') return;
    if (v.chat === false && i === 0)
      errors.push({
        path: 'spec.variants[0].chat',
        message: 'the first variant is the default and must be a chat variant',
      });
    const own = v.strategy;
    if (own && spec.output.kind === 'table' && own.id !== 'step-flow')
      errors.push({
        path: `spec.variants[${i}].strategy.id`,
        message: 'only a step flow can produce a table',
      });
    const schema = own ? plugins.strategies.get(strategyKey(own.id, own.version)) : strategySchema;
    if (own && !schema) {
      errors.push({
        path: `spec.variants[${i}].strategy`,
        message: `unknown strategy ${strategyKey(own.id, own.version)}`,
      });
      return;
    }
    if (!schema) return;
    if (own) check(schema, own.config, ['spec', 'variants', i, 'strategy', 'config'], errors);
    if (Object.keys(v.overrides).length === 0) return;
    const merged = {
      ...(variantStrategyOf(spec, v).config as Record<string, unknown>),
      ...v.overrides,
    };
    check(schema, merged, ['spec', 'variants', i, 'overrides'], errors);
  });

  errors.push(...missingLanguageInstructions(spec));

  const ids = spec.variants.map(variantId);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i)
      errors.push({ path: `spec.variants[${i}]`, message: `duplicate variant ${id}` });
  });
  const names = spec.variants.flatMap((v) => {
    const { primary, aliases } = publicNamesOf(definition, v);
    return [primary, ...aliases];
  });
  names.forEach((name, i) => {
    if (names.indexOf(name) !== i)
      errors.push({ path: 'spec.variants', message: `public name ${name} is used twice` });
  });

  for (const [role, id] of Object.entries(spec.model.roles ?? {})) {
    if (id === undefined) continue;
    const model = plugins.models.get(id);
    if (!model) errors.push({ path: `spec.model.roles.${role}`, message: `unknown model ${id}` });
    else if (residencies.indexOf(model.residency) > residencies.indexOf(spec.model.residency))
      errors.push({
        path: `spec.model.roles.${role}`,
        message: `model ${id} runs in ${model.residency}, outside ${spec.model.residency}`,
      });
  }

  const isExternal = (strategy: ServiceDefinition['spec']['strategy']) =>
    plugins.strategyResidency?.(strategyKey(strategy.id, strategy.version), strategy.config) !==
    undefined;
  const choices = [
    ...(['primary', 'fallback'] as const).map((role) => ({
      id: spec.model[role],
      path: `spec.model.${role}`,
      strategy: spec.strategy,
      known: false,
    })),
    ...spec.variants.flatMap((v, i) => {
      const strategy = variantStrategyOf(spec, v);
      const own = variantModelOf(v);
      const ownChoice = { id: own, path: `spec.variants[${i}].model`, strategy, known: false };
      if (typeof v === 'string' || !v.strategy) return [ownChoice];
      const path = `spec.variants[${i}].strategy`;
      return [
        own === undefined ? { id: spec.model.primary, path, strategy, known: true } : ownChoice,
        { id: spec.model.fallback, path, strategy, known: true },
      ];
    }),
  ];
  const modelless = [
    { path: 'spec.model.primary', strategy: spec.strategy, own: undefined as string | undefined },
    ...spec.variants.flatMap((v, i) =>
      typeof v !== 'string' && v.strategy
        ? [{ path: `spec.variants[${i}].model`, strategy: v.strategy, own: variantModelOf(v) }]
        : [],
    ),
  ];
  if (spec.model.primary === '')
    for (const { path, strategy, own } of modelless)
      if (own === undefined && !isExternal(strategy))
        errors.push({
          path,
          message: 'a model is required unless the strategy is an external agent',
        });
  for (const { id, path, strategy, known } of choices) {
    if (id === undefined || id === '') continue;
    const model = plugins.models.get(id);
    if (!model) {
      if (!known) errors.push({ path, message: `unknown model ${id}` });
      continue;
    }
    if (
      !isExternal(strategy) &&
      (!known || isExternal(spec.strategy)) &&
      residencies.indexOf(model.residency) > residencies.indexOf(spec.model.residency)
    ) {
      errors.push({
        path,
        message: `model ${id} runs in ${model.residency}, outside ${spec.model.residency}`,
      });
    }
    if (!known && spec.tools.length > 0 && !model.capabilities.includes('tools')) {
      errors.push({ path, message: `model ${id} cannot call tools` });
    }
    const needs = plugins.modelNeeds?.get(strategyKey(strategy.id, strategy.version)) ?? [];
    const missing = needs.filter(
      (c) => !model.capabilities.includes(c) && !(c === 'tools' && spec.tools.length > 0),
    );
    if (missing.length > 0) {
      errors.push({
        path,
        message: `model ${id} lacks ${missing.join(', ')}, which ${strategy.id} needs`,
      });
    }
  }

  if (spec.knowledge.retrieval !== undefined) {
    if (!plugins.retrieval)
      errors.push({
        path: 'spec.knowledge.retrieval',
        message: 'retrieval settings are not supported',
      });
    else
      check(
        plugins.retrieval,
        spec.knowledge.retrieval,
        ['spec', 'knowledge', 'retrieval'],
        errors,
      );
  }
  if (plugins.datasets) {
    spec.knowledge.datasets.forEach((d, i) => {
      if (!plugins.datasets?.has(d.dataset))
        errors.push({
          path: `spec.knowledge.datasets[${i}].dataset`,
          message: `unknown dataset ${d.dataset}`,
        });
    });
  }
  errors.push(...residencyProblems(spec, plugins));
  errors.push(...inputFieldProblems(spec));
  errors.push(...tableColumnProblems(spec.output));
  if (spec.knowledge.reranker !== undefined && !plugins.rerankers?.has(spec.knowledge.reranker)) {
    errors.push({
      path: 'spec.knowledge.reranker',
      message: `unknown reranker ${spec.knowledge.reranker}`,
    });
  }

  spec.tools.forEach((t, i) => {
    const ref = toolRef(t);
    const schema = plugins.tools.get(ref);
    if (!schema) {
      errors.push({ path: `spec.tools[${i}]`, message: `unknown tool or tool version ${ref}` });
      return;
    }
    const config =
      typeof t === 'string'
        ? {}
        : Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'use'));
    check(schema, config, ['spec', 'tools', i], errors);
  });

  if (plugins.settings) {
    for (const [key, value] of Object.entries(spec.settings)) {
      const definition = plugins.settings.find((d) => d.key === key);
      const checked = definition
        ? checkSettingValue(definition, 'service', value)
        : { ok: false as const, reason: `unknown setting ${key}` };
      if (!checked.ok) errors.push({ path: `spec.settings.${key}`, message: checked.reason });
    }
    for (const [entryPoint, keys] of Object.entries(spec.callOverrides ?? {}))
      (keys ?? []).forEach((key, i) => {
        const known =
          key === '*' ||
          (plugins.settings ?? []).some((d) =>
            key.endsWith('.*') ? d.key.startsWith(key.slice(0, -1)) : d.key === key,
          );
        if (!known)
          errors.push({
            path: `spec.callOverrides.${entryPoint}[${i}]`,
            message: `unknown setting ${key}`,
          });
      });
  }

  for (const [name, config] of Object.entries(spec.guardrails)) {
    const schema = plugins.guardrails.get(name);
    if (!schema)
      errors.push({ path: `spec.guardrails.${name}`, message: `unknown guardrail ${name}` });
    else check(schema, config, ['spec', 'guardrails', name], errors);
  }
  return errors;
};

const checkSteps = (
  steps: FlowStep[],
  base: string,
  plugins: PluginSchemas,
  seen: Set<string>,
  errors: ValidationError[],
) => {
  steps.forEach((step, i) => {
    const path = `${base}[${i}]`;
    if (seen.has(step.id))
      errors.push({ path: `${path}.id`, message: `duplicate step id ${step.id}` });
    seen.add(step.id);
    if (step.block && !plugins.blocks.has(step.block)) {
      errors.push({
        path: `${path}.block`,
        message: `unknown building block or version ${step.block}`,
      });
    }
    if (step.repeat) checkSteps(step.repeat.steps, `${path}.repeat.steps`, plugins, seen, errors);
    if (step.forEach)
      checkSteps(step.forEach.steps, `${path}.forEach.steps`, plugins, seen, errors);
    step.cases?.forEach((c, j) =>
      checkSteps(c.steps, `${path}.cases[${j}].steps`, plugins, seen, errors),
    );
    if (step.else) checkSteps(step.else, `${path}.else`, plugins, seen, errors);
  });
};

const checkStepFlow = (
  definition: StepFlowDefinition,
  plugins: PluginSchemas,
): ValidationError[] => {
  const errors: ValidationError[] = [];
  checkSteps(definition.spec.steps, 'spec.steps', plugins, new Set(), errors);
  const declared = definition.spec.settings?.properties ?? {};
  for (const name of flowSettingRefs(definition.spec.steps))
    if (!(name in declared))
      errors.push({
        path: 'spec.steps',
        message: `a step reads settings.${name}, which spec.settings does not declare`,
      });
  return errors;
};

const checkSkill = (definition: SkillDefinition, plugins: PluginSchemas): ValidationError[] =>
  definition.spec.tools.flatMap((ref, i) =>
    plugins.tools.has(ref)
      ? []
      : [{ path: `spec.tools[${i}]`, message: `unknown tool or tool version ${ref}` }],
  );

export const validateDefinition = (input: unknown, plugins: PluginSchemas): Validated => {
  const kind = input && typeof input === 'object' ? (input as { kind?: unknown }).kind : undefined;
  if (kind === 'Skill') {
    const parsed = parse(skillDefinition, input);
    if (!parsed.ok) return parsed;
    const errors = checkSkill(parsed.definition, plugins);
    return errors.length > 0 ? { ok: false, errors } : parsed;
  }
  if (kind === 'StepFlow') {
    const parsed = parse(stepFlowDefinition, input);
    if (!parsed.ok) return parsed;
    const errors = checkStepFlow(parsed.definition, plugins);
    return errors.length > 0 ? { ok: false, errors } : parsed;
  }
  const parsed = parse(serviceDefinition, input);
  if (!parsed.ok) return parsed;
  const errors = checkService(parsed.definition, plugins);
  return errors.length > 0 ? { ok: false, errors } : parsed;
};

export const definitionWarnings = (definition: Definition): ValidationError[] =>
  definition.kind === 'Service' &&
  definition.spec.exposure.a2aPublicCard &&
  !definition.spec.exposure.a2a
    ? [
        {
          path: 'spec.exposure.a2aPublicCard',
          message: 'a2aPublicCard has no effect unless exposure.a2a is true; the card stays hidden',
        },
      ]
    : [];

export const validateService = (
  input: unknown,
  plugins: PluginSchemas,
): Validated<ServiceDefinition> => {
  const result = validateDefinition(input, plugins);
  if (result.ok && result.definition.kind !== 'Service') {
    return { ok: false, errors: [{ path: 'kind', message: 'expected a Service' }] };
  }
  return result as Validated<ServiceDefinition>;
};

export const validateYaml = (text: string, plugins: PluginSchemas): Validated => {
  try {
    return validateDefinition(parseYaml(text), plugins);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
