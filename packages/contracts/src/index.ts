import type { InputField } from './input-fields.js';

export * from './input-fields.js';
export * from './run-errors.js';
export * from './schema-meta.js';
export * from './source-links.js';

export type JSONSchema = Record<string, unknown>;

export interface Ref {
  kind: string;
  id: string;
  tenant?: string;
}

export type PartBody =
  | { kind: 'text'; text: string }
  | { kind: 'json'; json: unknown }
  | { kind: 'blob'; ref: Ref }
  | { kind: 'uri'; uri: string };

export interface Part {
  mime: string;
  body: PartBody;
  alt?: string;
  meta?: Record<string, unknown>;
}

export interface Input {
  data?: unknown;
  parts?: Part[];
}

export type PrincipalKind =
  'employee' | 'agency-system' | 'vendor-system' | 'workload' | 'operator' | 'citizen';

export type Assurance = 'low' | 'substantial' | 'substantial-limited' | 'high' | 'entraid';

export interface Principal {
  kind: PrincipalKind;
  issuer: string;
  subject: string;
  name?: string;
  tenant?: string;
  client?: string;
  assurance?: Assurance;
  authorizedFor?: { org: string; resource?: string; actions?: string[] }[];
  orgNames?: Record<string, string>;
  scopes?: string[];
  supplier?: string;
  systemUser?: string;
  roles?: string[];
  actor?: Principal;
  expiresAt?: string;
  confinedTo?: Confinement;
}

export interface Confinement {
  tenant: string;
  service?: string;
  client?: string;
}

export type Interaction = 'unary' | 'stream' | 'async' | 'duplex';

export type RiskClass = 'minimal' | 'limited' | 'high';

export interface CapabilityDescriptor {
  id: string;
  version: string;
  tenant: string;
  availableTo?: string[] | '*';
  title: string;
  description: string;
  input: JSONSchema;
  inputFields?: InputField[];
  output?: JSONSchema;
  interaction: Interaction[];
  accepts: string[];
  produces: string[];
  emits: string[];
  oversight: { interrupts: boolean; riskClass: RiskClass; aiDisclosure: string };
  deprecated?: { since: string; removeAfter: string; replacement?: string };
}

export type EventAudience = 'client' | 'audit';

export type EventActor = 'kernel' | 'strategy' | Ref;

export interface Event<D = unknown> {
  type: string;
  v: number;
  task: string;
  seq: number;
  ts: string;
  data: D;
  actor: EventActor;
  span?: { id: string; parent?: string };
  fallback?: Part[];
  audience?: EventAudience;
}

export const strategyEventTypes = [
  'kernel.part',
  'kernel.part.delta',
  'kernel.artifact',
  'kernel.interrupt',
  'kernel.notice',
  'kernel.result',
] as const;

export const kernelOwnedEventTypes = [
  'kernel.task.status',
  'kernel.task.input',
  'kernel.task.spawned',
  'kernel.interrupt.resolved',
  'kernel.usage',
  'kernel.resource.used',
  'kernel.error',
  'kernel.score',
  'kernel.feedback',
] as const;

export const kernelEventTypes = [...strategyEventTypes, ...kernelOwnedEventTypes] as const;

export const envelopeEventTypes = [
  'kernel.task.status',
  'kernel.task.spawned',
  'kernel.usage',
  'kernel.resource.used',
] as const;

export type KernelEventType = (typeof kernelEventTypes)[number];

export type TaskStatus =
  'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface Interrupt {
  id: string;
  reason: string;
  prompt: Part[];
  responseSchema?: JSONSchema;
  assignee?: Ref;
  expiresAt?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  requests?: number;
  costMicroNok?: number;
}

export interface UsagePrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export const withListPrice = (usage: Usage, price: UsagePrice | undefined): Usage =>
  usage.costMicroNok !== undefined || !price
    ? usage
    : {
        ...usage,
        costMicroNok: Math.round(
          (((usage.inputTokens ?? 0) / 1000) * price.inputPerThousand +
            ((usage.outputTokens ?? 0) / 1000) * price.outputPerThousand) *
            1_000_000,
        ),
      };

export interface ModelProvenance {
  id: string;
  endpoint: string;
  deployment: string;
}

export interface IndexProvenance {
  dataset: string;
  engine?: string;
  generation?: string;
  collections?: string[];
}

export type ResourceProvenance = { model: ModelProvenance } | { index: IndexProvenance };

export interface ServiceProvenance {
  capability: { id: string; version: string };
  strategy: { id: string; version: string };
  configHash: string;
  models?: ModelProvenance[];
  indexes?: IndexProvenance[];
}

export interface Task {
  id: string;
  service: ServiceProvenance;
  principal: Ref;
  tenant: string;
  owner: string;
  parent?: string;
  thread?: string;
  status: TaskStatus;
  pendingInterrupt?: Interrupt;
  result?: Part[];
  artifacts: string[];
  usage: Usage;
  createdAt: string;
  endedAt?: string;
}

export interface Artifact {
  id: string;
  task: string;
  name: string;
  mime: string;
  uri: string;
  provenance: { strategy: string; models: Ref[]; sources: Ref[] };
}

export const textPart = (text: string): Part => ({
  mime: 'text/plain',
  body: { kind: 'text', text },
});

export const formTextPart = (text: string): Part => ({
  ...textPart(text),
  meta: { inputFields: true },
});

export const isFormInput = (input: Input) =>
  (input.parts ?? []).some((p) => p.meta?.inputFields === true);
