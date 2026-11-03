import MiniSearch from 'minisearch';
import { blocks, cases, models } from '../data/blocks';
import { componentsByBlock } from '../data/components';
import { serviceTypes } from '../data/serviceTypes';
import { href, type Route } from '../router';

/**
 * Søkeindeks bygd fra datafilene ved oppstart, så den aldri kommer i utakt med innholdet.
 * Alt kjører i nettleseren; ingen tjener.
 */

export type DocType = 'byggekloss' | 'del' | 'flyt' | 'steg' | 'type' | 'modell';

export type SearchDoc = {
  id: string;
  type: DocType;
  title: string;
  /** Hvor dokumentet hører hjemme, f.eks. den overordnede byggeklossen en byggekloss ligger under. */
  context?: string;
  excerpt: string;
  body: string;
  synonyms: string;
  to: string;
};

export const typeLabel: Record<DocType, string> = {
  byggekloss: 'Overordnet byggekloss',
  del: 'Byggekloss',
  flyt: 'Flyt',
  steg: 'Steg i flyt',
  type: 'Type KI-tjeneste',
  modell: 'Modell',
};

/** Ord folk søker på som ikke står i teksten etter navnebyttene. */
const synonymsById: Record<string, string> = {
  'ki-gateway': 'gateway KI-gateway AI gateway modellruting ruter',
  rag: 'RAG retrieval augmented generation data søk vektorsøk',
  evals: 'evals evaluering observability tracing',
  verktoy: 'tools tool calling function calling',
  definisjoner: 'tjenestedefinisjon definisjon YAML portal portalen',
  'agent-runtime': 'runtime kjerne agent harness',
  kanaler: 'kanaler API frontend arbeidsflate portal',
  autentisering: 'innlogging pålogging identitet login',
  tilgangsstyring: 'autorisasjon rettigheter tilgang',
  sprakmodeller: 'LLM språkmodell modeller Claude GPT Gemini Llama',
  'ki-infrastruktur': 'GPU datasenter regnekraft compute',
  plattform: 'DIS drift hosting',
};

const j = (parts: (string | string[] | undefined)[]) =>
  parts
    .flat()
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ');

const go = (r: Route) => href(r);

function buildDocs(): SearchDoc[] {
  const docs: SearchDoc[] = [];

  for (const b of blocks) {
    docs.push({
      id: `b:${b.id}`,
      type: 'byggekloss',
      title: b.name,
      excerpt: b.tagline,
      body: j([
        b.tagline,
        b.description,
        b.capabilities,
        b.packages,
        b.adrs.map((a) => a.title),
        b.reuse,
      ]),
      synonyms: synonymsById[b.id] ?? '',
      to: go({ page: 'byggeklosser', id: b.id }),
    });
    for (const c of componentsByBlock[b.id] ?? []) {
      docs.push({
        id: `c:${b.id}/${c.id}`,
        type: 'del',
        title: c.name,
        context: b.name,
        excerpt: c.tagline,
        body: j([c.tagline, c.description, c.capabilities, c.options, c.practices]),
        synonyms: synonymsById[b.id] ?? '',
        to: go({ page: 'byggeklosser', id: b.id, sub: c.id }),
      });
    }
  }

  for (const c of cases) {
    docs.push({
      id: `f:${c.id}`,
      type: 'flyt',
      title: c.name,
      excerpt: c.intro,
      body: j([c.intro]),
      synonyms: '',
      to: go({ page: 'tjenester', id: c.id }),
    });
    const parts: ['bruk' | 'oppsett', typeof c.steps][] = [
      ['bruk', c.steps],
      ['oppsett', c.setup],
    ];
    for (const [part, steps] of parts) {
      steps.forEach((s, i) => {
        docs.push({
          id: `s:${c.id}/${part}/${s.id}`,
          type: 'steg',
          title: s.title,
          context: `${c.name}, ${part === 'bruk' ? 'bruk' : 'oppsett'} steg ${i + 1}`,
          excerpt: s.text,
          body: j([s.title, s.text]),
          synonyms: '',
          to: `${go({ page: 'tjenester', id: c.id })}?del=${part}&steg=${i + 1}`,
        });
      });
    }
  }

  for (const t of serviceTypes) {
    docs.push({
      id: `t:${t.id}`,
      type: 'type',
      title: t.name,
      excerpt: t.tagline,
      body: j([
        t.tagline,
        t.intro,
        t.description,
        t.fits,
        t.avoid,
        t.examples,
        t.build.map((x) => `${x.label} ${x.text}`),
      ]),
      synonyms: '',
      to: go({ page: 'typer', id: t.id }),
    });
  }

  for (const m of models) {
    docs.push({
      id: `m:${m.name}`,
      type: 'modell',
      title: m.name,
      context: m.provider,
      excerpt: `${m.provider}, residens ${m.residency}`,
      body: j([m.provider, m.residency]),
      synonyms: '',
      to: go({ page: 'byggeklosser', id: 'sprakmodeller' }),
    });
  }

  return docs;
}

export const docs = buildDocs();
const byId = new Map(docs.map((d) => [d.id, d]));

const index = new MiniSearch<SearchDoc>({
  fields: ['title', 'context', 'body', 'synonyms'],
  storeFields: ['id'],
  searchOptions: {
    boost: { title: 4, synonyms: 3, context: 1.5 },
    prefix: true,
    fuzzy: (term) => (term.length > 4 ? 0.2 : false),
    combineWith: 'AND',
  },
  // Norsk: behold æøå, del på alt annet som ikke er bokstav eller tall.
  tokenize: (text) =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}-]+/u)
      .filter(Boolean),
});
index.addAll(docs);

export type Hit = SearchDoc & { score: number };

export function search(q: string, limit = 20): Hit[] {
  const query = q.trim();
  if (query.length < 2) return [];
  return index
    .search(query)
    .slice(0, limit)
    .map((r) => ({ ...(byId.get(r.id) as SearchDoc), score: r.score }));
}

/** Forslag når feltet er tomt: de overordnede byggeklossene og typene, som hurtignavigasjon. */
export const suggestions: SearchDoc[] = docs.filter(
  (d) => d.type === 'type' || d.type === 'byggekloss',
);
