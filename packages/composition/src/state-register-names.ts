import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';
import { latestRegister } from './state-register.js';

/**
 * The names people use for a unit of the state, from KUDOS (run by DFØ): its display name and
 * abbreviation, joined to the register by org number (ADR 0058). Old names are left out: KUDOS
 * points «Difi» to DFØ alone, though Difi was split between DFØ and Digdir.
 */

/** KUDOS's `/api/v0/actors`, page by page; the worker gives it KUDOS's client and rate limiter. */
export interface KudosActorPages {
  actors(page: number): Promise<{
    data: {
      org_number?: number | string | null;
      alternative_names?: { type: string; name: string }[];
    }[];
    meta: { current_page: number; last_page: number };
  }>;
}

export type RegisterNames = Record<string, { display?: string; abbreviation?: string }>;

export const registerNamesKind = 'state-register-names';
const namesId = 'kudos';

export const latestRegisterNames = async (
  configEntries: ConfigEntryStore,
): Promise<RegisterNames | undefined> => {
  const last = (await configEntries.history(registerNamesKind, platformScope, namesId)).at(-1);
  return last && !last.deleted ? (last.spec as RegisterNames) : undefined;
};

const sameNames = (a: RegisterNames | undefined, b: RegisterNames) =>
  a !== undefined &&
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Reads every KUDOS actor and keeps the names of the units in the register. */
export const syncRegisterNames = async (deps: {
  configEntries: ConfigEntryStore;
  kudos: KudosActorPages;
  now: () => Date;
}): Promise<void> => {
  const register = await latestRegister(deps.configEntries);
  if (!register) return;
  const inRegister = new Set(register.units.map((u) => u.orgnr));
  const names: RegisterNames = {};
  for (let n = 1; ; n += 1) {
    const page = await deps.kudos.actors(n);
    for (const actor of page.data) {
      const orgnr = actor.org_number == null ? '' : String(actor.org_number);
      if (!inRegister.has(orgnr)) continue;
      const of = (type: string) => actor.alternative_names?.find((a) => a.type === type)?.name;
      const display = of('display');
      const abbreviation = of('abbreviation');
      if (!display && !abbreviation) continue;
      names[orgnr] = {
        ...(names[orgnr] ?? {}),
        ...(display ? { display } : {}),
        ...(abbreviation ? { abbreviation } : {}),
      };
    }
    if (page.meta.current_page >= page.meta.last_page) break;
  }
  if (sameNames(await latestRegisterNames(deps.configEntries), names)) return;
  await appendVersion<RegisterNames>(deps.configEntries, {
    kind: registerNamesKind,
    scope: platformScope,
    id: namesId,
    spec: names,
    deleted: false,
    by: 'worker',
    reason: `KUDOS names for ${Object.keys(names).length} units of the register`,
    at: deps.now().toISOString(),
  });
};
