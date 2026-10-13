import type { FacetValue, FieldFilter, FilterValue, KnowledgeCapability } from '../port.js';
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
