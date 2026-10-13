import { inputFieldId, inputFieldKinds } from '@genai/contracts';

const validPattern = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};
import { z } from 'zod';
import { flowSettingsSchema } from './flow-settings.js';

export const orgNumber = z.string().regex(/^\d{9}$/, 'must be a nine-digit organisation number');
const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be lowercase letters, digits and dashes');
export const versionedRef = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]*@\d+(\.\d+)*$/,
    'must be a versioned reference, like digdir.klarsprak@2.3',
  );
const publicName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'must be a lowercase public name');
const mime = z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'must be a MIME type');

export const residencies = ['norway', 'eu', 'global'] as const;
export const answerLanguages = ['nb', 'nn', 'en'] as const;
export const improvable = ['instructions', 'examples', 'retrieval', 'model'] as const;
export const callOverrideEntryPoints = ['mcp', 'openai', 'rest', 'a2a'] as const;
export type CallOverrideEntryPoint = (typeof callOverrideEntryPoints)[number];
export type CallOverrideAllowlist = Partial<Record<CallOverrideEntryPoint, string[]>>;

const alias = z.union([publicName, z.strictObject({ name: publicName })]);

const strategyRef = z.strictObject({
  id: slug,
  version: z.number().int().positive(),
  config: z.unknown(),
});

const variant = z.union([
  slug,
  z.strictObject({
    id: slug,
    title: z
      .strictObject({ nb: z.string().trim().min(1), en: z.string().trim().min(1) })
      .optional(),
    publicName: publicName.optional(),
    model: z.string().min(1).optional(),
    strategy: strategyRef.optional(),
    chat: z.boolean().optional(),
    aliases: z.array(alias).default([]),
    overrides: z.record(z.string(), z.unknown()).default({}),
  }),
]);

const outputField = z.strictObject({
  name: z.string().min(1),
  label: z.string().trim().min(1).optional(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'list']),
  description: z.string().min(1),
  required: z.boolean().optional(),
});

export const tableColumnTypes = ['string', 'number', 'enum'] as const;

const tableColumn = z.strictObject({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'must be letters, digits, _ or -'),
  name: z.string().trim().min(1),
  type: z.enum(tableColumnTypes).default('string'),
  description: z.string().trim().min(1).optional(),
  kind: z.enum(['document', 'assessment']).default('document'),
  values: z.array(z.string().trim().min(1)).min(1).optional(),
});

const trigger = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schedule'), cron: z.string().min(1) }),
  z.strictObject({ kind: z.literal('queue-message'), queue: z.string().min(1) }),
  z.strictObject({ kind: z.literal('document-arrives'), folder: z.string().min(1) }),
]);

const tool = z.union([versionedRef, z.looseObject({ use: versionedRef })]);

