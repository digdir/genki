import type { Clock } from '@genai/jobs';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import type { GuardedRequest } from './exchange-rates.js';
import {
  brregUnitsUrl,
  latestRegister,
  latestRegisterSync,
  ministryChain,
  registerVersions,
  scheduleRegisterSync,
  stateTree,
  syncRegister,
  type RegisterUnit,
} from './state-register.js';

type Form = 'STAT' | 'ORGL' | 'KOMM';
const unit = (orgnr: string, name: string, form: Form, parent?: string) => ({
  organisasjonsnummer: orgnr,
  navn: name,
  organisasjonsform: { kode: form },
  ...(parent ? { overordnetEnhet: parent } : {}),
});

/** A page of `enheter`, as data.brreg.no answers with `size=1000`. */
const page = (units: ReturnType<typeof unit>[], total = units.length, totalPages = 1, n = 0) =>
  JSON.stringify({
    _embedded: { enheter: units },
    page: { size: 1000, totalElements: total, totalPages, number: n },
  });

const dfd = unit('932384469', 'DIGITALISERINGS- OG FORVALTNINGSDEPARTEMENTET (DFD)', 'STAT');
const fin = unit('972417807', 'FINANSDEPARTEMENTET', 'STAT');
const kdd = unit('972417858', 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET', 'STAT');
const digdir = unit('991825827', 'DIGITALISERINGSDIREKTORATET', 'ORGL', '932384469');
const skatt = unit('974761076', 'SKATTEETATEN', 'ORGL', '972417807');
const innkreving = unit('936295266', 'INNKREVINGSMYNDIGHETEN', 'ORGL', '974761076');
/** A municipality's own unit: ORGL, but its parent is a KOMM, not the state. */
const municipal = unit('976819853', 'ALSTAHAUG KOMMUNE TEKNISK ETAT', 'ORGL', '959469059');

/** A guard that answers each URL from a table, and records what it was asked. */
const guardFor = (answers: Record<string, string | Error>) => {
  const asked: { allow: unknown; url: string }[] = [];
  const guard: GuardedRequest = {
    request: async (allow, url) => {
      asked.push({ allow, url });
      const answer = answers[url];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return { status: 404, body: '' };
      return { status: 200, body: answer };
    },
  };
  return { guard, asked };
};

const night = (day: string) => new Date(`${day}T01:40:00Z`);

const registerOf = (stat: ReturnType<typeof unit>[], orgl: ReturnType<typeof unit>[]) => ({
  [brregUnitsUrl('STAT', 0)]: page(stat),
  [brregUnitsUrl('ORGL', 0)]: page(orgl),
});

describe('the state register', () => {
  it('keeps the state tree from a pull of STAT and ORGL units and leaves municipal units out', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard } = guardFor(registerOf([dfd, fin], [digdir, skatt, innkreving, municipal]));

    await syncRegister({ configEntries, guard, now: () => night('2026-11-17') });

    const register = await latestRegister(configEntries);
    expect(register?.units.map((u) => u.orgnr).sort()).toEqual(
      ['932384469', '972417807', '991825827', '974761076', '936295266'].sort(),
    );
    expect(register?.syncedAt).toBe('2026-11-17T01:40:00.000Z');
  });

  it('walks a unit at any depth up to its ministry', () => {
    const units = stateTree(
      [dfd, fin, digdir, skatt, innkreving].map((u): RegisterUnit => ({
        orgnr: u.organisasjonsnummer,
        name: u.navn,
        form: u.organisasjonsform.kode as 'STAT' | 'ORGL',
        ...(u.overordnetEnhet ? { parent: u.overordnetEnhet } : {}),
      })),
    );

    expect(ministryChain(units, '936295266').map((u) => u.orgnr)).toEqual([
      '936295266',
      '974761076',
      '972417807',
    ]);
    expect(ministryChain(units, '991825827').at(-1)?.name).toBe(
      'DIGITALISERINGS- OG FORVALTNINGSDEPARTEMENTET (DFD)',
    );
    expect(ministryChain(units, '000000000')).toEqual([]);
  });

  it('records a unit whose parent changed, dated the night the sync saw it', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const digdirUnderKdd = unit('991825827', 'DIGITALISERINGSDIREKTORATET', 'ORGL', '972417858');
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd, kdd], [digdirUnderKdd])).guard,
      now: () => night('2024-01-22'),
    });

    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd, kdd], [digdir])).guard,
      now: () => night('2024-01-23'),
    });

    const versions = await registerVersions(configEntries);
    expect(versions).toHaveLength(2);
    expect(versions[1]?.at).toBe('2024-01-23T01:40:00.000Z');
    expect(versions[1]?.register.changes).toEqual([
      {
        change: 'parent',
        orgnr: '991825827',
        name: 'DIGITALISERINGSDIREKTORATET',
        from: '972417858',
        to: '932384469',
      },
    ]);
  });

  it('records a unit that appears as new and one that disappears as removed', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd, fin], [digdir, skatt])).guard,
      now: () => night('2025-10-03'),
    });

    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd, fin], [skatt, innkreving])).guard,
      now: () => night('2025-10-04'),
    });

    const changes = (await latestRegister(configEntries))?.changes ?? [];
    expect(changes).toEqual(
      expect.arrayContaining([
        { change: 'new', orgnr: '936295266', name: 'INNKREVINGSMYNDIGHETEN', to: '974761076' },
        {
          change: 'removed',
          orgnr: '991825827',
          name: 'DIGITALISERINGSDIREKTORATET',
          from: '932384469',
        },
      ]),
    );
    expect(changes).toHaveLength(2);
  });

  it('leaves the register as it was when a pull fails or returns fewer units than it reported', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd, fin], [digdir, skatt])).guard,
      now: () => night('2026-11-16'),
    });
    const before = await registerVersions(configEntries);

    const failures = [
      {
        [brregUnitsUrl('STAT', 0)]: page([dfd, fin]),
        [brregUnitsUrl('ORGL', 0)]: new Error('reset'),
      },
      {
        [brregUnitsUrl('STAT', 0)]: page([dfd, fin]),
        [brregUnitsUrl('ORGL', 0)]: page([digdir], 2),
      },
      { [brregUnitsUrl('STAT', 0)]: page([]), [brregUnitsUrl('ORGL', 0)]: page([]) },
      {
        [brregUnitsUrl('STAT', 0)]: page([dfd, fin]),
        [brregUnitsUrl('ORGL', 0)]: page([digdir], 2, 2),
      },
    ];
    const results = [];
    for (const [i, answers] of failures.entries())
      results.push(
        await syncRegister({
          configEntries,
          guard: guardFor(answers).guard,
          now: () => night(`2026-11-${17 + i}`),
        }),
      );

    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(await registerVersions(configEntries)).toEqual(before);
  });

  it('reads every page Brønnøysund reports for a form', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard, asked } = guardFor({
      [brregUnitsUrl('STAT', 0)]: page([dfd]),
      [brregUnitsUrl('ORGL', 0)]: page([digdir], 1001, 2),
      [brregUnitsUrl('ORGL', 1)]: page([skatt], 1001, 2, 1),
    });

    await syncRegister({ configEntries, guard, now: () => night('2026-11-17') });

    expect(asked).toEqual([
      { allow: [{ host: 'data.brreg.no', port: 443 }], url: brregUnitsUrl('STAT', 0) },
      { allow: [{ host: 'data.brreg.no', port: 443 }], url: brregUnitsUrl('ORGL', 0) },
      { allow: [{ host: 'data.brreg.no', port: 443 }], url: brregUnitsUrl('ORGL', 1) },
    ]);
  });

  it('keeps the last good sync and its date when a nightly sync fails', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd], [digdir])).guard,
      now: () => night('2026-11-16'),
    });

    const failed = await syncRegister({
      configEntries,
      guard: guardFor({}).guard,
      now: () => night('2026-11-17'),
    });

    expect(failed.ok).toBe(false);
    expect((await latestRegister(configEntries))?.syncedAt).toBe('2026-11-16T01:40:00.000Z');
    expect(await latestRegisterSync(configEntries)).toEqual(
      expect.objectContaining({ lastGood: '2026-11-16T01:40:00.000Z', failedNights: 1 }),
    );
  });

  it('logs that the register sync is stale after two failed nights in a row', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const stale: number[] = [];
    const onStale = (sync: { failedNights: number }) => stale.push(sync.failedNights);
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd], [digdir])).guard,
      now: () => night('2026-11-16'),
      onStale,
    });

    for (const day of ['2026-11-17', '2026-11-18'])
      await syncRegister({
        configEntries,
        guard: guardFor({}).guard,
        now: () => night(day),
        onStale,
      });
    const afterTwo = [...stale];
    await syncRegister({
      configEntries,
      guard: guardFor(registerOf([dfd], [digdir])).guard,
      now: () => night('2026-11-19'),
      onStale,
    });
    await syncRegister({
      configEntries,
      guard: guardFor({}).guard,
      now: () => night('2026-11-20'),
      onStale,
    });

    expect(afterTwo).toEqual([2]);
    expect(stale).toEqual([2]);
    expect((await latestRegisterSync(configEntries))?.failedNights).toBe(1);
  });

  it('schedules the register sync nightly in Europe/Oslo time under the leader lease', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const armed: Date[] = [];
    const timers: (() => void)[] = [];
    const clock: Clock = {
      now: () => new Date('2026-11-16T12:00:00Z'),
      setTimer: (at, run) => {
        armed.push(at);
        timers.push(run);
        return () => undefined;
      },
    };
    const leases = [false, true];
    const { guard, asked } = guardFor(registerOf([dfd], [digdir]));

    const job = scheduleRegisterSync({
      configEntries,
      guard,
      clock,
      active: async () => leases.shift() ?? false,
    });
    timers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const askedWithoutLease = asked.length;
    timers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    job.stop();

    expect(armed[0]?.toISOString()).toBe('2026-11-17T01:40:00.000Z');
    expect(askedWithoutLease).toBe(0);
    expect(asked.length).toBe(2);
    expect((await latestRegister(configEntries))?.units).toHaveLength(2);
  });
});
