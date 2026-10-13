import type { AnswerLanguage } from './service-languages';

export type Audience = 'employees' | 'public';
export type RiskClass = 'minimal' | 'limited' | 'high';
export type OutputKind = 'answer' | 'fields' | 'document' | 'table';
export type OutputFieldType = 'string' | 'number' | 'boolean' | 'date' | 'list';
export type InputKind =
  'text' | 'long-text' | 'choice' | 'multi-choice' | 'number' | 'year' | 'date' | 'organisation';
export type ExposureKey = 'chat' | 'mcp' | 'openai' | 'rest' | 'a2a' | 'a2aPublicCard';

export interface OutputField {
  name: string;
  label?: string;
  type: OutputFieldType;
  description: string;
  required?: boolean;
}

export interface TableColumnSpec {
  key: string;
  name: string;
  type?: 'string' | 'number' | 'enum';
  description?: string;
  kind?: 'document' | 'assessment';
  values?: string[];
}

export interface OptionsFrom {
  dataset: string;
  facet: string;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface InputFieldSpec {
  id: string;
  label: string;
  kind: InputKind;
  required?: boolean;
  help?: string;
  options?: string[];
  optionsFrom?: OptionsFrom;
  default?: string | number | string[];
  dependsOn?: string;
}

export interface StrategyRef {
  id: string;
  version: number;
  config: Record<string, unknown>;
}

export interface VariantSpec {
  id: string;
  title?: { nb: string; en: string };
  publicName?: string;
  model?: string;
  strategy?: StrategyRef;
  chat?: boolean;
  aliases?: unknown[];
  overrides?: Record<string, unknown>;
}

export type Trigger =
  | { kind: 'schedule'; cron: string }
  | { kind: 'queue-message'; queue: string }
  | { kind: 'document-arrives'; folder: string };

export type ToolRef = string | { use: string; [key: string]: unknown };

export interface DatasetRef {
  dataset: string;
  filters?: Record<string, unknown>;
}

export interface RiskConfirmation {
  by?: string;
  at?: string;
  reasons?: string[];
  riskClass?: RiskClass;
}

export interface ServiceSpec {
  purpose: string;
  exampleQuestions?: unknown[];
  audience?: Audience[];
  riskClass?: RiskClass;
  riskConfirmation?: RiskConfirmation;
  variants?: (string | VariantSpec)[];
  languages?: AnswerLanguage[];
  input: { accepts: string[]; ocr?: boolean; fields?: InputFieldSpec[] };
  output: {
    kind: OutputKind;
    fields?: OutputField[];
    columns?: TableColumnSpec[];
    rowKey?: string;
    withSources?: boolean;
    template?: string;
  };
  strategy: StrategyRef;
  knowledge?: {
    datasets?: DatasetRef[];
    runtimeDocuments?: boolean;
    retrieval?: Record<string, unknown>;
    reranker?: string;
  };
  tools?: ToolRef[];
  skills?: string[];
  model: {
    primary: string;
    fallback?: string;
    roles?: Record<string, string>;
    residency?: string;
  };
  guardrails?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  callOverrides?: Record<string, string[]>;
  exposure?: Partial<Record<ExposureKey, boolean>>;
  availableTo?: '*' | string[];
  triggers?: Trigger[];
  batch?: { enabled: boolean };
  evaluation?: { testSets?: string[]; gates?: string[] };
  improve?: { allow?: string[] };
}

export interface ServiceDefinition {
  apiVersion: 'genai/v1';
  kind: 'Service';
  metadata: { tenant: string; id: string; name?: string; version?: number };
  spec: ServiceSpec;
}

export type SpecPatch = { [K in keyof ServiceSpec]?: ServiceSpec[K] | undefined };
export type SpecEdit = SpecPatch | ((d: ServiceDefinition) => SpecPatch);

type Tree = Record<string, unknown>;

const tree = (v: unknown): Tree =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Tree) : {};

const withoutUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const asServiceDefinition = (raw: Record<string, unknown>): ServiceDefinition => {
  const metadata = tree(raw.metadata);
  const spec = tree(raw.spec);
  const strategy = tree(spec.strategy);
  const model = tree(spec.model);
  const input = tree(spec.input);
  const output = tree(spec.output);
  return {
    ...raw,
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: {
      ...metadata,
      tenant: typeof metadata.tenant === 'string' ? metadata.tenant : '',
      id: typeof metadata.id === 'string' ? metadata.id : '',
    },
    spec: {
      ...spec,
      purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
      input: { ...input, accepts: Array.isArray(input.accepts) ? input.accepts.map(String) : [] },
      output: { ...output, kind: (output.kind as OutputKind | undefined) ?? 'answer' },
      strategy: {
        ...strategy,
        id: typeof strategy.id === 'string' ? strategy.id : '',
        version: typeof strategy.version === 'number' ? strategy.version : 1,
        config: tree(strategy.config),
      },
      model: { ...model, primary: typeof model.primary === 'string' ? model.primary : '' },
    } as ServiceSpec,
  };
};

export const applySpec = (d: ServiceDefinition, edit: SpecEdit): ServiceDefinition => ({
  ...d,
  spec: withoutUndefined({
    ...d.spec,
    ...(typeof edit === 'function' ? edit(d) : edit),
  }) as ServiceSpec,
});

const named = (metadata: ServiceDefinition['metadata'], name: string | undefined) => {
  const rest = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== 'name'),
  ) as ServiceDefinition['metadata'];
  return name ? { ...rest, name } : rest;
};

export const renamed = (d: ServiceDefinition, name: string): ServiceDefinition => ({
  ...d,
  metadata: named(d.metadata, name),
});

export const forTenant = (
  d: ServiceDefinition,
  stamp: { tenant: string; id: string; version: number },
): ServiceDefinition => ({
  ...d,
  metadata: {
    tenant: stamp.tenant,
    id: stamp.id,
    name: d.metadata.name || stamp.id,
    version: stamp.version,
  },
});

export const specChanges = (before: ServiceSpec, after: ServiceSpec): SpecPatch =>
  Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (key) =>
          JSON.stringify((before as unknown as Tree)[key]) !==
          JSON.stringify((after as unknown as Tree)[key]),
      )
      .map((key) => [key, (after as unknown as Tree)[key]]),
  ) as SpecPatch;

export const specKeysOf = (d: ServiceDefinition, patch: SpecPatch): SpecPatch =>
  Object.fromEntries(
    Object.keys(patch).map((key) => [key, (d.spec as unknown as Tree)[key]]),
  ) as SpecPatch;
