import { describe, expect, it } from 'vitest';
import { chunkSource, pairReportedRows, type FlowTable } from './blocks/table.js';

const cell = (value: string, source = 'c') => ({
  value,
  sources: [{ chunkId: source, document: 'x' }],
});

const row = (document: string, goal: string, result: string, target = '') => ({
  document,
  cells: { document: cell(document), goal: cell(goal), target: cell(target), result: cell(result) },
});

const table = (rows: FlowTable['rows']): FlowTable => ({
  kind: 'table',
  columns: [
    { key: 'document', label: 'Dokument' },
    { key: 'goal', label: 'Mål' },
    { key: 'target', label: 'Styringsparameter' },
    { key: 'result', label: 'Rapportert resultat' },
  ],
  rows,
  skipped: [],
});

const documents = [
  { id: 'brev', fields: { type: 'Tildelingsbrev', orgs_short: 'DIGDIR', concerned_years: 2024 } },
  { id: 'rapport', fields: { type: 'Årsrapport', orgs_short: 'DIGDIR', concerned_years: 2024 } },
  { id: 'annen', fields: { type: 'Årsrapport', orgs_short: 'DFØ', concerned_years: 2024 } },
];

const pair = {
  primary: { field: 'type', value: 'Tildelingsbrev' },
  reported: { field: 'type', value: 'Årsrapport' },
  key: 'goal',
  group: ['orgs_short', 'concerned_years'],
  threshold: 0.35,
};

describe('table cell sources', () => {
  it('carries the excerpt, headings, version and date of the chunk a cell was built from', () => {
    const source = chunkSource({
      chunkId: 'c1',
      document: '90581',
      title: 'Tildelingsbrev 2024',
      position: 2,
      content: '  Mål 1\n\n  Forvaltningen er effektiv  ',
      headers: ['3. Mål', 'Mål 1'],
      version: '2',
      publishedAt: '2024-12-20T00:00:00.000Z',
    });

    expect(source).toMatchObject({
      chunkId: 'c1',
      excerpt: 'Mål 1 Forvaltningen er effektiv',
      headers: ['3. Mål', 'Mål 1'],
      version: '2',
      publishedAt: '2024-12-20T00:00:00.000Z',
    });
  });

  it('cuts a long excerpt instead of copying the whole chunk', () => {
    const source = chunkSource({ chunkId: 'c1', content: 'ord '.repeat(1000) });

    expect(source.excerpt?.length).toBeLessThan(900);
    expect(source.excerpt?.endsWith('…')).toBe(true);
  });
});

describe('pairing reported results with goals', () => {
  it('fills the result of a tildelingsbrev goal from the årsrapport goal that says the same, once', () => {
    const paired = pairReportedRows(
      table([
        row('brev', 'Forvaltningen i Norge er effektiv og åpen', ''),
        row('brev', 'Digitale tjenester er tilgjengelige for alle', ''),
        row('rapport', 'Mål 1: Forvaltningen i Norge er effektiv og åpen', '82 prosent', 'Mål 1'),
        row('rapport', 'Noe helt annet uten sammenheng', 'ukjent'),
      ]),
      documents,
      pair,
    );

    expect(paired.rows.map((r) => [r.cells.goal?.value, r.cells.result?.value])).toEqual([
      ['Forvaltningen i Norge er effektiv og åpen', '82 prosent'],
      ['Digitale tjenester er tilgjengelige for alle', ''],
      ['Noe helt annet uten sammenheng', 'ukjent'],
    ]);
    expect(paired.rows[0]?.cells.target?.value).toBe('Mål 1');
  });

  it('keeps the same pairing however the rows were ordered in a rerun', () => {
    const brev = row('brev', 'Forvaltningen i Norge er effektiv og åpen', '');
    const rapport = row('rapport', 'Forvaltningen i Norge er effektiv og åpen', '82 prosent');
    const [a, b] = [
      pairReportedRows(table([brev, rapport]), documents, pair),
      pairReportedRows(table([brev, rapport]), documents, pair),
    ];

    expect(a).toEqual(b);
  });

  it('never pairs rows across agencies or years', () => {
    const paired = pairReportedRows(
      table([
        row('brev', 'Forvaltningen i Norge er effektiv og åpen', ''),
        row('annen', 'Forvaltningen i Norge er effektiv og åpen', '99 prosent'),
      ]),
      documents,
      pair,
    );

    expect(paired.rows).toHaveLength(2);
    expect(paired.rows[0]?.cells.result?.value).toBe('');
  });
});
