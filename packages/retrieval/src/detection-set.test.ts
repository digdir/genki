import { describe, expect, it } from 'vitest';
import type { FacetValue } from '@genai/port-knowledge';
import { detectOrganisations, type AliasTable } from './stages.js';
import { queryYearsIn } from './text.js';

const values = (...names: string[]): FacetValue[] =>
  names.map((value, i) => ({ value, count: 100 - i }));

const snapshot: Record<string, FacetValue[]> = {
  orgs_long: values(
    'Direktoratet for forvaltning og økonomistyring',
    'Datatilsynet',
    'Arbeids- og velferdsdirektoratet',
    'Digitaliseringsdirektoratet',
    'Skatteetaten',
    'Statens vegvesen',
    'Helsedirektoratet',
    'Bærum kommune',
    'Tromsø kommune',
    'IT',
  ),
  orgs_short: [],
};
const fields = ['orgs_long', 'orgs_short'];
const aliases: AliasTable = {
  DFØ: ['DFO', 'Direktoratet for forvaltning og økonomistyring'],
  NAV: ['Arbeids- og velferdsdirektoratet'],
  Digdir: ['Digitaliseringsdirektoratet'],
};

const dfo = 'Direktoratet for forvaltning og økonomistyring';

const cases: { query: string; orgs: string[]; years: string[] }[] = [
  { query: 'Hva sier DFØ om Datatilsynet?', orgs: ['Datatilsynet', dfo], years: [] },
  { query: 'DFO evaluering av digitaliseringsrundskrivet 2023', orgs: [dfo], years: ['2023'] },
  { query: 'dfø årsrapport 2022', orgs: [dfo], years: ['2022'] },
  { query: 'DFOs rapport om konsulentbruk', orgs: [dfo], years: [] },
  {
    query: 'Direktoratet for forvaltning og okonomistyring tildelingsbrev',
    orgs: [dfo],
    years: [],
  },
  { query: 'NAV sin digitalisering', orgs: ['Arbeids- og velferdsdirektoratet'], years: [] },
  { query: 'Digdirs strategi for 2024', orgs: ['Digitaliseringsdirektoratet'], years: ['2024'] },
  { query: 'Baerum kommune budsjett 2024', orgs: ['Bærum kommune'], years: ['2024'] },
  { query: 'Tromso kommune digitalisering', orgs: ['Tromsø kommune'], years: [] },
  {
    query: 'Hva sier Statens vegvesen og Skatteetaten om skytjenester i 2021 og 2022?',
    orgs: ['Skatteetaten', 'Statens vegvesen'],
    years: ['2021', '2022'],
  },
  { query: 'Helsedirektoratets tildelingsbrev 2024', orgs: ['Helsedirektoratet'], years: ['2024'] },
  { query: 'Skatteetatenes samarbeid', orgs: [], years: [] },
  { query: 'Kostnad på 2000 kroner i 2023', orgs: [], years: ['2023'] },
  { query: '200 ansatte i 2019', orgs: [], years: ['2019'] },
  { query: 'IT-strategi for staten', orgs: [], years: [] },
];

const detectedOrgs = (query: string, table: AliasTable = aliases) =>
  detectOrganisations([query], snapshot, fields, 3, table)
    .flatMap((d) => d.values)
    .sort();

describe('the offline detection set', () => {
  it.each(cases)('$query names $orgs', ({ query, orgs }) => {
    expect(detectedOrgs(query)).toEqual([...orgs].sort());
  });

  it.each(cases)('$query has the years $years', ({ query, years }) => {
    expect([...queryYearsIn(query)].sort()).toEqual(years);
  });

  it('without aliases a query that says DFØ misses a facet that only has the long name', () => {
    expect(detectedOrgs('Hva sier DFØ om Datatilsynet?', {})).toEqual(['Datatilsynet']);
  });
});

describe('aliases and folding', () => {
  it('reports the indexed value when a query names an alias', () => {
    expect(detectOrganisations(['hva sier DFO'], snapshot, fields, 3, aliases)).toEqual([
      { field: 'orgs_long', values: [dfo], queries: ['hva sier DFO'] },
    ]);
  });

  it('an alias group reports nothing when none of its names is indexed', () => {
    expect(detectedOrgs('KS mener', { KS: ['Kommunesektorens organisasjon'] })).toEqual([]);
  });

  it('an alias shorter than the minimum value length still matches', () => {
    expect(detectedOrgs('KS mener', { KS: ['Datatilsynet'] })).toEqual(['Datatilsynet']);
  });

  it('an alias matches an indexed value regardless of case', () => {
    expect(
      detectedOrgs('DFO mener', { DFO: ['direktoratet for forvaltning og ØKONOMISTYRING'] }),
    ).toEqual([dfo]);
  });

  it('folds æ, ø and å when the folded value is unique in the field', () => {
    expect(detectedOrgs('Baerum kommune og Tromso kommune', {})).toEqual([
      'Bærum kommune',
      'Tromsø kommune',
    ]);
  });

  it('does not fold a value that collides with another value after folding', () => {
    const facets = { org: values('Bærum', 'Baerum') };
    expect(detectOrganisations(['baerum'], facets, ['org'], 3)).toEqual([
      { field: 'org', values: ['Baerum'], queries: ['baerum'] },
    ]);
    expect(detectOrganisations(['bærum'], facets, ['org'], 3)).toEqual([
      { field: 'org', values: ['Bærum'], queries: ['bærum'] },
    ]);
  });

  it('does not fold values shorter than three characters', () => {
    const facets = { org: values('Øy') };
    expect(detectOrganisations(['Oy'], facets, ['org'], 2)).toEqual([]);
    expect(detectOrganisations(['øy'], facets, ['org'], 2)).toEqual([
      { field: 'org', values: ['Øy'], queries: ['øy'] },
    ]);
  });
});

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('detection on adversarial input', () => {
  const many = {
    org: values(...Array.from({ length: 500 }, (_, i) => `${'aø '.repeat(8)}direktoratet ${i}`)),
  };
  const table = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`${'å'.repeat(10)}${i}`, [`aø aø direktoratet ${i}`]]),
  );

  it('detects in linear time on long runs of repeated words', () => {
    expect(
      quickly(() => detectOrganisations(['aø '.repeat(40_000)], many, ['org'], 3, table)),
    ).toBeLessThan(1000);
  });

  it('detects in linear time on long runs of letters that fold', () => {
    expect(
      quickly(() => detectOrganisations(['æøå'.repeat(40_000)], many, ['org'], 3, table)),
    ).toBeLessThan(1000);
  });
});
