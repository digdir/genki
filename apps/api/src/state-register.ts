import {
  compareWithAccounts,
  latestAccounts,
  latestRegister,
  latestRegisterSync,
} from '@genai/composition';
import { operatorOf } from './knowledge-endpoints.js';
import type { PlatformModuleFactory } from './platform-modules.js';

/** The state register for operators: its dates and its differences (ADR 0058). */
export const stateRegisterModule: PlatformModuleFactory = (deps) => ({
  id: 'state-register',
  mount: (app, mounted) => {
    app.get('/operator/state-register', async (c) => {
      const guard = await operatorOf(c, mounted.authenticate);
      if ('response' in guard) return guard.response;
      const register = await latestRegister(deps.configEntries);
      const sync = await latestRegisterSync(deps.configEntries);
      const month = await latestAccounts(deps.configEntries, 'month');
      const rows = (await compareWithAccounts(deps.configEntries)) ?? [];
      const names = new Map(register?.units.map((u) => [u.orgnr, u.name]) ?? []);
      const named = (orgnr: string | undefined) => (orgnr ? names.get(orgnr) : undefined);
      return c.json({
        syncedAt: register?.syncedAt ?? null,
        lastGood: sync?.lastGood ?? null,
        failedNights: sync?.failedNights ?? 0,
        units: register?.units.length ?? 0,
        accountsPeriod: month?.period ?? null,
        same: rows.filter((r) => r.kind === 'same').length,
        differences: rows
          .filter((r) => r.kind !== 'same')
          .map((r) => {
            const registerMinistryName = named(r.registerMinistry);
            const accountsMinistryName = named(r.accountsMinistry);
            return {
              ...r,
              ...(registerMinistryName ? { registerMinistryName } : {}),
              ...(accountsMinistryName ? { accountsMinistryName } : {}),
            };
          }),
      });
    });
  },
});
