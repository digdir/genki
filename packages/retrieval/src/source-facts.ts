import {
  capabilitiesOf,
  kindsOf,
  type FacetValue,
  type FilterValue,
  type KnowledgePort,
} from '@genai/port-knowledge';
import { listDocuments, type ListedDocument } from './factories.js';
import type { FilterInput } from './filters.js';

export interface FactSource {
  id: string;
  name?: string;
  knowledge: KnowledgePort;
  valueTypes?: Record<string, 'string' | 'integer'>;
  lastImport?: () => Promise<string | undefined>;
}

export interface SourceFactsRequest {
  newest?: number;
  fields?: string[];
  maxValues?: number;
}

export interface NewestDocument {
  id: string;
  title?: string;
  url?: string;
  date?: string;
  year?: string;
}

export type NewestOrder = 'date-within-latest-years' | 'date' | 'listing-order';

export interface SourceFact {
  id: string;
  name?: string;
  inScope: boolean;
  documents?: number;
  lastImport?: string;
  newest: NewestDocument[];
  newestOrder?: NewestOrder;
  yearField?: string;
  filterValues: Record<string, FacetValue[]>;
}

const scanLimit = 200;
const yearsScanned = 3;
const idLike = /(^|_)(id|ids|num|sha256|hash)$/i;
const yearLike = /year|(^|_)år$/i;

const clauses = (value: FilterInput): FilterInput[] =>
  typeof value === 'object' && !Array.isArray(value) && 'all' in value ? value.all : [value];

const narrowed = (
  scope: Record<string, FilterInput> | undefined,
  field: string,
  clause: FilterInput,
): Record<string, FilterInput> => {
  const existing = scope?.[field];
  return {
    ...scope,
    [field]:
      existing === undefined ? clause : ({ all: [...clauses(existing), clause] } as FilterValue),
  };
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const facetable = (knowledge: KnowledgePort) => capabilitiesOf(knowledge.info()).includes('facets');

const listable = (knowledge: KnowledgePort) =>
  Object.entries(knowledge.info().filters)
    .filter(
      ([field, declared]) =>
        !idLike.test(field) && kindsOf(declared).some((k) => k === 'select' || k === 'multiselect'),
    )
    .map(([field]) => field);

const yearFieldOf = (knowledge: KnowledgePort) => listable(knowledge).find((f) => yearLike.test(f));

const yearsDescending = (values: FacetValue[]) =>
  values.filter((v) => /^\d{4}$/.test(v.value)).sort((a, b) => Number(b.value) - Number(a.value));

const byDateDescending = (a: ListedDocument, b: ListedDocument) =>
  (b.publishedAt ? Date.parse(b.publishedAt) : -Infinity) -
  (a.publishedAt ? Date.parse(a.publishedAt) : -Infinity);

const newestDocument = (d: ListedDocument, year?: string): NewestDocument => ({
  id: d.id,
  ...optional('title', d.title),
  ...optional('url', d.url),
  ...optional('date', d.publishedAt),
  ...optional('year', year),
});

const newestOf = async (
  source: FactSource,
  scope: Record<string, FilterInput> | undefined,
  years: FacetValue[] | undefined,
  yearField: string | undefined,
  wanted: number,
  signal: AbortSignal,
): Promise<{ documents: NewestDocument[]; order: NewestOrder }> => {
  const { knowledge } = source;
  const latest = yearsDescending(years ?? []).slice(0, yearsScanned);
  if (yearField && latest.length > 0) {
    const found: NewestDocument[] = [];
    const seen = new Set<string>();
    for (const { value } of latest) {
      if (found.length >= wanted) break;
      const listed = await listDocuments(
        knowledge,
        { limit: scanLimit },
        narrowed(
          scope,
          yearField,
          source.valueTypes?.[yearField] === 'integer' ? [Number(value)] : [value],
        ),
        signal,
      );
      for (const d of [...listed].sort(byDateDescending)) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        found.push(newestDocument(d, value));
      }
    }
    return { documents: found.slice(0, wanted), order: 'date-within-latest-years' };
  }
  const listed = await listDocuments(knowledge, { limit: scanLimit }, scope, signal);
  const dated = listed.some((d) => d.publishedAt !== undefined);
  return {
    documents: (dated ? [...listed].sort(byDateDescending) : listed)
      .slice(0, wanted)
      .map((d) => newestDocument(d)),
    order: dated ? 'date' : 'listing-order',
  };
};

const outsideScope = (knowledge: KnowledgePort, scope: Record<string, FilterInput> | undefined) =>
  Object.keys(scope ?? {}).some((field) => !(field in knowledge.info().filters));

const factsOf = async (
  source: FactSource,
  scope: Record<string, FilterInput> | undefined,
  request: Required<SourceFactsRequest>,
  signal: AbortSignal,
): Promise<SourceFact> => {
  const { knowledge } = source;
  const base = { id: source.id, ...optional('name', source.name) };
  if (outsideScope(knowledge, scope))
    return { ...base, inScope: false, newest: [], filterValues: {}, documents: 0 };
  signal.throwIfAborted();
  const lastImport = await source.lastImport?.();
  const declared = listable(knowledge);
  const yearField = yearFieldOf(knowledge);
  const asked = request.fields.length > 0 ? request.fields : declared;
  const fields = [
    ...new Set([
      ...asked.filter((f) => f in knowledge.info().filters),
      ...(yearField ? [yearField] : []),
    ]),
  ];
  const values =
    facetable(knowledge) && fields.length > 0 ? await knowledge.facets(fields, scope) : {};
  const counted = knowledge.documents
    ? (await knowledge.documents({ ...optional('filters', scope), limit: 1 })).found
    : undefined;
  const newest =
    request.newest > 0
      ? await newestOf(
          source,
          scope,
          yearField ? values[yearField] : undefined,
          yearField,
          request.newest,
          signal,
        )
      : undefined;
  const filterValues = Object.fromEntries(
    asked
      .filter((f) => values[f] !== undefined)
      .map((f) => {
        const list = values[f] ?? [];
        const sorted = f === yearField ? yearsDescending(list) : list;
        return [f, sorted.slice(0, request.maxValues)];
      }),
  );
  return {
    ...base,
    inScope: true,
    ...optional('documents', counted),
    ...optional('lastImport', lastImport),
    newest: newest?.documents ?? [],
    ...optional('newestOrder', newest?.order),
    ...optional('yearField', yearField),
    filterValues,
  };
};

export const sourceFacts = async (
  sources: readonly FactSource[],
  scope: Record<string, FilterInput> | undefined,
  request: SourceFactsRequest,
  signal: AbortSignal,
): Promise<SourceFact[]> => {
  const settled = {
    newest: Math.min(Math.max(request.newest ?? 10, 0), 25),
    fields: request.fields ?? [],
    maxValues: Math.min(Math.max(request.maxValues ?? 20, 1), 50),
  };
  return Promise.all(sources.map((source) => factsOf(source, scope, settled, signal)));
};
