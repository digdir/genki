import {
  checkAgainstAccounts,
  latestRegister,
  syncAccounts,
  syncRegister,
  syncRegisterNames,
  type ConfigEntryStore,
  type GuardedRequest,
  type KudosActorPages,
  type RegisterSync,
} from '@genai/composition';

export interface StateRegisterJobDeps {
  configEntries: ConfigEntryStore;
  guard: GuardedRequest;
  kudos: KudosActorPages;
  now?: () => Date;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** The state accounts' years to read; all of them when left out. */
  years?: number[];
}

/** After a good sync: the state accounts, KUDOS's names and the monthly check (ADR 0058). */
export const afterRegisterSync =
  (deps: StateRegisterJobDeps) =>
  async (result: { ok: boolean }): Promise<void> => {
    if (!result.ok) return;
    const now = deps.now ?? (() => new Date());
    const accounts = await syncAccounts({
      configEntries: deps.configEntries,
      guard: deps.guard,
      now,
      ...(deps.years ? { years: deps.years } : {}),
    });
    if (!accounts.ok) deps.log('state accounts failed', { error: accounts.error });
    await syncRegisterNames({ configEntries: deps.configEntries, kudos: deps.kudos, now }).catch(
      (error: unknown) => deps.log('state register names failed', { error: String(error) }),
    );
    await checkAgainstAccounts({
      configEntries: deps.configEntries,
      now,
      onMismatch: (rows) =>
        deps.log('state register mismatch', {
          units: rows.map((r) => ({
            orgnr: r.orgnr,
            name: r.name,
            register: r.registerMinistry ?? null,
            accounts: r.accountsMinistry ?? null,
          })),
        }),
    });
  };

export const onRegisterStale = (log: StateRegisterJobDeps['log']) => (sync: RegisterSync) =>
  log('state register stale', { ...sync });

/** At start, on one replica, when no register is stored yet: read it now instead of at night. */
export const syncRegisterAtStart = async (
  deps: StateRegisterJobDeps & { lease?: { tryAcquire(): Promise<boolean> } },
): Promise<void> => {
  if (await latestRegister(deps.configEntries)) return;
  if (deps.lease && !(await deps.lease.tryAcquire())) return;
  const result = await syncRegister({
    configEntries: deps.configEntries,
    guard: deps.guard,
    now: deps.now ?? (() => new Date()),
    onStale: onRegisterStale(deps.log),
  });
  deps.log(
    'state register',
    result.ok ? { units: result.register.units.length } : { error: result.error },
  );
  await afterRegisterSync(deps)(result);
};
