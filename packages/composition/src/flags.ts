import type { Principal } from '@genai/contracts';
import {
  flagKeys,
  flags,
  isFlagKey,
  type FlagKey,
  type FlagSource,
  type FlagState,
} from '@genai/contracts/flags';
import { isDevMode, type BootRequirement } from './boot-guard.js';
import {
  appendVersion,
  serialized,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';

export const featureFlagKind = 'feature-flag';

export interface FlagPerson {
  issuer: string;
  subject: string;
}

export interface FlagRow {
  tenant: string;
  key: FlagKey;
  person?: FlagPerson;
  on: boolean;
  by: string;
  at: string;
  reason: string;
  expiresAt?: string;
}

export interface FlagAsker {
  principal: Principal;
  tenant: string;
}

export const flagRowId = (key: FlagKey, person?: FlagPerson) =>
  JSON.stringify(person ? [key, person.issuer, person.subject] : [key]);

const parsedRowId = (id: string): { key: FlagKey; person?: FlagPerson } | undefined => {
  let parts: unknown;
  try {
    parts = JSON.parse(id);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || !isFlagKey(parts[0])) return undefined;
  if (parts.length === 1) return { key: parts[0] };
  if (parts.length === 3 && typeof parts[1] === 'string' && typeof parts[2] === 'string')
    return { key: parts[0], person: { issuer: parts[1], subject: parts[2] } };
  return undefined;
};

const rowOf = (entry: ConfigEntry<unknown>): FlagRow | undefined => {
  const parsed = parsedRowId(entry.id);
  const spec = entry.spec as { on?: unknown; expiresAt?: unknown } | null;
  const on = spec?.on;
  if (!parsed || entry.deleted || typeof on !== 'boolean') return undefined;
  return {
    tenant: entry.scope,
    ...parsed,
    on,
    by: entry.by,
    at: entry.at,
    reason: entry.reason,
    ...(typeof spec?.expiresAt === 'string' ? { expiresAt: spec.expiresAt } : {}),
  };
};

const samePerson = (a: FlagPerson | undefined, b: FlagPerson) =>
  a?.issuer === b.issuer && a.subject === b.subject;

export const flagPersonOf = (principal: Principal): FlagPerson => ({
  issuer: principal.issuer,
  subject: principal.subject,
});

export const envFlagsOf = (env: Record<string, string | undefined>): string[] =>
  (env.GENAI_FLAGS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

export const flagEnvRequirement = (env: Record<string, string | undefined>): BootRequirement => ({
  met: envFlagsOf(env).length === 0,
  problem: 'GENAI_FLAGS turns feature flags on for everyone and runs only with GENAI_DEV_MODE=true',
});

export const flagEnvProblems = (env: Record<string, string | undefined>): string[] => {
  const unknown = envFlagsOf(env).filter((key) => !isFlagKey(key));
  return unknown.length > 0
    ? [`GENAI_FLAGS names flags that are not registered: ${unknown.join(', ')}`]
    : [];
};

export const envFlagsIn = (env: Record<string, string | undefined>): FlagKey[] =>
  isDevMode(env) ? envFlagsOf(env).filter(isFlagKey) : [];

export const isFlagRowExpired = (row: Pick<FlagRow, 'expiresAt'>, now: Date) =>
  row.expiresAt !== undefined && Date.parse(row.expiresAt) <= now.getTime();

export const createFlags = (options: {
  store: ConfigEntryStore;
  envOn?: readonly FlagKey[];
  now?: () => Date;
}) => {
  const { store } = options;
  const envOn = new Set(options.envOn ?? []);
  const now = options.now ?? (() => new Date());
  const writes = serialized();
  const rows = async (tenant?: string) =>
    (await store.latest({ kind: featureFlagKind, ...(tenant ? { scope: tenant } : {}) }))
      .map(rowOf)
      .filter((row): row is FlagRow => row !== undefined);
  const states = async (tenant: string, person?: FlagPerson): Promise<FlagState[]> => {
    const at = now();
    const found = (await rows(tenant)).filter((r) => !isFlagRowExpired(r, at));
    return flagKeys.map((key) => {
      const tenantRow = found.find((r) => r.key === key && !r.person);
      const personRow = person && found.find((r) => r.key === key && samePerson(r.person, person));
      const source: FlagSource = personRow
        ? 'person'
        : tenantRow
          ? 'tenant'
          : envOn.has(key)
            ? 'env'
            : 'default';
      return {
        key,
        on: personRow?.on ?? tenantRow?.on ?? envOn.has(key),
        source,
        selfService: flags[key].selfService,
        person: personRow?.on ?? null,
        tenant: tenantRow?.on ?? null,
      };
    });
  };
  const expiringWithin = async (ms: number) => {
    const at = now().getTime();
    return (await rows()).filter((r) => {
      const ends = r.expiresAt === undefined ? Number.NaN : Date.parse(r.expiresAt);
      return ends > at && ends <= at + ms;
    });
  };
  return {
    states,
    rows,
    expiringWithin,
    now,
    on: async (asker: FlagAsker, key: FlagKey) =>
      (await states(asker.tenant, flagPersonOf(asker.principal))).some(
        (state) => state.key === key && state.on,
      ),
    set: (change: {
      tenant: string;
      key: FlagKey;
      person?: FlagPerson;
      on: boolean | null;
      by: string;
      reason: string;
      expiresAt?: string;
    }) =>
      writes(() =>
        appendVersion<{ on?: boolean; expiresAt?: string }>(store, {
          kind: featureFlagKind,
          scope: change.tenant,
          id: flagRowId(change.key, change.person),
          spec:
            change.on === null
              ? {}
              : { on: change.on, ...(change.expiresAt ? { expiresAt: change.expiresAt } : {}) },
          deleted: change.on === null,
          by: change.by,
          reason: change.reason,
        }),
      ),
  };
};

export type Flags = ReturnType<typeof createFlags>;
