import {
  accountsMonthUrl,
  brregUnitsUrl,
  InMemoryConfigEntryStore,
  latestAccounts,
  latestRegister,
  syncRegister,
  type GuardedRequest,
  type KudosActorPages,
} from '@genai/composition';
import {
  accountsMonthFixture,
  registerFixture,
} from '@genai/composition/state-register.test-utils';
import { describe, expect, it } from 'vitest';
import { afterRegisterSync, syncRegisterAtStart } from './state-register-job.js';

const now = () => new Date('2026-11-17T01:40:00Z');

/** Answers from the fixtures, minus any URL left out; records what was asked. */
const guardFor = (leaveOut: string[] = []) => {
  const asked: string[] = [];
  const guard: GuardedRequest = {
    request: async (_allow, url) => {
      asked.push(url);
      if (leaveOut.includes(url)) return { status: 503, body: '' };
      const answer = registerFixture[url] ?? accountsMonthFixture[url];
      if (answer === undefined) return { status: 404, body: '' };
      return typeof answer === 'string'
        ? { status: 200, body: answer }
        : { status: 200, body: '', bytes: answer };
    },
  };
  return { guard, asked };
};

const kudosFor = () => {
  const pages: number[] = [];
  const kudos: KudosActorPages = {
    actors: async (n) => {
      pages.push(n);
      return { data: [], meta: { current_page: 1, last_page: 1 } };
    },
  };
  return { kudos, pages };
};

const lease = (held: boolean) => ({ tryAcquire: async () => held });
const log = () => undefined;

describe('the state register job in the worker', () => {
  it('reads the register at start only when none is stored and the lease is held', async () => {
    const fresh = new InMemoryConfigEntryStore();
    const withoutLease = new InMemoryConfigEntryStore();
    const known = new InMemoryConfigEntryStore();
    await syncRegister({ configEntries: known, guard: guardFor().guard, now });
    const runs = [
      { configEntries: fresh, held: true, ...guardFor() },
      { configEntries: withoutLease, held: false, ...guardFor() },
      { configEntries: known, held: true, ...guardFor() },
    ];

    for (const run of runs)
      await syncRegisterAtStart({
        configEntries: run.configEntries,
        guard: run.guard,
        kudos: kudosFor().kudos,
        lease: lease(run.held),
        now,
        log,
        years: [],
      });

    expect(runs.map((r) => r.asked.includes(brregUnitsUrl('STAT', 0)))).toEqual([
      true,
      false,
      false,
    ]);
    expect(await latestRegister(fresh)).toBeDefined();
    expect(await latestRegister(withoutLease)).toBeUndefined();
  });

  it('reads the state accounts and the KUDOS names only after a good register sync', async () => {
    const failed = { configEntries: new InMemoryConfigEntryStore(), ...guardFor(), ...kudosFor() };
    const good = { configEntries: new InMemoryConfigEntryStore(), ...guardFor(), ...kudosFor() };

    for (const [run, ok] of [
      [failed, false],
      [good, true],
    ] as const)
      await afterRegisterSync({
        configEntries: run.configEntries,
        guard: run.guard,
        kudos: run.kudos,
        now,
        log,
        years: [],
      })({ ok });

    expect(failed.asked).not.toContain(accountsMonthUrl);
    expect(failed.pages).toEqual([]);
    expect(good.asked).toContain(accountsMonthUrl);
    expect((await latestAccounts(good.configEntries, 'month'))?.period).toBe('202609');
  });
});
