import type { PortContext } from '@genai/kernel';
import { textOf, ToolRegistry, type ToolResult } from '@genai/port-tools';
import { describe, expect, it } from 'vitest';
import { appendVersion, InMemoryConfigEntryStore, platformScope } from './config-store.js';
import type { AccountsEntry } from './state-accounts.js';
import type { RegisterNames } from './state-register-names.js';
import type { RegisterSync, RegisterUnit, StateRegister } from './state-register.js';
import { stateOrganisationTool, stateOrganisationToolRef } from './state-organisation-tool.js';

const stat = (orgnr: string, name: string): RegisterUnit => ({ orgnr, name, form: 'STAT' });
const orgl = (orgnr: string, name: string, parent: string): RegisterUnit => ({
  orgnr,
  name,
  form: 'ORGL',
  parent,
});

const dfd = '932384469';
const kdd = '972417858';
const fin = '972417807';
const hod = '983887406';
const digdir = '991825827';
const datatilsynet = '974761467';
const helsedir = '983544622';
const helfo = '986965610';
const skatt = '974761076';
const innkreving = '936295266';
const oppdragskrav = '971648198';
const jd = '972417831';
const paatale = '979529805';

/** The register on 2026-11-16: DFD with Digdir, Datatilsynet and Statsforvalter units. */
const units16Nov: RegisterUnit[] = [
  stat(dfd, 'DIGITALISERINGS- OG FORVALTNINGSDEPARTEMENTET (DFD)'),
  stat(kdd, 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET'),
  stat(fin, 'FINANSDEPARTEMENTET'),
  stat(hod, 'HELSE- OG OMSORGSDEPARTEMENTET'),
  stat(jd, 'JUSTIS- OG BEREDSKAPSDEPARTEMENTET'),
  orgl(paatale, 'DEN HØYERE PÅTALEMYNDIGHET', jd),
  stat('974760347', 'SÁMEDIGGI / SAMETINGET'),
  orgl(digdir, 'DIGITALISERINGSDIREKTORATET', dfd),
  orgl(datatilsynet, 'DATATILSYNET', dfd),
  orgl('974762994', 'STATSFORVALTEREN I AGDER', dfd),
  orgl('974761645', 'STATSFORVALTEREN I INNLANDET', dfd),
  orgl('974760665', 'STATSFORVALTAREN I VESTLAND', dfd),
  orgl('921627009', 'STATSFORVALTERENS FELLESTJENESTER', dfd),
  orgl(helsedir, 'HELSEDIREKTORATET', hod),
  orgl(helfo, 'HELFO', helsedir),
  orgl('974761122', 'DIREKTORATET FOR MEDISINSKE PRODUKTER', hod),
  orgl(skatt, 'SKATTEETATEN', fin),
  orgl(innkreving, 'INNKREVINGSMYNDIGHETEN', skatt),
  orgl(oppdragskrav, 'INNKREVINGSMYNDIGHETEN - OPPDRAGSKRAV', innkreving),
];

/** A later version, for the history: Datatilsynet moved to KDD on 2026-11-20 (made up for the test). */
const units20Nov = units16Nov.map((u) => (u.orgnr === datatilsynet ? { ...u, parent: kdd } : u));

const names: RegisterNames = {
  [dfd]: { display: 'Digitaliserings- og forvaltningsdepartementet', abbreviation: 'DFD' },
  [digdir]: { display: 'Digitaliseringsdirektoratet', abbreviation: 'Digdir' },
  [paatale]: { display: 'Riksadvokaten' },
  ['974760665']: { display: 'Statsforvaltaren i Vestland' },
  ['974761122']: { display: 'Direktoratet for medisinske produkter', abbreviation: 'DMP' },
};

/** The 2022 accounts: Digdir and Datatilsynet booked to KDD. */
const accounts2022: AccountsEntry = {
  period: '202212',
  ministries: { '05': kdd, '16': fin },
  agencies: [
    { orgnr: kdd, name: 'Kommunal- og distriktsdepartementet', ministry: kdd },
    { orgnr: digdir, name: 'Digitaliseringsdirektoratet', ministry: kdd },
    { orgnr: datatilsynet, name: 'Datatilsynet', ministry: kdd },
    { orgnr: fin, name: 'Finansdepartementet', ministry: fin },
    { orgnr: skatt, name: 'Skatteetaten', ministry: fin },
  ],
};

/** The latest month, which gives today's ministries. */
const accountsMonth: AccountsEntry = {
  period: '202609',
  ministries: { '05': kdd, '15': dfd, '16': fin },
  agencies: [
    { orgnr: dfd, name: 'Digitaliserings- og forvaltningsdepartementet', ministry: dfd },
    { orgnr: digdir, name: 'Digitaliseringsdirektoratet', ministry: dfd },
    { orgnr: datatilsynet, name: 'Datatilsynet', ministry: dfd },
    { orgnr: kdd, name: 'Kommunal- og distriktsdepartementet', ministry: kdd },
    { orgnr: fin, name: 'Finansdepartementet', ministry: fin },
    { orgnr: skatt, name: 'Skatteetaten', ministry: fin },
  ],
};

const save = <T>(
  configEntries: InMemoryConfigEntryStore,
  kind: string,
  id: string,
  spec: T,
  at: string,
) =>
  appendVersion<T>(configEntries, {
    kind,
    scope: platformScope,
    id,
    spec,
    deleted: false,
    by: 'worker',
    reason: 'test',
    at,
  });

const stored = async (
  opts: { history?: boolean; historyAt?: string; extra?: RegisterUnit[] } = {},
) => {
  const configEntries = new InMemoryConfigEntryStore();
  const register = (units: RegisterUnit[], at: string): StateRegister => ({
    units,
    changes: [],
    syncedAt: at,
  });
  await save(
    configEntries,
    'state-register',
    'enhetsregisteret',
    register([...units16Nov, ...(opts.extra ?? [])], '2026-11-16T13:49:00.000Z'),
    '2026-11-16T13:49:00.000Z',
  );
  if (opts.history)
    await save(
      configEntries,
      'state-register',
      'enhetsregisteret',
      register(units20Nov, opts.historyAt ?? '2026-11-20T01:40:00.000Z'),
      opts.historyAt ?? '2026-11-20T01:40:00.000Z',
    );
  await save<RegisterSync>(
    configEntries,
    'state-register-sync',
    'enhetsregisteret',
    {
      lastGood: opts.history ? '2026-11-21T01:40:00.000Z' : '2026-11-17T01:40:00.000Z',
      failedNights: 0,
    },
    opts.history ? '2026-11-21T01:40:00.000Z' : '2026-11-17T01:40:00.000Z',
  );
  await save(configEntries, 'state-register-names', 'kudos', names, '2026-11-16T13:50:00.000Z');
  await save(
    configEntries,
    'state-accounts',
    'year-2022',
    accounts2022,
    '2026-11-16T13:51:00.000Z',
  );
  await save(configEntries, 'state-accounts', 'month', accountsMonth, '2026-11-16T13:51:00.000Z');
  return configEntries;
};

const ctx = (capability = 'svc') =>
  ({
    tenant: '991825827',
    principal: { kind: 'service', id: 'test' },
    task: 'task-1',
    capability,
    signal: new AbortController().signal,
    meter: async () => {},
  }) as unknown as PortContext;

interface Answer {
  source: string;
  as_of: string;
  cite: { nb: string; en: string };
  credit: { nb: string; en: string; licence: string; source: string };
  unit?: { orgnr: string; name: string };
  units: {
    orgnr: string;
    name: string;
    display?: string;
    abbreviation?: string;
    level?: number;
    parent?: string;
    units_under?: number;
  }[];
  filter_values?: Record<string, string[]>;
  note?: string;
}

const toolOn = async (
  opts: {
    history?: boolean;
    historyAt?: string;
    empty?: boolean;
    extra?: RegisterUnit[];
    filterFields?: readonly string[];
  } = {},
) => {
  const configEntries = opts.empty ? new InMemoryConfigEntryStore() : await stored(opts);
  const registry = new ToolRegistry().register(
    stateOrganisationTool({
      configEntries,
      filterFields: async (capability) =>
        capability === 'svc' ? (opts.filterFields ?? ['owner_orgnr', 'recipient_orgnr']) : [],
    }),
  );
  const port = registry.open({ kind: 'tool', id: stateOrganisationToolRef }, ctx());
  return {
    port,
    call: async (input: unknown): Promise<ToolResult> => port.call(input),
    answer: async (input: unknown): Promise<Answer> => {
      const result = await port.call(input);
      expect(result.isError, textOf(result)).toBeFalsy();
      return JSON.parse(textOf(result)) as Answer;
    },
  };
};

const orgnrs = (a: Answer) => a.units.map((u) => u.orgnr).sort();

describe('the state-organisation tool', () => {
  it('lists the units directly under a ministry with source and date', async () => {
    const { answer } = await toolOn();

    const a = await answer({ action: 'under', unit: dfd });

    expect(a.source).toBe('Enhetsregisteret');
    expect(a.as_of).toBe('2026-11-17');
    expect(a.cite.nb).toBe('Kilde: Enhetsregisteret, per 17.11.2026.');
    expect(a.unit).toMatchObject({ orgnr: dfd });
    expect(orgnrs(a)).toEqual(
      [digdir, datatilsynet, '974762994', '974761645', '974760665', '921627009'].sort(),
    );
    expect(a.units.find((u) => u.orgnr === digdir)).toMatchObject({
      name: 'DIGITALISERINGSDIREKTORATET',
      display: 'Digitaliseringsdirektoratet',
      abbreviation: 'Digdir',
      level: 1,
      parent: dfd,
    });
  });

  it('lists deeper levels under a unit only when asked for depth', async () => {
    const { answer } = await toolOn();

    const shallow = await answer({ action: 'under', unit: fin });
    const deep = await answer({ action: 'under', unit: fin, depth: 3 });

    expect(orgnrs(shallow)).toEqual([skatt]);
    expect(shallow.units[0]?.units_under).toBe(1);
    expect(orgnrs(deep)).toEqual([skatt, innkreving, oppdragskrav].sort());
    expect(deep.units.find((u) => u.orgnr === oppdragskrav)).toMatchObject({
      level: 3,
      parent: innkreving,
    });
  });

  it('refuses a depth above 3', async () => {
    const { call } = await toolOn();

    const result = await call({ action: 'under', unit: fin, depth: 4 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/depth.*<=3/);
  });

  it("lists the state's top units when under names no unit", async () => {
    const { answer } = await toolOn();

    const a = await answer({ action: 'under' });

    expect(a.unit).toBeUndefined();
    expect(orgnrs(a)).toEqual([dfd, kdd, fin, hod, jd, '974760347'].sort());
    expect(a.units.find((u) => u.orgnr === dfd)).toMatchObject({
      abbreviation: 'DFD',
      units_under: 6,
    });
  });

  it('walks a unit up to its ministry', async () => {
    const { answer } = await toolOn();

    const a = await answer({ action: 'over', unit: oppdragskrav });

    expect(a.units.map((u) => u.orgnr)).toEqual([innkreving, skatt, fin]);
    expect(a.unit).toMatchObject({ orgnr: oppdragskrav });
    expect(a.source).toBe('Enhetsregisteret');
  });

  it('finds a unit by its official name, KUDOS display name or abbreviation', async () => {
    const { answer } = await toolOn();

    const official = await answer({ action: 'find', name: 'Den høyere påtalemyndighet' });
    const display = await answer({ action: 'find', name: 'riksadvokaten' });
    const abbreviation = await answer({ action: 'find', name: 'DIGDIR' });

    expect(orgnrs(official)).toEqual([paatale]);
    expect(orgnrs(display)).toEqual([paatale]);
    expect(orgnrs(abbreviation)).toEqual([digdir]);
  });

  it('finds a unit whatever accents the name is written with', async () => {
    const { answer } = await toolOn();

    const plain = await answer({ action: 'find', name: 'Samediggi' });

    expect(orgnrs(plain)).toEqual(['974760347']);
  });

  it('finds the units whose name words start with every query word, at most 20', async () => {
    const { answer } = await toolOn();

    const group = await answer({ action: 'find', name: 'statsforval' });
    const two = await answer({ action: 'find', name: 'statsforvalteren i' });

    expect(orgnrs(group)).toEqual(['974762994', '974761645', '974760665', '921627009'].sort());
    expect(orgnrs(two)).toEqual(['974762994', '974761645'].sort());
    expect(group.units.length).toBeLessThanOrEqual(20);
  });

  it('does not find a unit by a KUDOS old name', async () => {
    const { answer } = await toolOn();

    const a = await answer({ action: 'find', name: 'Statens legemiddelverk' });

    expect(a.units).toEqual([]);
    expect(a.note).toMatch(/old name|tidligere navn/i);
  });

  it('matches a name in linear time on a long adversarial string', async () => {
    const { answer } = await toolOn();
    const quickly = async (name: string) => {
      const started = performance.now();
      await answer({ action: 'find', name });
      return performance.now() - started;
    };

    expect(await quickly(`${'a '.repeat(99)}x`)).toBeLessThan(1000);
    expect(await quickly('statsforval'.repeat(18))).toBeLessThan(1000);
    expect(await quickly(`${'-'.repeat(190)}x`)).toBeLessThan(1000);
  });

  it('answers under and over for a past date from the register version on that date', async () => {
    const { answer } = await toolOn({ history: true });

    const underBefore = await answer({ action: 'under', unit: dfd, date: '2026-11-18' });
    const underNow = await answer({ action: 'under', unit: dfd });
    const overBefore = await answer({ action: 'over', unit: datatilsynet, date: '2026-11-18' });
    const overNow = await answer({ action: 'over', unit: datatilsynet });

    expect(orgnrs(underBefore)).toContain(datatilsynet);
    expect(underBefore.as_of).toBe('2026-11-16');
    expect(orgnrs(underNow)).not.toContain(datatilsynet);
    expect(underNow.as_of).toBe('2026-11-21');
    expect(overBefore.units.map((u) => u.orgnr)).toEqual([dfd]);
    expect(overNow.units.map((u) => u.orgnr)).toEqual([kdd]);
  });

  it('answers a date from the register version read by the end of that day in Oslo', async () => {
    const { answer } = await toolOn({ history: true, historyAt: '2026-11-20T23:30:00.000Z' });

    const sameUtcDay = await answer({ action: 'over', unit: datatilsynet, date: '2026-11-20' });
    const nextOsloDay = await answer({ action: 'over', unit: datatilsynet, date: '2026-11-21' });

    expect(sameUtcDay.units.map((u) => u.orgnr)).toEqual([dfd]);
    expect(sameUtcDay.as_of).toBe('2026-11-16');
    expect(nextOsloDay.units.map((u) => u.orgnr)).toEqual([kdd]);
    expect(nextOsloDay.as_of).toBe('2026-11-21');
  });

  it("answers under before the first register version from that year's state accounts, flat and labelled", async () => {
    const { answer } = await toolOn();

    const under = await answer({ action: 'under', unit: kdd, date: '2022-06-01', depth: 2 });
    const over = await answer({ action: 'over', unit: digdir, date: '2022-06-01' });

    expect(under.source).toBe('Statsregnskapet');
    expect(under.as_of).toBe('2022');
    expect(under.cite.nb).toBe('Kilde: Statsregnskapet (DFØ), 2022.');
    expect(under.credit.nb).toMatch(/DFØ/);
    expect(orgnrs(under)).toEqual([digdir, datatilsynet].sort());
    expect(under.units.every((u) => u.level === 1)).toBe(true);
    expect(under.note).toMatch(/one level|ett nivå/i);
    expect(over.units.map((u) => u.orgnr)).toEqual([kdd]);
    expect(over.source).toBe('Statsregnskapet');
  });

  it('gives owner_orgnr filter values only for a dataset that declares the field', async () => {
    const declared = await toolOn({ filterFields: ['owner_orgnr', 'orgs_long'] });
    const undeclared = await toolOn({ filterFields: ['orgs_long', 'type'] });

    const withField = await declared.answer({ action: 'under', unit: dfd });
    const without = await undeclared.answer({ action: 'under', unit: dfd });

    expect(withField.filter_values).toEqual({ owner_orgnr: orgnrs(withField) });
    expect(without.filter_values).toBeUndefined();
  });

  it('offers only owner_orgnr when a dataset declares both org-number fields', async () => {
    const { answer } = await toolOn({ filterFields: ['owner_orgnr', 'recipient_orgnr'] });

    const a = await answer({ action: 'under', unit: dfd });

    expect(Object.keys(a.filter_values ?? {})).toEqual(['owner_orgnr']);
  });

  it('gives no filter values for more than 100 units, and says why', async () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      orgl(String(900000000 + i), `KONTOR ${i}`, hod),
    );
    const { answer } = await toolOn({ extra: many });

    const a = await answer({ action: 'under', unit: hod });

    expect(a.units.length).toBeGreaterThan(100);
    expect(a.filter_values).toBeUndefined();
    expect(a.note).toMatch(/More than 100 units/);
  });

  it('marks unit names as untrusted data before the model sees them', async () => {
    const { call } = await toolOn();

    const result = await call({ action: 'under', unit: dfd });

    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.parts.every((p) => p.meta?.untrusted === true)).toBe(true);
  });

  it('credits NLOD and the licensor in every answer', async () => {
    const { answer } = await toolOn();

    for (const input of [
      { action: 'under' },
      { action: 'over', unit: digdir },
      { action: 'find', name: 'Digdir' },
    ]) {
      const a = await answer(input);
      expect(a.credit.nb).toBe(
        'Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Brønnøysundregistrene.',
      );
      expect(a.credit.en).toBe(
        'Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Brønnøysundregistrene.',
      );
      expect(a.credit.licence).toBe('https://data.norge.no/nlod/no/2.0');
      expect(a.credit.source).toBe('https://virksomhet.brreg.no/nb/oppslag/enheter');
    }
  });

  it('lists at most 20 units a name finds, and says how many matched', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      orgl(String(910000000 + i), `REGIONKONTOR ${i}`, hod),
    );
    const { answer } = await toolOn({ extra: many });

    const a = await answer({ action: 'find', name: 'regionkontor' });

    expect(a.units).toHaveLength(20);
    expect(a.note).toMatch(/25 units match/);
  });

  it('refuses find and the top units before the first register version', async () => {
    const { call } = await toolOn();

    const find = await call({ action: 'find', name: 'Digdir', date: '2022-06-01' });
    const top = await call({ action: 'under', date: '2022-06-01' });

    expect(find.isError).toBe(true);
    expect(textOf(find)).toMatch(/find works from the register/);
    expect(top.isError).toBe(true);
    expect(textOf(top)).toMatch(/top units are known only from the register/);
  });

  it('refuses a date that does not exist', async () => {
    const { call } = await toolOn();

    const result = await call({ action: 'over', unit: digdir, date: '2022-13-45' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no such date/);
  });

  it('says the register is not synced yet when none is stored', async () => {
    const { call } = await toolOn({ empty: true });

    const result = await call({ action: 'under', unit: dfd });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not synced yet/);
  });
});
