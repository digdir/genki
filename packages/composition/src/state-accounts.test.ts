import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { zipOf } from './state-register.test-utils.js';
import type { GuardedRequest } from './exchange-rates.js';
import {
  accountsMonthUrl,
  accountsYearUrl,
  accountYears,
  checkAgainstAccounts,
  compareWithAccounts,
  latestAccounts,
  ministryOn,
  syncAccounts,
} from './state-accounts.js';
import { brregUnitsUrl, syncRegister } from './state-register.js';

const header =
  '"År";"Periode";"Konto_no";"Fagdepartement_id";"Fagdepartement";"Fagdepartement_Virksomhet_id";"Fagdepartement_Virksomhet";"Virksomhet_id";"Virksomhet";"Beløp"';
const row = (period: string, code: string, ministry: string, orgnr: string, name: string) =>
  `"${period.slice(0, 4)}";"${period}";"1";"${code}";"${ministry}";"${code}";"${ministry}";"${orgnr}";"${name}";"100"`;
const csv = (rows: string[]) => [header, ...rows].join('\r\n') + '\r\n';

const kdd = ['05', 'Kommunal- og distriktsdepartementet'] as const;
const dfd = ['15', 'Digitaliserings- og forvaltningsdepartementet'] as const;
const fin = ['16', 'Finansdepartementet'] as const;

/** The 2022 accounts: Digdir under KDD, as DFØ's 2022 file books it. */
const year2022 = csv([
  row('202212', ...kdd, '972417858', 'Kommunal- og distriktsdepartementet'),
  row('202212', ...kdd, '991825827', 'Digitaliseringsdirektoratet'),
  row('202212', ...fin, '972417807', 'Finansdepartementet'),
  row('202212', ...fin, '974761076', 'Skatteetaten'),
  row('202212', ...fin, '974760223', 'Riksrevisjonen'),
]);

/** Sept 2026: Digdir under DFD; Riksrevisjonen booked under FIN; Skatteetaten booked under KDD by mistake. */
const month202609 = csv([
  row('202609', ...dfd, '932384469', 'Digitaliserings- og forvaltningsdepartementet'),
  row('202609', ...dfd, '991825827', 'Digitaliseringsdirektoratet'),
  row('202609', ...fin, '972417807', 'Finansdepartementet'),
  row('202609', ...fin, '974760223', 'Riksrevisjonen'),
  row('202609', ...kdd, '972417858', 'Kommunal- og distriktsdepartementet'),
  row('202609', ...kdd, '974761076', 'Skatteetaten'),
]);

const brregPage = (units: object[]) =>
  JSON.stringify({
    _embedded: { enheter: units },
    page: { totalElements: units.length, totalPages: 1 },
  });
const u = (orgnr: string, navn: string, kode: string, parent?: string) => ({
  organisasjonsnummer: orgnr,
  navn,
  organisasjonsform: { kode },
  ...(parent ? { overordnetEnhet: parent } : {}),
});
const register = {
  [brregUnitsUrl('STAT', 0)]: brregPage([
    u('932384469', 'DIGITALISERINGS- OG FORVALTNINGSDEPARTEMENTET (DFD)', 'STAT'),
    u('972417807', 'FINANSDEPARTEMENTET', 'STAT'),
    u('972417858', 'KOMMUNAL- OG DISTRIKTSDEPARTEMENTET', 'STAT'),
    u('971524960', 'STORTINGET', 'STAT'),
  ]),
  [brregUnitsUrl('ORGL', 0)]: brregPage([
    u('991825827', 'DIGITALISERINGSDIREKTORATET', 'ORGL', '932384469'),
    u('974761076', 'SKATTEETATEN', 'ORGL', '972417807'),
    u('974760223', 'RIKSREVISJONEN', 'ORGL', '971524960'),
  ]),
};

