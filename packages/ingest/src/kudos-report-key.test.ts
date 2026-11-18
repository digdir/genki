import { describe, expect, it } from 'vitest';
import { toIndexDocument } from './index-writer.js';
import {
  fillInKudosFields,
  kudosReportFields,
  kudosReportKeyFields,
  prepareKudosDoc,
} from './kudos.js';

const helsedirektoratet = {
  org_number: 983544622,
  alternative_names: [{ name: 'Helsedirektoratet', type: 'display' }],
};

/** "Årsrapport Helsedirektoratet 2023" as KUDOS lists its three records of it (issue 677). */
const annualReport = (overrides: Record<string, unknown> = {}) =>
  fillInKudosFields({
    uuid: '51fe0107-75c8-40df-9be4-a1942ae099d2',
    title: 'Årsrapport Helsedirektoratet 2023',
    type: 'Årsrapport',
    publish_date: '2024-04-15',
    concerned_year_from: 2023,
    concerned_year_to: 2023,
    owners: [helsedirektoratet],
    recipients: [],
    publishers: [],
    files: [{ uuid: 'f1', url: 'https://kudos.dfo.no/f1.pdf', sha256: '47f17b0a', pages: 151 }],
    ...overrides,
  });

const ministryCopy = () =>
  annualReport({
    uuid: 'fdfac1a8-53a8-4330-8656-d90e3f850bf9',
    title: 'Årsrapport Helsedirektoratet 2023 (HOD)',
    publish_date: '2024-01-01',
    files: [{ uuid: 'f3', url: 'https://kudos.dfo.no/f3.pdf', sha256: '7b0a9029', pages: 151 }],
  });

describe('the report key of a KUDOS record', () => {
  it("a ministry copy and the agency's own annual report share one report key", () => {
    const own = prepareKudosDoc(annualReport(), 1);
    const copy = prepareKudosDoc(ministryCopy(), 1);

    expect(own.report).toMatchObject({
      key: 'årsrapport|983544622|2023|årsrapport helsedirektoratet 2023',
    });
    expect((copy.report as { key: string }).key).toBe((own.report as { key: string }).key);
  });

  it('the report key ignores a trailing ministry abbreviation and letter case', () => {
    const key = (title: string) => kudosReportFields(annualReport({ title })).report?.key;

    expect(key('ÅRSRAPPORT  Helsedirektoratet 2023 (KUD) ')).toBe(
      key('Årsrapport Helsedirektoratet 2023'),
    );
    // Only an abbreviation in capitals is a ministry's; other brackets are part of the title.
    expect(key('Årsrapport Helsedirektoratet 2023 (vedlegg)')).not.toBe(
      key('Årsrapport Helsedirektoratet 2023'),
    );
  });

  it('reports with the same title from different owners or years get different keys', () => {
    const key = (overrides: Record<string, unknown>) =>
      kudosReportFields(annualReport(overrides)).report?.key;
    const base = key({});

    expect(key({ owners: [{ org_number: 974761076, alternative_names: [] }] })).not.toBe(base);
    expect(key({ concerned_year_from: 2022, concerned_year_to: 2022 })).not.toBe(base);
    expect(key({ type: 'Evaluering' })).not.toBe(base);
  });

  it('a record with no concerned years is keyed by its publish year', () => {
    const edition = (publish_date: string) =>
      kudosReportFields(
        annualReport({
          title: 'Indikatorer for integrering',
          type: 'Kartlegging',
          publish_date,
          concerned_year_from: undefined,
          concerned_year_to: undefined,
        }),
      ).report?.key;

    expect(edition('2021-01-01')).toBe('kartlegging|983544622|p2021|indikatorer for integrering');
    expect(edition('2020-01-01')).not.toBe(edition('2021-01-01'));
    expect(edition('2021-06-30')).toBe(edition('2021-01-01'));
  });

  it('a record with no owner org number gets no report key, so it is never grouped', () => {
    expect(kudosReportFields(annualReport({ owners: [{ alternative_names: [] }] }))).toEqual({});
  });

  it("a ministry copy or a record dated 1 January is not the agency's own", () => {
    expect(kudosReportFields(annualReport()).report?.own).toBe(true);
    expect(kudosReportFields(ministryCopy()).report?.own).toBe(false);
    expect(kudosReportFields(annualReport({ publish_date: '2023-01-01' })).report?.own).toBe(false);
    expect(kudosReportFields(annualReport({ publish_date: undefined })).report?.own).toBe(false);
    expect(
      kudosReportFields(annualReport({ title: 'Årsrapport Helsedirektoratet 2023 (HOD)' })).report
        ?.own,
    ).toBe(false);
  });

  it('only a ministry abbreviation in brackets marks a copy; other acronyms are part of the title', () => {
    const fields = (title: string) => kudosReportFields(annualReport({ title })).report;

    expect(fields('Strategi for digitalisering (IKT)')).toMatchObject({
      key: 'årsrapport|983544622|2023|strategi for digitalisering (ikt)',
      own: true,
    });
    expect(fields('Tildelingsbrev 2023 (KDD)')?.key).toBe(
      'årsrapport|983544622|2023|tildelingsbrev 2023',
    );
  });

  it('stores the report fields as one object, which the metadata text leaves out', () => {
    const fields = prepareKudosDoc(annualReport(), 1);

    expect(typeof fields.report).toBe('object');
    expect(Object.keys(fields).filter((k) => k.startsWith('report'))).toEqual(['report']);
  });

  it("stores the record's page count over its files", () => {
    const pages = kudosReportFields(
      annualReport({
        files: [
          { uuid: 'a', pages: 151 },
          { uuid: 'b', pages: 2 },
          { uuid: 'c', mimetype: 'text/html' },
        ],
      }),
    ).report?.pages;

    expect(pages).toBe(153);
  });

  it('reads a title and a publish date in linear time', () => {
    const title = `${'('.repeat(50_000)}${' \t'.repeat(50_000)}A)`;
    const started = performance.now();
    kudosReportFields(annualReport({ title, publish_date: `2024-04-15${' '.repeat(100_000)}` }));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the kudos-report-keys fill', () => {
  it('gives a stored KUDOS document the report fields a fresh ingest would store, in its order', () => {
    const raw = ministryCopy();
    const fresh = toIndexDocument('kudos:x', prepareKudosDoc(raw, 4), [], []).fields;
    const before = Object.fromEntries(Object.entries(fresh).filter(([k]) => k !== 'report'));
    // jsonb gives the keys back in its own order.
    const stored = Object.fromEntries(Object.entries(before).reverse());

    const filled = kudosReportKeyFields({ id: 'kudos:x', record: raw, fields: stored });

    expect(Object.keys(filled)).toEqual(Object.keys(fresh));
    expect(filled).toEqual(fresh);
  });

  it('leaves a record from another source as it is', () => {
    const fields = { title: 'Side' };

    expect(
      kudosReportKeyFields({ id: 'web:x', record: { title: 'Side', type: 'web' }, fields }),
    ).toBe(fields);
  });
});