export const serviceSpec = z.strictObject({
  purpose: z.string().min(1),
  exampleQuestions: z
    .array(
      z.union([
        z.string().trim().min(1),
        z.strictObject({ nb: z.string().trim().min(1), en: z.string().trim().min(1) }),
      ]),
    )
    .max(6)
    .optional(),
  audience: z
    .array(z.enum(['employees', 'public']))
    .min(1)
    .default(['employees']),
  riskClass: z.enum(['minimal', 'limited', 'high']),
  riskConfirmation: z
    .strictObject({
      by: z.string().min(1).optional(),
      at: z.string().min(1).optional(),
      reasons: z.array(z.string()).default([]),
      riskClass: z.enum(['minimal', 'limited', 'high']).optional(),
    })
    .optional(),
  variants: z.array(variant).min(1).default(['default']),
  languages: z
    .array(z.enum(answerLanguages))
    .min(1)
    .refine((l) => new Set(l).size === l.length, 'list each language once')
    .default(['nb', 'en']),
  input: z.strictObject({
    accepts: z.array(mime).min(1),
    ocr: z.boolean().default(false),
    fields: z
      .array(
        z.strictObject({
          id: z
            .string()
            .regex(inputFieldId, 'must start with a lowercase letter, then letters, digits or _'),
          label: z.string().trim().min(1),
          kind: z.enum(inputFieldKinds),
          required: z.boolean().default(false),
          help: z.string().trim().min(1).optional(),
          options: z.array(z.string().trim().min(1)).min(1).optional(),
          optionsFrom: z
            .strictObject({
              dataset: z.string().min(1),
              facet: z.string().min(1),
              min: z.number().optional(),
              max: z.number().optional(),
              pattern: z
                .string()
                .min(1)
                .max(200)
                .refine(validPattern, 'must be a valid regular expression')
                .optional(),
            })
            .refine((o) => o.min === undefined || o.max === undefined || o.min <= o.max, {
              message: 'min must not be greater than max',
              path: ['min'],
            })
            .optional(),
          default: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
          dependsOn: z.string().min(1).optional(),
        }),
      )
      .optional(),
  }),
  output: z
    .strictObject({
      kind: z.enum(['answer', 'fields', 'document', 'table']),
      fields: z.array(outputField).optional(),
      columns: z.array(tableColumn).min(1).optional(),
      rowKey: z.string().min(1).optional(),
      withSources: z.boolean().default(false),
      template: z.string().optional(),
    })
    .refine((o) => o.kind !== 'fields' || (o.fields?.length ?? 0) > 0, {
      message: 'an output of kind fields needs at least one field',
      path: ['fields'],
    }),
  strategy: strategyRef,
  knowledge: z
    .strictObject({
      datasets: z
        .array(
          z.strictObject({
            dataset: z.string().min(1),
            filters: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .default([]),
      runtimeDocuments: z.boolean().default(false),
      retrieval: z.record(z.string(), z.unknown()).optional(),
      reranker: z.string().min(1).optional(),
    })
    .default({ datasets: [], runtimeDocuments: false }),
  tools: z.array(tool).default([]),
  skills: z.array(versionedRef).default([]),
  model: z.strictObject({
    primary: z.string().default(''),
    fallback: z.string().min(1).optional(),
    roles: z
      .strictObject({
        synthesis: z.string().min(1).optional(),
        planner: z.string().min(1).optional(),
        judge: z.string().min(1).optional(),
      })
      .optional(),
    residency: z.enum(residencies),
  }),
  guardrails: z.record(slug, z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
  callOverrides: z
    .strictObject(
      Object.fromEntries(
        callOverrideEntryPoints.map((e) => [e, z.array(z.string().min(1)).optional()]),
      ) as Record<CallOverrideEntryPoint, z.ZodOptional<z.ZodArray<z.ZodString>>>,
    )
    .optional(),
  exposure: z
    .strictObject({
      chat: z.boolean().default(false),
      mcp: z.boolean().default(false),
      openai: z.boolean().default(false),
      rest: z.boolean().default(false),
      a2a: z.boolean().default(false),
      a2aPublicCard: z.boolean().default(false),
    })
    .default({
      chat: false,
      mcp: false,
      openai: false,
      rest: false,
      a2a: false,
      a2aPublicCard: false,
    }),
  availableTo: z.union([z.literal('*'), z.array(orgNumber)]).optional(),
  triggers: z.array(trigger).default([]),
  batch: z.strictObject({ enabled: z.boolean() }).optional(),
  evaluation: z
    .strictObject({
      testSets: z.array(z.string()).default([]),
      gates: z.array(z.string()).default([]),
    })
    .default({ testSets: [], gates: [] }),
  improve: z
    .strictObject({ allow: z.array(z.enum(improvable)).default([]) })
    .default({ allow: [] }),
});

const metadata = z.strictObject({
  tenant: orgNumber,
  id: slug,
  name: z.string().min(1).optional(),
  version: z.number().int().positive().optional(),
});

export const serviceDefinition = z.strictObject({
  apiVersion: z.literal('genai/v1'),
  kind: z.literal('Service'),
  metadata,
  spec: serviceSpec,
});

const onError = z.enum(['stop', 'skip', 'use-default']);

export interface FlowStep {
  id: string;
  name?: string | undefined;
  block?: string | undefined;
  input?: Record<string, unknown> | undefined;
  params?: Record<string, unknown> | undefined;
  onError?: 'stop' | 'skip' | 'use-default' | undefined;
  default?: unknown;
  repeat?: { until: string; max: number; steps: FlowStep[] } | undefined;
  forEach?: { in: string; as: string; steps: FlowStep[] } | undefined;
  switchOn?: string | undefined;
  cases?: { when: unknown; steps: FlowStep[] }[] | undefined;
  else?: FlowStep[] | undefined;
  subflow?: string | undefined;
}

export const flowStep: z.ZodType<FlowStep> = z.lazy(() =>
  z
    .strictObject({
      id: slug,
      name: z.string().optional(),
      block: versionedRef.optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      onError: onError.optional(),
      default: z.unknown().optional(),
      repeat: z
        .strictObject({
          until: z.string().min(1),
          max: z.number().int().min(1).max(100),
          steps: z.array(flowStep).min(1),
        })
        .optional(),
      forEach: z
        .strictObject({ in: z.string().min(1), as: slug, steps: z.array(flowStep).min(1) })
        .optional(),
      switchOn: z.string().min(1).optional(),
      cases: z
        .array(z.strictObject({ when: z.unknown(), steps: z.array(flowStep).min(1) }))
        .optional(),
      else: z.array(flowStep).optional(),
      subflow: versionedRef.optional(),
    })
    .refine(
      (s) =>
        [s.block, s.repeat, s.forEach, s.switchOn, s.subflow].filter((x) => x !== undefined)
          .length === 1,
      { message: 'a step needs exactly one of block, repeat, forEach, switchOn or subflow' },
    )
    .refine((s) => s.switchOn === undefined || (s.cases?.length ?? 0) > 0, {
      message: 'switchOn needs at least one case',
      path: ['cases'],
    })
    .refine((s) => s.onError !== 'use-default' || s.default !== undefined, {
      message: 'onError use-default needs a default',
      path: ['default'],
    }),
);

export const stepFlowDefinition = z.strictObject({
  apiVersion: z.literal('genai/v1'),
  kind: z.literal('StepFlow'),
  metadata,
  spec: z.strictObject({
    purpose: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    recipe: z
      .strictObject({
        title: z.strictObject({ nb: z.string().trim().min(1), en: z.string().trim().min(1) }),
        summary: z.strictObject({ nb: z.string().trim().min(1), en: z.string().trim().min(1) }),
      })
      .optional(),
    settings: flowSettingsSchema.optional(),
    steps: z.array(flowStep).min(1),
  }),
});

export const skillCaseTypes = ['criteria', 'fields', 'must_reject'] as const;

export const skillSpec = z.strictObject({
  description: z.string().min(1),
  instructions: z.string().min(1),
  examples: z
    .array(z.strictObject({ input: z.string().min(1), expectedOutput: z.string().min(1) }))
    .default([]),
  tools: z.array(versionedRef).default([]),
  attachments: z
    .array(z.strictObject({ name: z.string().min(1), blob: z.string().min(1) }))
    .default([]),
  testset: z
    .strictObject({
      passThreshold: z.number().min(0).max(1).optional(),
      cases: z
        .array(
          z.strictObject({
            input: z.string().min(1),
            expected: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
            type: z.enum(skillCaseTypes),
            context: z.string().min(1).optional(),
            dataset: z.string().min(1).optional(),
          }),
        )
        .default([]),
    })
    .default({ cases: [] }),
});

export const skillDefinition = z.strictObject({
  apiVersion: z.literal('genai/v1'),
  kind: z.literal('Skill'),
  metadata,
  spec: skillSpec,
});

export const definitionKinds = ['Service', 'StepFlow', 'Skill'] as const;

export type ServiceDefinition = z.output<typeof serviceDefinition>;
export type StepFlowDefinition = z.output<typeof stepFlowDefinition>;
export type SkillDefinition = z.output<typeof skillDefinition>;
export type Definition = ServiceDefinition | StepFlowDefinition | SkillDefinition;
export type Variant = ServiceDefinition['spec']['variants'][number];
export type Tool = ServiceDefinition['spec']['tools'][number];

export const variantId = (v: Variant) => (typeof v === 'string' ? v : v.id);
export const toolRef = (t: Tool) => (typeof t === 'string' ? t : t.use);
export const refName = (ref: string) => ref.slice(0, ref.lastIndexOf('@'));

export const variantTitleOf = (v: Variant) => (typeof v === 'string' ? undefined : v.title);
export const variantModelOf = (v: Variant) => (typeof v === 'string' ? undefined : v.model);
export const variantChatOf = (v: Variant) => (typeof v === 'string' ? true : v.chat !== false);
export const variantStrategyOf = (spec: ServiceDefinition['spec'], v: Variant) =>
  (typeof v === 'string' ? undefined : v.strategy) ?? spec.strategy;

export interface FlowUse {
  flow: string;
  path: string;
  variant?: string;
}

const flowOf = (strategy: { id: string; config?: unknown }) => {
  const flow = (strategy.config as { flow?: unknown } | null | undefined)?.flow;
  return strategy.id === 'step-flow' && typeof flow === 'string' ? flow : undefined;
};

export const flowUsesOf = (
  spec: Pick<ServiceDefinition['spec'], 'strategy'> & {
    variants?: ServiceDefinition['spec']['variants'];
  },
): FlowUse[] => {
  const service = flowOf(spec.strategy);
  return [
    ...(service ? [{ flow: service, path: 'spec.strategy.config.flow' }] : []),
    ...(spec.variants ?? []).flatMap((v, i): FlowUse[] => {
      if (typeof v === 'string') return [];
      const own = v.strategy && flowOf(v.strategy);
      const override = (v.overrides as Record<string, unknown> | undefined)?.flow;
      const runs = (v.strategy ?? spec.strategy).id === 'step-flow' && typeof override === 'string';
      return [
        ...(own
          ? [{ flow: own, path: `spec.variants[${i}].strategy.config.flow`, variant: v.id }]
          : []),
        ...(runs
          ? [{ flow: override, path: `spec.variants[${i}].overrides.flow`, variant: v.id }]
          : []),
      ];
    }),
  ];
};

export const publicNamesOf = (definition: ServiceDefinition, v: Variant) => {
  const id = variantId(v);
  const primary =
    (typeof v === 'string' ? undefined : v.publicName) ?? `${definition.metadata.id}__${id}`;
  const listed = typeof v === 'string' ? [] : v.aliases;
  return { primary, aliases: listed.map((a) => (typeof a === 'string' ? a : a.name)) };
};
