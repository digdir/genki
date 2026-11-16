import { describe, expect, it } from 'vitest';
import { syncAccounts, syncRegister, type GuardedRequest } from '@genai/composition';
import { bootPlatform, principals } from './testkit.js';
import {
  accountsMonthFixture,
  registerFixture,
} from '@genai/composition/state-register.test-utils';

const guard: GuardedRequest = {
  request: async (_allow, url) => {
    const answer = registerFixture[url] ?? accountsMonthFixture[url];
    if (answer === undefined) return { status: 404, body: '' };
    return typeof answer === 'string'
      ? { status: 200, body: answer }
      : { status: 200, body: '', bytes: answer };
  },
};

const booted = async () => {
  const platform = await bootPlatform({ people: principals });
  const now = () => new Date('2026-11-17T01:40:00Z');
  await syncRegister({ configEntries: platform.configEntries, guard, now });
  await syncAccounts({ configEntries: platform.configEntries, guard, now, years: [] });
  return platform;
};

describe('the state register for operators', () => {
  it('refuses the register comparison to anyone who is not an operator', async () => {
    const { app, send } = await booted();

    const nobody = await app.request('/operator/state-register');
    const employee = await send('/operator/state-register', 'kari');
    const operator = await send('/operator/state-register', 'operator');

    expect(nobody.status).toBe(401);
    expect(employee.status).toBe(403);
    expect(operator.status).toBe(200);
  });

  it('gives operators the sync date and every difference with the state accounts, named', async () => {
    const { send } = await booted();

    const body = (await (await send('/operator/state-register', 'operator')).json()) as {
      syncedAt: string;
      units: number;
      accountsPeriod: string;
      same: number;
      differences: {
        orgnr: string;
        name: string;
        kind: string;
        registerMinistryName?: string;
        accountsMinistryName?: string;
      }[];
    };

    expect(body.syncedAt).toBe('2026-11-17T01:40:00.000Z');
    expect(body.units).toBe(7);
    expect(body.accountsPeriod).toBe('202609');
    expect(body.same).toBe(1);
    expect(body.differences).toEqual([
      {
        orgnr: '974760223',
        name: 'Riksrevisjonen',
        kind: 'budget-booking',
        registerMinistry: '971524960',
        registerMinistryName: 'STORTINGET',
        accountsMinistry: '972417807',
        accountsMinistryName: 'FINANSDEPARTEMENTET',
      },
      {
        orgnr: '974761076',
        name: 'Skatteetaten',
        kind: 'mismatch',
        registerMinistry: '972417807',
        registerMinistryName: 'FINANSDEPARTEMENTET',
        accountsMinistry: '972417858',
        accountsMinistryName: 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET',
      },
    ]);
  });
});
