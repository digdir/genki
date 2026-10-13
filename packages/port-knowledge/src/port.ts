import type { IndexDocument } from './writer.js';
export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const filterKinds = ['select', 'multiselect', 'text', 'range', 'boolean'] as const;
export type FilterKind = (typeof filterKinds)[number];
export type FieldFilter = FilterKind | FilterKind[];

export const filterValueTypes = ['string', 'integer'] as const;
export type FilterValueType = (typeof filterValueTypes)[number];

export const kindsOf = (field: FieldFilter): FilterKind[] =>
  Array.isArray(field) ? field : [field];

export type KnowledgeCapability =
  | 'search.text'
  | 'search.vector'
  | 'search.hybrid'
  | 'fetch'
  | 'range'
  | 'facets'
  | `filter.${FilterKind}`;

export const searchCapabilities = ['search.text', 'search.vector', 'search.hybrid'] as const;

export const knowledgeCapabilities: readonly KnowledgeCapability[] = [
  ...searchCapabilities,
  'fetch',
  'range',
  'facets',
  ...filterKinds.map((k) => `filter.${k}` as const),
];

export const legacyCapabilities: readonly KnowledgeCapability[] = knowledgeCapabilities.filter(
  (c) => c !== 'search.vector' && c !== 'search.hybrid',
);

export const knowledgeProfiles = {
  content: 'content',
  metadata: 'metadata',
  phrase: 'phrase',
  docTitle: 'doc-title',
} as const;
export type KnowledgeProfile = (typeof knowledgeProfiles)[keyof typeof knowledgeProfiles];

export type FilterClause =
  | string
  | number
  | boolean
  | (string | number)[]
  | { not: (string | number)[] }
  | { contains: string[] }
  | { gte?: number | string; lte?: number | string };

export type FilterValue = FilterClause | { all: FilterClause[] };

export const matchAllQuery = '*';

export interface SearchRequest {
  query: string;
  profile?: string;
  filters?: Record<string, FilterValue>;
  limit?: number;
}

export interface Hit {
  id: string;
  score: number;
  text: string;
  title?: string;
  url?: string;
  document?: string;
  position?: number;
  fields: Record<string, unknown>;
}

export interface SearchResult {
  hits: Hit[];
  found?: number;
  warning?: string;
}

export interface DocumentsRequest {
  ids?: string[];
  filters?: Record<string, FilterValue>;
  limit?: number;
  offset?: number;
}

export interface DocumentSummary {
  id: string;
  title?: string;
  url?: string;
  fields: Record<string, unknown>;
}

export interface DocumentPage {
  documents: DocumentSummary[];
  found?: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface DatasetInfo {
  id: string;
  residency: Residency;
  filters: Record<string, FieldFilter>;
  profiles: string[];
  engine?: string;
  capabilities?: KnowledgeCapability[];
}

/** A port that declares no capabilities keeps everything it offered before capabilities existed. */
export const capabilitiesOf = (info: DatasetInfo): readonly KnowledgeCapability[] =>
  info.capabilities ?? legacyCapabilities;

export interface KnowledgePort {
  info(): DatasetInfo;
  search(request: SearchRequest): Promise<SearchResult>;
  searchMany(requests: SearchRequest[]): Promise<SearchResult[]>;
  fetch(ids: string[]): Promise<Hit[]>;
  range(document: string, from: number, to: number): Promise<Hit[]>;
  facets(
    fields: string[],
    filters?: Record<string, FilterValue>,
  ): Promise<Record<string, FacetValue[]>>;
  documents?(request: DocumentsRequest): Promise<DocumentPage>;
  export?: DatasetExport;
}

export interface DatasetExport {
  vectors: boolean;
  documents(): AsyncIterable<IndexDocument>;
  count(cap: number): Promise<number>;
}

export type KnowledgeErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'unauthorized'
  | 'cancelled'
  | 'residency'
  | 'forbidden'
  | 'unsupported';

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}
