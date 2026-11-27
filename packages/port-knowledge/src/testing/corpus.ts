import type { FacetValue, FieldFilter, FilterValue, KnowledgeCapability } from '../port.js';
import type { ConversionPart, ConversionUnit } from '../parts.js';
import type { IndexDocument } from '../writer.js';

export const quotedNote = `O'Brien sa "ja"; DROP TABLE kn_docs; --`;
export const backtickNote = '`kode` OR 1=1 /* 100% _ \\ */';

const doc = (
  id: string,
  title: string,
  fields: Record<string, unknown>,
  texts: string[],
  phrases: [number, string][],
): IndexDocument => ({
  id,
  title,
  url: `https://example.no/${id}`,
  fields,
  chunks: texts.map((text, position) => ({
    id: `${id}-${position}`,
    position,
    text,
    metadata: { seksjon: `del ${position + 1}` },
  })),
  phrases: phrases.map(([position, text], n) => ({
    id: `${id}-p${n}`,
    chunkId: `${id}-${position}`,
    text,
  })),
});

export const fixtureFilters: Record<string, FieldFilter> = {
  kategori: 'select',
  virksomheter: 'multiselect',
  sammendrag: 'text',
  aar: 'range',
  arkivert: 'boolean',
  merknad: 'select',
};

export const fixtureDocuments: IndexDocument[] = [
  doc(
    'dok-1',
    'Tilskudd til digitalisering i kommunene',
    {
      kategori: 'Veiledning',
      virksomheter: ['Digdir', 'KS'],
      sammendrag: 'Veiledning om søknad og rapportering',
      aar: 2023,
      arkivert: false,
      merknad: quotedNote,
    },
    [
      'Kommunene kan søke tilskudd til digitalisering av tjenester.',
      'Søknaden om tilskudd sendes inn innen fristen 1. mars.',
      'Tilskudd kan brukes til skyplattform og felles løsninger.',
      'Mottakere av tilskudd rapporterer på bruken hvert år.',
    ],
    [
      [0, 'Hvem kan søke tilskudd til digitalisering?'],
      [1, 'Når er fristen for tilskudd?'],
      [2, 'Kan tilskudd brukes til skyplattform?'],
    ],
  ),
  doc(
    'dok-2',
    'Årsrapport for tilskudd 2021',
    {
      kategori: 'Rapport',
      virksomheter: ['NAV'],
      sammendrag: 'Rapport om resultater og regnskap',
      aar: 2021,
      arkivert: true,
      merknad: 'vanlig',
    },
    [
      'Årsrapporten viser hvordan tilskudd ble fordelt i 2021.',
      'Regnskapet for tilskudd er revidert av Riksrevisjonen.',
    ],
    [[0, 'Hvordan ble tilskudd fordelt i 2021?']],
  ),
  doc(
    'dok-3',
    'Rundskriv om tilskudd til opplæring',
    {
      kategori: 'Rundskriv',
      virksomheter: ['Digdir', 'NAV'],
      sammendrag: 'Regler for opplæring og kompetanse',
      aar: 2024,
      arkivert: false,
      merknad: backtickNote,
    },
    [
      'Rundskrivet gjelder tilskudd til opplæring i offentlig sektor.',
      'Tilskudd til kompetanse krever egenandel.',
      'Spørsmål om tilskudd rettes til saksbehandler.',
    ],
    [[1, 'Krever tilskudd til kompetanse egenandel?']],
  ),
  doc(
    'dok-4',
    'Veileder for tilskudd og universell utforming',
    {
      kategori: 'Veiledning',
      virksomheter: ['Digdir'],
      sammendrag: 'Universell utforming av nettsider',
      aar: 2019,
      arkivert: false,
      merknad: '50% rabatt_på (alt) [x]',
    },
    [
      'Tilskudd forutsetter at nettsider følger kravene til universell utforming.',
      'Digdir fører tilsyn med tilskudd og universell utforming.',
    ],
    [[0, 'Hvilke krav gjelder for tilskudd og universell utforming?']],
  ),
  doc(
    'dok-5',
    'Rapport om tilskudd til forskning',
    {
      kategori: 'Rapport',
      virksomheter: ['Forskningsrådet', 'KS'],
      sammendrag: 'Evaluering av forskning og innovasjon',
      aar: 2025,
      arkivert: true,
      merknad: 'vanlig',
    },
    [
      'Rapporten evaluerer tilskudd til forskning og innovasjon.',
      'Tilskudd til forskning ga flere samarbeidsprosjekter.',
    ],
    [[1, 'Hva ga tilskudd til forskning?']],
  ),
];

export interface FilterCase {
  name: string;
  capability: KnowledgeCapability;
  filters: Record<string, FilterValue>;
  documents: string[];
}