const guardFor = (answers: Record<string, string | Uint8Array>) => {
  const asked: { allow: unknown; url: string }[] = [];
  const guard: GuardedRequest = {
    request: async (allow, url) => {
      asked.push({ allow, url });
      const answer = answers[url];
      if (answer === undefined) return { status: 404, body: '' };
      return typeof answer === 'string'
        ? { status: 200, body: answer }
        : { status: 200, body: '', bytes: answer };
    },
  };
  return { guard, asked };
};

const files = (months: string = month202609) => ({
  [accountsYearUrl(2022)]: zipOf('statsregnskapet_aar_2022.csv', year2022),
  [accountsMonthUrl]: zipOf('statsregnskapet_siste_maaned.csv', months),
});

const at = (iso: string) => () => new Date(iso);

describe('the state accounts', () => {
  it("loads each agency's ministry per year from the state accounts' yearly files", async () => {
    const configEntries = new InMemoryConfigEntryStore();

    await syncAccounts({
      configEntries,
      guard: guardFor(files()).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [2022],
    });

    const y2022 = await latestAccounts(configEntries, 'year-2022');
    expect(y2022?.period).toBe('202212');
    expect(y2022?.agencies.find((a) => a.orgnr === '991825827')?.ministry).toBe('972417858');
    expect(y2022?.agencies.find((a) => a.orgnr === '974761076')?.ministry).toBe('972417807');
  });

  it("maps the accounts' ministry codes to org numbers through each ministry's own row", async () => {
    const configEntries = new InMemoryConfigEntryStore();

    await syncAccounts({
      configEntries,
      guard: guardFor(files()).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [],
    });

    const month = await latestAccounts(configEntries, 'month');
    expect(month?.period).toBe('202609');
    expect(month?.ministries).toEqual({
      '15': '932384469',
      '16': '972417807',
      '05': '972417858',
    });
    expect(month?.agencies.find((a) => a.orgnr === '974760223')).toEqual({
      orgnr: '974760223',
      name: 'Riksrevisjonen',
      ministry: '972417807',
    });
  });

  it('reads Brønnøysund and DFØ only through the egress guard with their hosts allowed', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard, asked } = guardFor({ ...register, ...files() });

    await syncRegister({ configEntries, guard, now: at('2026-11-17T01:40:00Z') });
    await syncAccounts({ configEntries, guard, now: at('2026-11-17T01:45:00Z'), years: [2022] });

    expect(new Set(asked.map((a) => JSON.stringify(a.allow)))).toEqual(
      new Set([
        JSON.stringify([{ host: 'data.brreg.no', port: 443 }]),
        JSON.stringify([{ host: 'statsregnskapet.dfo.no', port: 443 }]),
      ]),
    );
    for (const { allow, url } of asked)
      expect(new URL(url).hostname).toBe((allow as { host: string }[])[0]?.host);
  });

  it("answers a unit's ministry on a past date from the accounts before the first sync and from recorded changes after it", async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncAccounts({
      configEntries,
      guard: guardFor(files()).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [2022],
    });
    await syncRegister({
      configEntries,
      guard: guardFor(register).guard,
      now: at('2026-11-17T01:40:00Z'),
    });

    const in2022 = await ministryOn(configEntries, '991825827', new Date('2022-06-01T12:00:00Z'));
    const today = await ministryOn(configEntries, '991825827', new Date('2026-11-18T12:00:00Z'));
    const before2014 = await ministryOn(
      configEntries,
      '991825827',
      new Date('2010-06-01T12:00:00Z'),
    );

    expect(in2022).toEqual({
      orgnr: '972417858',
      source: 'Statsregnskapet',
      asOf: '2022',
    });
    expect(today).toEqual({
      orgnr: '932384469',
      source: 'Enhetsregisteret',
      asOf: '2026-11-17T01:40:00.000Z',
    });
    expect(before2014).toBeUndefined();
  });

  it('leaves a budget booking out of the history before the first sync', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncAccounts({
      configEntries,
      guard: guardFor(files()).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [2022],
    });
    await syncRegister({
      configEntries,
      guard: guardFor(register).guard,
      now: at('2026-11-17T01:40:00Z'),
    });

    const riksrevisjonen = await ministryOn(
      configEntries,
      '974760223',
      new Date('2022-06-01T12:00:00Z'),
    );
    const skatteetaten = await ministryOn(
      configEntries,
      '974761076',
      new Date('2022-06-01T12:00:00Z'),
    );

    expect(riksrevisjonen).toBeUndefined();
    expect(skatteetaten?.orgnr).toBe('972417807');
  });

  it('answers a date after the first sync from the register version current on that date', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const underKdd = Object.fromEntries(
      Object.entries(register).map(([url, body]) => [
        url,
        body.replace(
          '"organisasjonsnummer":"991825827","navn":"DIGITALISERINGSDIREKTORATET","organisasjonsform":{"kode":"ORGL"},"overordnetEnhet":"932384469"',
          '"organisasjonsnummer":"991825827","navn":"DIGITALISERINGSDIREKTORATET","organisasjonsform":{"kode":"ORGL"},"overordnetEnhet":"972417858"',
        ),
      ]),
    );
    await syncRegister({
      configEntries,
      guard: guardFor(underKdd).guard,
      now: at('2026-11-17T01:40:00Z'),
    });
    await syncRegister({
      configEntries,
      guard: guardFor(register).guard,
      now: at('2026-11-20T01:40:00Z'),
    });

    const between = await ministryOn(configEntries, '991825827', new Date('2026-11-18T12:00:00Z'));
    const after = await ministryOn(configEntries, '991825827', new Date('2026-11-21T12:00:00Z'));

    expect(between?.orgnr).toBe('972417858');
    expect(after?.orgnr).toBe('932384469');
  });

  it("maps a ministry code to the ministry the latest month gives it when the year's own row has an older name", async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const kmd = ['05', 'Kommunal- og moderniseringsdepartementet'] as const;
    const year2014 = csv([
      row('201412', ...kmd, '972417858', 'Kommunal- og regionaldepartementet'),
      row('201412', ...kmd, '974760347', 'Sametinget'),
      row('201412', ...kmd, '971161264', 'Husbanken'),
    ]);

    await syncAccounts({
      configEntries,
      guard: guardFor({
        ...files(),
        [accountsYearUrl(2014)]: zipOf('statsregnskapet_aar_2014.csv', year2014),
      }).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [2014],
    });

    const y2014 = await latestAccounts(configEntries, 'year-2014');
    expect(y2014?.ministries).toEqual({ '05': '972417858' });
    expect(y2014?.agencies.find((a) => a.orgnr === '971161264')?.ministry).toBe('972417858');
  });

  it('loads a year again until its file reaches December', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const year2026 = (period: string) =>
      zipOf(
        'statsregnskapet_aar_2026.csv',
        csv([
          row(
            period,
            '15',
            'Digitaliserings- og forvaltningsdepartementet',
            '932384469',
            'Digitaliserings- og forvaltningsdepartementet',
          ),
        ]),
      );
    const asked: string[] = [];
    const sync = async (period: string, day: string) => {
      const { guard, asked: urls } = guardFor({
        ...files(),
        [accountsYearUrl(2026)]: year2026(period),
      });
      await syncAccounts({ configEntries, guard, now: at(`${day}T01:45:00Z`), years: [2026] });
      asked.push(...urls.map((u) => u.url).filter((u) => u === accountsYearUrl(2026)));
    };

    await sync('202609', '2026-11-17');
    await sync('202612', '2027-01-17');
    await sync('202612', '2027-02-17');

    expect((await latestAccounts(configEntries, 'year-2026'))?.period).toBe('202612');
    expect(asked).toHaveLength(2);
  });

  it('keeps the latest month on a January night before DFØ has a file for the new year', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard, asked } = guardFor({
      ...files(month202609.replaceAll('202609', '202611')),
      [accountsYearUrl(2026)]: zipOf(
        'statsregnskapet_aar_2026.csv',
        month202609.replaceAll('202609', '202611'),
      ),
    });

    const result = await syncAccounts({
      configEntries,
      guard,
      now: at('2027-01-10T01:45:00Z'),
      years: [2026, 2027],
    });

    expect(result.ok).toBe(true);
    expect((await latestAccounts(configEntries, 'month'))?.period).toBe('202611');
    expect(asked.map((a) => a.url)).not.toContain(accountsYearUrl(2027));
  });

  it('keeps one version of a year whose file has not changed', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const answers = {
      ...files(),
      [accountsYearUrl(2026)]: zipOf('statsregnskapet_aar_2026.csv', month202609),
    };
    for (const day of ['2026-11-17', '2026-11-18'])
      await syncAccounts({
        configEntries,
        guard: guardFor(answers).guard,
        now: at(`${day}T01:45:00Z`),
        years: [2026],
      });

    expect(await configEntries.history('state-accounts', 'platform', 'year-2026')).toHaveLength(1);
  });

  it('reads every year from 2014 to this one', () => {
    expect(accountYears(new Date('2016-03-01T00:00:00Z'))).toEqual([2014, 2015, 2016]);
  });

  it('flags an agency whose ministry differs between the register and the latest state accounts', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard } = guardFor({ ...register, ...files() });
    await syncRegister({ configEntries, guard, now: at('2026-11-17T01:40:00Z') });
    await syncAccounts({ configEntries, guard, now: at('2026-11-17T01:45:00Z'), years: [] });

    const rows = await compareWithAccounts(configEntries);

    expect(rows?.find((r) => r.orgnr === '974761076')).toEqual(
      expect.objectContaining({
        kind: 'mismatch',
        registerMinistry: '972417807',
        accountsMinistry: '972417858',
      }),
    );
    expect(rows?.find((r) => r.orgnr === '991825827')?.kind).toBe('same');
  });

  it('marks a body under Stortinget, SMK, the courts or Sametinget as a budget booking, not a mismatch', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { guard } = guardFor({ ...register, ...files() });
    await syncRegister({ configEntries, guard, now: at('2026-11-17T01:40:00Z') });
    await syncAccounts({ configEntries, guard, now: at('2026-11-17T01:45:00Z'), years: [] });

    const rows = await compareWithAccounts(configEntries);

    expect(rows?.find((r) => r.orgnr === '974760223')).toEqual(
      expect.objectContaining({
        kind: 'budget-booking',
        registerMinistry: '971524960',
        accountsMinistry: '972417807',
      }),
    );
  });

  it('logs a mismatch the first month it appears, not every month', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const logged: string[] = [];
    const onMismatch = (rows: { orgnr: string }[]) => logged.push(...rows.map((r) => r.orgnr));
    await syncRegister({
      configEntries,
      guard: guardFor(register).guard,
      now: at('2026-11-17T01:40:00Z'),
    });

    const months = [month202609, month202609.replaceAll('202609', '202610')];
    for (const [i, text] of months.entries()) {
      await syncAccounts({
        configEntries,
        guard: guardFor(files(text)).guard,
        now: at(`2026-1${1 + i}-17T01:45:00Z`),
        years: [],
      });
      await checkAgainstAccounts({
        configEntries,
        now: at(`2026-1${1 + i}-17T01:50:00Z`),
        onMismatch,
      });
    }

    expect(logged).toEqual(['974761076']);
  });

  it('keeps the stored months when the accounts file cannot be read', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await syncAccounts({
      configEntries,
      guard: guardFor(files()).guard,
      now: at('2026-11-17T01:45:00Z'),
      years: [],
    });

    const result = await syncAccounts({
      configEntries,
      guard: guardFor({ [accountsMonthUrl]: new Uint8Array([1, 2, 3]) }).guard,
      now: at('2026-11-18T01:45:00Z'),
      years: [],
    });

    expect(result.ok).toBe(false);
    expect((await latestAccounts(configEntries, 'month'))?.period).toBe('202609');
  });
});
