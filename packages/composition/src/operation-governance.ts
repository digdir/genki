import type { EnvironmentTier, Maturity } from '@genai/kernel';
import type { OperationGovernance } from '@genai/port-model';
import { z } from 'zod';
import { platformScope, type ConfigEntry, type ConfigEntryStore } from './config-store.js';

export const maturityEntryKind = 'operation-maturity';
export const processorRecordKind = 'processor-record';

export interface MaturityRecord {
  maturity: Maturity;
}

export interface MaturityState {
  kind: string;
  environment: EnvironmentTier;
  maturity: Maturity;
  by?: string;
  at?: string;
}

/** The latest entry decides; one operator promotes or demotes, and history stays in the store. */
export const maturityState = (
  kind: string,
  environment: EnvironmentTier,
  history: readonly ConfigEntry<MaturityRecord>[],
): MaturityState => {
  const last = history.filter((e) => !e.deleted).at(-1);
  if (!last) return { kind, environment, maturity: 'test' };
  return { kind, environment, maturity: last.spec.maturity, by: last.by, at: last.at };
};

export type MaturityStep = 'promoted' | 'demoted' | 'unchanged';

export const maturityStep = (state: MaturityState, wanted: Maturity): MaturityStep => {
  if (state.maturity === wanted) return 'unchanged';
  return wanted === 'production' ? 'promoted' : 'demoted';
};

const text = (max: number) => z.string().trim().min(1).max(max);

export const ProcessorRecordSpec = z
  .strictObject({
    agreement: text(500),
    subProcessors: z.array(z.strictObject({ name: text(200), location: text(100) })).max(50),
    retention: z.strictObject({
      days: z.number().int().min(0).max(3650),
      note: text(1000).optional(),
    }),
    acceptsUnmaskedInput: z.boolean().default(false),
    unmaskedInputReason: text(1000).optional(),
  })
  .refine((r) => !r.acceptsUnmaskedInput || r.unmaskedInputReason !== undefined, {
    message: 'say why this endpoint may take image, audio and file input that cannot be masked',
    path: ['unmaskedInputReason'],
  });

export type ProcessorRecord = z.infer<typeof ProcessorRecordSpec>;

export interface OperationGovernanceStore extends OperationGovernance {
  tier: EnvironmentTier;
  maturityOf(kind: string): Promise<MaturityState>;
  maturities(): Promise<MaturityState[]>;
  processorRecord(endpoint: string): Promise<ConfigEntry<ProcessorRecord> | undefined>;
  processorRecords(): Promise<ConfigEntry<ProcessorRecord>[]>;
}

/** Maturity per operation kind in this environment, and the processor record per endpoint, from the config store. */
export const operationGovernance = (
  store: ConfigEntryStore,
  tier: EnvironmentTier,
): OperationGovernanceStore => {
  const maturityOf = async (kind: string) =>
    maturityState(
      kind,
      tier,
      (await store.history(maturityEntryKind, tier, kind)) as ConfigEntry<MaturityRecord>[],
    );
  const processorRecord = async (endpoint: string) => {
    const latest = (await store.history(processorRecordKind, platformScope, endpoint)).at(-1);
    return latest && !latest.deleted ? (latest as ConfigEntry<ProcessorRecord>) : undefined;
  };
  return {
    tier,
    maturityOf,
    maturity: async (kind) => (await maturityOf(kind)).maturity,
    maturities: async () =>
      Promise.all(
        (await store.latest({ kind: maturityEntryKind, scope: tier })).map((e) => maturityOf(e.id)),
      ),
    processorRecord,
    processor: async (endpoint) => {
      const record = await processorRecord(endpoint);
      return record ? { acceptsUnmaskedInput: record.spec.acceptsUnmaskedInput } : undefined;
    },
    processorRecords: async () =>
      (await store.latest({ kind: processorRecordKind, scope: platformScope })).filter(
        (e) => !e.deleted,
      ) as ConfigEntry<ProcessorRecord>[],
  };
};