export const filterCases: FilterCase[] = [
  {
    name: 'select',
    capability: 'filter.select',
    filters: { kategori: 'Rapport' },
    documents: ['dok-2', 'dok-5'],
  },
  {
    name: 'multiselect',
    capability: 'filter.multiselect',
    filters: { virksomheter: ['KS'] },
    documents: ['dok-1', 'dok-5'],
  },
  {
    name: 'not',
    capability: 'filter.multiselect',
    filters: { virksomheter: { not: ['NAV'] } },
    documents: ['dok-1', 'dok-4', 'dok-5'],
  },
  {
    name: 'all',
    capability: 'filter.multiselect',
    filters: { virksomheter: { all: [['Digdir'], { not: ['NAV'] }] } },
    documents: ['dok-1', 'dok-4'],
  },
  {
    name: 'text',
    capability: 'filter.text',
    filters: { sammendrag: { contains: ['forskning'] } },
    documents: ['dok-5'],
  },
  {
    name: 'range',
    capability: 'filter.range',
    filters: { aar: { gte: 2021, lte: 2023 } },
    documents: ['dok-1', 'dok-2'],
  },
  {
    name: 'boolean',
    capability: 'filter.boolean',
    filters: { arkivert: true },
    documents: ['dok-2', 'dok-5'],
  },
];

export const trickyCases = [
  { value: quotedNote, documents: ['dok-1'], mayRefuse: false },
  { value: backtickNote, documents: ['dok-3'], mayRefuse: true },
];

export const facetCase: {
  fields: string[];
  filters: Record<string, FilterValue>;
  expected: Record<string, FacetValue[]>;
} = {
  fields: ['kategori', 'virksomheter'],
  filters: { arkivert: false },
  expected: {
    kategori: [
      { value: 'Rundskriv', count: 1 },
      { value: 'Veiledning', count: 2 },
    ],
    virksomheter: [
      { value: 'Digdir', count: 3 },
      { value: 'KS', count: 1 },
      { value: 'NAV', count: 1 },
    ],
  },
};

export const fixtureQueries = {
  everywhere: 'tilskudd',
  unique: { query: 'skyplattform', chunk: 'dok-1-2' },
};

export const rangeCase = { document: 'dok-1', from: 1, to: 2, chunks: ['dok-1-1', 'dok-1-2'] };

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Deterministic bag-of-words vector, so texts sharing words point the same way. */
export const fixtureVector = (text: string, dimensions: number): number[] => {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokens(text)) {
    let hash = 2166136261;
    for (const c of token) hash = Math.imul(hash ^ (c.codePointAt(0) ?? 0), 16777619);
    const slot = (hash >>> 0) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
};

export const withVectors = (documents: IndexDocument[], dimensions: number): IndexDocument[] =>
  documents.map((d) => ({
    ...d,
    chunks: d.chunks.map((c) => ({ ...c, vector: fixtureVector(c.text, dimensions) })),
    phrases: d.phrases.map((p) => ({ ...p, vector: fixtureVector(p.text, dimensions) })),
  }));

type FixturePart = [
  kind: ConversionPart['kind'],
  text: string,
  units?: number[],
  layer?: 'furniture',
];

/** One file's units, each a list of the parts that start in it, numbered in reading order. */
const fixtureUnits = (pages: FixturePart[][]): ConversionUnit[] => {
  let seq = 0;
  let offset = 0;
  let heading: string[] = [];
  return pages.map((parts, i) => {
    const unit = i + 1;
    const built = parts.map(([kind, text, covers = [unit], given]): ConversionPart => {
      const layer: ConversionPart['layer'] = given ?? 'body';
      const body = layer === 'body';
      if (body && (kind === 'section_header' || kind === 'title')) heading = [text];
      const start = body ? offset : null;
      if (body) offset += [...text].length + 2;
      return {
        seq: seq++,
        kind,
        layer,
        level: kind === 'section_header' ? 1 : null,
        headingPath: body && kind !== 'section_header' && kind !== 'title' ? heading : [],
        text,
        start,
        end: start === null ? null : start + [...text].length,
        regions: covers.map((u) => ({
          unit: u,
          start,
          end: start === null ? null : start + [...text].length,
        })),
        native: `#/texts/${seq}`,
      };
    });
    const first = built[0]?.seq ?? seq;
    return {
      unit,
      kind: 'page',
      label: String(unit + 2),
      width: 595,
      height: 842,
      textStart: built.find((p) => p.start !== null)?.start ?? null,
      textEnd: built.findLast((p) => p.end !== null)?.end ?? null,
      unitTo: Math.max(unit, ...built.flatMap((p) => p.regions.map((r) => r.unit))),
      seqFrom: first,
      seqTo: first + built.length - 1,
      parts: built,
    };
  });
};

