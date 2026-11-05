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
  'kernel.gate.call',
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
  audioSeconds?: number;
  images?: number;
  videoSeconds?: number;
  characters?: number;
  requests?: number;
  costMicroNok?: number;
}

export const priceUnits = [
  'input-token',
  'output-token',
  'cached-input-token',
  'audio-second',
  'image',
  'video-second',
  'character',
  'request',
] as const;
export type PriceUnit = (typeof priceUnits)[number];

/** The usage field each price unit counts. */
export const unitFields = {
  'input-token': 'inputTokens',
  'output-token': 'outputTokens',
  'cached-input-token': 'cachedInputTokens',
  'audio-second': 'audioSeconds',
  image: 'images',
  'video-second': 'videoSeconds',
  character: 'characters',
  request: 'requests',
} as const satisfies Record<PriceUnit, keyof Usage>;

/** NOK per one unit. */
export type UnitPrices = Partial<Record<PriceUnit, number>>;

/** A model's prices, per operation kind. */
export type ModelPrices = Record<string, UnitPrices>;

/** The price shape before ADR 0048: NOK per 1,000 input and output tokens, for every kind. */
export interface UsagePrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export type PriceSpec = ModelPrices | UsagePrice;

export const isPerThousandPrice = (spec: unknown): spec is UsagePrice =>
  typeof spec === 'object' && spec !== null && 'inputPerThousand' in spec;

const perUnit = (perThousand: number) => Number((perThousand / 1000).toPrecision(12));

export const unitPricesOfPerThousand = (price: UsagePrice): UnitPrices => ({
  'input-token': perUnit(price.inputPerThousand),
  'output-token': perUnit(price.outputPerThousand),
});

/** The unit prices of one kind; a price from before ADR 0048 holds for every kind. */
export const unitPricesFor = (spec: unknown, kind: string): UnitPrices | undefined => {
  if (spec === undefined || spec === null) return undefined;
  if (isPerThousandPrice(spec)) return unitPricesOfPerThousand(spec);
  return (spec as ModelPrices)[kind];
};

/** The per-1,000-token view of a price, from its chat prices or else the first kind with token prices. */
export const perThousandView = (spec: unknown): UsagePrice | undefined => {
  if (spec === undefined || spec === null) return undefined;
  if (isPerThousandPrice(spec)) return spec;
  const prices = spec as ModelPrices;
  const units =
    prices.chat ??
    Object.values(prices).find(
      (p) => p['input-token'] !== undefined || p['output-token'] !== undefined,
    );
  if (!units) return undefined;
  const thousand = (n: number | undefined) => Number(((n ?? 0) * 1000).toPrecision(12));
  return {
    inputPerThousand: thousand(units['input-token']),
    outputPerThousand: thousand(units['output-token']),
  };
};

/** The units a call reports, counted from its usage. */
export const usageUnits = (usage: Usage): Partial<Record<PriceUnit, number>> =>
  Object.fromEntries(
    priceUnits.flatMap((unit) => {
      const count = usage[unitFields[unit]];
      return count ? [[unit, count] as const] : [];
    }),
  );

/** The cost of a call when every unit it reports has a price; otherwise the usage stays unpriced. */
export const pricedUsage = (usage: Usage, prices: UnitPrices | undefined): Usage => {
  if (usage.costMicroNok !== undefined || !prices) return usage;
  const units = usageUnits(usage);
  const cached = prices['cached-input-token'];
  let nok = 0;
  for (const [unit, count] of Object.entries(units) as [PriceUnit, number][]) {
    if (unit === 'cached-input-token') {
      if (cached !== undefined) nok += count * (cached - (prices['input-token'] ?? 0));
      continue;
    }
    const price = prices[unit];
    if (price === undefined) {
      if (unit === 'request') continue;
      return usage;
    }
    nok += count * price;
  }
  return { ...usage, costMicroNok: Math.round(nok * 1_000_000) };
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
  /** The generation's data version on the knowledge server that answered (ADR 0042). */
  dataVersion?: number;
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
