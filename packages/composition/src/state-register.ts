import { schedule, type Clock, type ScheduledJob } from '@genai/jobs';
import { EgressGuard } from '@genai/providers-mcp-client';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';
import type { GuardedRequest } from './exchange-rates.js';

/**
 * The state's organisation as Enhetsregisteret registers it (ADR 0058): each ministry (STAT) and
 * every unit under it (ORGL), with the parent each ministry has registered for its agencies
 * (rundskriv W-01/2019). Read nightly through the egress guard and kept as versioned config
 * entries: a new version only when the tree changed, so the versions are the change history.
 */

export interface RegisterUnit {
  orgnr: string;
  /** The name as registered, such as DIGITALISERINGSDIREKTORATET. */
  name: string;
  /** STAT is a ministry or another top unit of the state; ORGL is a unit under one. */
  form: 'STAT' | 'ORGL';
  /** The org number of the unit it is registered under; a STAT unit has none. */
  parent?: string;
}

export interface RegisterChange {
  change: 'new' | 'removed' | 'parent';
  orgnr: string;
  name: string;
  /** The parent before the change: of a removed unit, or one that moved. */
  from?: string;
  /** The parent after the change: of a new unit, or one that moved. */
  to?: string;
}

export interface StateRegister {
  units: RegisterUnit[];
  /** What changed since the version before; empty on the first. */
  changes: RegisterChange[];
  /** The night this tree was read. A later night that found no change keeps this version. */
  syncedAt: string;
}

export interface RegisterSync {
  /** When the last sync that read the whole register finished. */
  lastGood?: string;
  /** Nights in a row the sync has failed since the last good one. */
  failedNights: number;
  error?: string;
}

export const registerKind = 'state-register';
export const registerSyncKind = 'state-register-sync';
const registerId = 'enhetsregisteret';
const worker = 'worker';

/** The register's open API: NLOD 2.0. */
export const brregHost = { host: 'data.brreg.no', port: 443 };
/** The register's own words when an answer cites it. */
export const registerSource = 'Enhetsregisteret';

/** The guard the register and the state accounts are read through: public HTTPS hosts only. */
export const stateRegisterGuard = (): GuardedRequest => new EgressGuard({});

export const brregUnitsUrl = (form: 'STAT' | 'ORGL', page: number) =>
  `https://data.brreg.no/enhetsregisteret/api/enheter?organisasjonsform=${form}&size=1000&page=${page}`;

/** After this many failed nights in a row, the register is stale and operators are told. */
export const staleAfterNights = 2;

export class PartialPull extends Error {
  override readonly name = 'PartialPull';
}

interface BrregPage {
  _embedded?: {
    enheter?: {
      organisasjonsnummer?: string;
      navn?: string;
      organisasjonsform?: { kode?: string };
      overordnetEnhet?: string;
    }[];
  };
  page?: { totalElements?: number; totalPages?: number };
}