/**
 * A report and its attachment, as parts (ADR 0055): page furniture, a table that starts on page 2
 * and runs to page 4, and sections. Page labels run two ahead of the units, as in a printed report.
 */
export const partsFiles: [ConversionUnit[], ConversionUnit[]] = [
  fixtureUnits([
    [
      ['page_header', 'Årsrapport for havna', [1], 'furniture'],
      ['title', 'Årsrapport for havna'],
      ['text', 'Innledning om året som gikk.'],
    ],
    [
      ['section_header', 'Bakgrunn'],
      ['text', 'Havna fikk ny kai.'],
      ['table', '| kai | meter |\n| --- | --- |\n| nord | 120 |', [2, 3, 4]],
    ],
    [['page_footer', '5', [3], 'furniture']],
    [['text', 'Etter tabellen kommer merknadene.']],
    [
      ['section_header', 'Funn'],
      ['text', 'Første funn om fartøy.'],
      ['text', 'Andre funn om lasting.'],
    ],
    [
      ['page_header', 'Årsrapport for havna', [6], 'furniture'],
      ['text', 'Tredje funn om fortøyning.'],
      ['section_header', 'Slutt'],
      ['text', 'Havna ser lyst på neste år.'],
    ],
  ]),
  fixtureUnits([[['text', 'Vedlegget lister kaiene.']]]),
];

/**
 * A document whose chunks are made from the two files' parts, one chunk a page, as `parts-unit`
 * cuts them, and a document whose one chunk is made from pages. `conversions` are the numbers
 * the files were stored under.
 */
export const partsDocuments = (conversions: [string, string]): IndexDocument[] => {
  const chunk = (file: 0 | 1, unit: number, position: number) => {
    const parts = (partsFiles[file][unit - 1]?.parts ?? []).filter((p) => p.layer === 'body');
    const first = parts[0];
    const last = parts.at(-1);
    return {
      id: `havn-${file === 0 ? 'rapport' : 'vedlegg'}-${unit}`,
      position,
      text: parts.map((p) => p.text).join('\n\n'),
      file: file === 0 ? 'rapport.pdf' : 'vedlegg.pdf',
      pageFrom: unit,
      pageTo: unit,
      conversion: conversions[file],
      seqFrom: first?.seq ?? 0,
      seqTo: last?.seq ?? 0,
      textStart: first?.start ?? 0,
      textEnd: last?.end ?? 0,
    };
  };
  return [
    {
      id: 'havn',
      title: 'Årsrapport for havna',
      fields: {},
      chunks: [
        chunk(0, 1, 0),
        chunk(0, 2, 1),
        chunk(0, 4, 2),
        chunk(0, 5, 3),
        chunk(0, 6, 4),
        chunk(1, 1, 5),
      ],
      phrases: [],
    },
    {
      id: 'sider',
      title: 'Rapport lest side for side',
      fields: {},
      chunks: [
        { id: 'sider-1', position: 0, text: 'En side lest uten deler.', pageFrom: 1, pageTo: 1 },
      ],
      phrases: [],
    },
  ];
};

/** The reads the contract checks on `partsDocuments`, with the `seq` each returns. */
export const partsCases = {
  /** Page 4 holds a table that starts on page 2. */
  startsBefore: { chunk: 'havn-rapport-4', read: 'units', n: 0, seqs: [5, 7] },
  /** Two body parts on each side; the page footer and header between are not counted. */
  neighbours: { chunk: 'havn-rapport-5', read: 'neighbours', n: 2, seqs: [5, 7, 8, 9, 10, 12, 13] },
  /** The hit on page 4 is in the section «Bakgrunn», which starts on page 2. */
  section: { chunk: 'havn-rapport-4', read: 'section', n: 0, seqs: [3, 4, 5, 7] },
  /** The pages around page 5, and the labels of the pages they cover. */
  units: {
    chunk: 'havn-rapport-5',
    read: 'units',
    n: 1,
    seqs: [5, 7, 8, 9, 10, 12, 13, 14],
    labels: ['4', '5', '6', '7', '8'],
  },
  /** The report's last page and its attachment's only page are each the edge of a file. */
  lastPage: {
    chunk: 'havn-rapport-6',
    read: 'neighbours',
    n: 5,
    seqs: [5, 7, 8, 9, 10, 12, 13, 14],
  },
  attachment: { chunk: 'havn-vedlegg-1', read: 'neighbours', n: 5, seqs: [0] },
  /** Every page of the report: no page header or footer comes back. */
  whole: { chunk: 'havn-rapport-1', read: 'units', n: 5, furniture: [0, 6, 11] },
  pages: { chunk: 'sider-1' },
} as const;