/** Every unit of one form, all pages, or an error: never part of the register. */
const pullForm = async (guard: GuardedRequest, form: 'STAT' | 'ORGL') => {
  const units: RegisterUnit[] = [];
  let reported = 0;
  for (let n = 0, pages = 1; n < pages; n += 1) {
    const response = await guard.request([brregHost], brregUnitsUrl(form, n), {
      method: 'GET',
      headers: { accept: 'application/json' },
      maxResponseBytes: 16 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    if (response.status !== 200)
      throw new PartialPull(
        `Enhetsregisteret answered HTTP ${response.status} for ${form} page ${n}`,
      );
    const answer = JSON.parse(response.body) as BrregPage;
    pages = answer.page?.totalPages ?? 0;
    reported = answer.page?.totalElements ?? 0;
    for (const u of answer._embedded?.enheter ?? []) {
      if (!u.organisasjonsnummer || !u.navn || u.organisasjonsform?.kode !== form) continue;
      units.push({
        orgnr: u.organisasjonsnummer,
        name: u.navn,
        form,
        ...(form === 'ORGL' && u.overordnetEnhet ? { parent: u.overordnetEnhet } : {}),
      });
    }
  }
  if (units.length < reported)
    throw new PartialPull(
      `Enhetsregisteret reported ${reported} ${form} units and gave ${units.length}`,
    );
  return units;
};

/** Every STAT and ORGL unit in Norway; refuses a pull that lacks any page or unit it reported. */
export const pullRegisterUnits = async (guard: GuardedRequest): Promise<RegisterUnit[]> => {
  const stat = await pullForm(guard, 'STAT');
  if (stat.length === 0) throw new PartialPull('Enhetsregisteret gave no STAT units');
  return [...stat, ...(await pullForm(guard, 'ORGL'))];
};

/** The units that reach a STAT unit through their parents: the state, not municipalities. */
export const stateTree = (units: RegisterUnit[]): RegisterUnit[] => {
  const byOrgnr = new Map(units.map((u) => [u.orgnr, u]));
  return units.filter((u) => {
    const seen = new Set<string>();
    for (let at: RegisterUnit | undefined = u; at && !seen.has(at.orgnr);) {
      if (at.form === 'STAT') return true;
      seen.add(at.orgnr);
      at = at.parent ? byOrgnr.get(at.parent) : undefined;
    }
    return false;
  });
};

/** The unit, its parent and so on up to its STAT unit; empty for a unit not in the tree. */
export const ministryChain = (units: RegisterUnit[], orgnr: string): RegisterUnit[] => {
  const byOrgnr = new Map(units.map((u) => [u.orgnr, u]));
  const chain: RegisterUnit[] = [];
  for (let at = byOrgnr.get(orgnr); at; at = at.parent ? byOrgnr.get(at.parent) : undefined) {
    if (chain.some((c) => c.orgnr === at?.orgnr)) return [];
    chain.push(at);
    if (at.form === 'STAT') return chain;
  }
  return [];
};

export const diffRegister = (before: RegisterUnit[], after: RegisterUnit[]): RegisterChange[] => {
  const old = new Map(before.map((u) => [u.orgnr, u]));
  const now = new Map(after.map((u) => [u.orgnr, u]));
  const changes: RegisterChange[] = [];
  for (const u of after) {
    const was = old.get(u.orgnr);
    if (!was)
      changes.push({
        change: 'new',
        orgnr: u.orgnr,
        name: u.name,
        ...(u.parent ? { to: u.parent } : {}),
      });
    else if (was.parent !== u.parent)
      changes.push({
        change: 'parent',
        orgnr: u.orgnr,
        name: u.name,
        ...(was.parent ? { from: was.parent } : {}),
        ...(u.parent ? { to: u.parent } : {}),
      });
  }
  for (const u of before)
    if (!now.has(u.orgnr))
      changes.push({
        change: 'removed',
        orgnr: u.orgnr,
        name: u.name,
        ...(u.parent ? { from: u.parent } : {}),
      });
  return changes;
};

const sameTree = (a: RegisterUnit[], b: RegisterUnit[]) => {
  if (a.length !== b.length) return false;
  const byOrgnr = new Map(a.map((u) => [u.orgnr, u]));
  return b.every((u) => {
    const v = byOrgnr.get(u.orgnr);
    return v?.name === u.name && v.parent === u.parent && v.form === u.form;
  });
};

/** Every version of the register, oldest first, each with the night it was read. */
export const registerVersions = async (configEntries: ConfigEntryStore) =>
  (await configEntries.history(registerKind, platformScope, registerId))
    .filter((e) => !e.deleted)
    .map((e) => ({ at: e.at, register: e.spec as StateRegister }));

export const latestRegister = async (
  configEntries: ConfigEntryStore,
): Promise<StateRegister | undefined> => (await registerVersions(configEntries)).at(-1)?.register;

export const latestRegisterSync = async (
  configEntries: ConfigEntryStore,
): Promise<RegisterSync | undefined> => {
  const entry = (await configEntries.latest({ kind: registerSyncKind, scope: platformScope })).find(
    (e) => e.id === registerId && !e.deleted,
  );
  return entry ? (entry.spec as RegisterSync) : undefined;
};

const saveSync = async (configEntries: ConfigEntryStore, sync: RegisterSync, at: Date) =>
  appendVersion<RegisterSync>(configEntries, {
    kind: registerSyncKind,
    scope: platformScope,
    id: registerId,
    spec: sync,
    deleted: false,
    by: worker,
    reason: sync.error ? `register sync failed: ${sync.error}` : 'register synced',
    at: at.toISOString(),
  });

/**
 * One night's sync: read the whole register, keep the state tree, and save a new version when it
 * changed. A failed or partial read changes nothing but the sync status.
 */
export const syncRegister = async (deps: {
  configEntries: ConfigEntryStore;
  guard: GuardedRequest;
  now: () => Date;
  onStale?: (sync: RegisterSync) => void;
}): Promise<{ ok: true; register: StateRegister } | { ok: false; error: string }> => {
  const status = await latestRegisterSync(deps.configEntries);
  let tree: RegisterUnit[];
  try {
    tree = stateTree(await pullRegisterUnits(deps.guard));
  } catch (error) {
    const sync: RegisterSync = {
      ...(status?.lastGood ? { lastGood: status.lastGood } : {}),
      failedNights: (status?.failedNights ?? 0) + 1,
      error: error instanceof Error ? error.message : String(error),
    };
    await saveSync(deps.configEntries, sync, deps.now());
    if (sync.failedNights >= staleAfterNights) deps.onStale?.(sync);
    return { ok: false, error: sync.error ?? '' };
  }
  const at = deps.now();
  const current = await latestRegister(deps.configEntries);
  let register = current;
  if (!current || !sameTree(current.units, tree)) {
    register = {
      units: tree,
      changes: current ? diffRegister(current.units, tree) : [],
      syncedAt: at.toISOString(),
    };
    await appendVersion<StateRegister>(deps.configEntries, {
      kind: registerKind,
      scope: platformScope,
      id: registerId,
      spec: register,
      deleted: false,
      by: worker,
      reason: current
        ? `${register.changes.length} changes in Enhetsregisteret`
        : `${tree.length} units read from Enhetsregisteret`,
      at: at.toISOString(),
    });
  }
  await saveSync(deps.configEntries, { lastGood: at.toISOString(), failedNights: 0 }, at);
  return { ok: true, register: register as StateRegister };
};

/** Every night at 02:40 Oslo time, after the register's own nightly build. */
export const scheduleRegisterSync = (deps: {
  configEntries: ConfigEntryStore;
  guard: GuardedRequest;
  clock?: Clock;
  cron?: string;
  active?: () => Promise<boolean>;
  afterSync?: (result: Awaited<ReturnType<typeof syncRegister>>) => Promise<void> | void;
  onStale?: (sync: RegisterSync) => void;
  onError?: (error: unknown) => void;
}): ScheduledJob =>
  schedule(
    deps.cron ?? '40 2 * * *',
    async (at) => {
      if (deps.active && !(await deps.active())) return;
      const result = await syncRegister({
        configEntries: deps.configEntries,
        guard: deps.guard,
        now: () => deps.clock?.now() ?? at,
        ...(deps.onStale ? { onStale: deps.onStale } : {}),
      });
      await deps.afterSync?.(result);
    },
    {
      timeZone: 'Europe/Oslo',
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.onError ? { onError: deps.onError } : {}),
    },
  );
