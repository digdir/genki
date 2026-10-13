import { secretRefPattern, type Credential } from '@genai/kernel';
import { z } from 'zod';
import type {
  DocumentPage,
  DocumentsRequest,
  FacetValue,
  FieldFilter,
  FilterValue,
  Hit,
  KnowledgeCapability,
  Residency,
  SearchRequest,
  SearchResult,
} from './port.js';
import type { IndexDocument } from './writer.js';

export interface KnowledgeEndpointConfig<O = unknown> {
  baseURL: string;
  credential: Credential;
  options: O;
  timeoutMs: number;
}

export interface LocalEndpointConfig<O = unknown> {
  baseURL?: string;
  credential?: Credential;
  options: O;
  timeoutMs: number;
}

export interface DatasetEmbedding {
  model: string;
  dimensions: number;
}

export interface DatasetConfig<O = unknown> {
  id: string;
  filters: Record<string, FieldFilter>;
  options: O;
  embedding?: DatasetEmbedding;
}

export interface DatasetDraft {
  filters: Record<string, FieldFilter>;
  options: Record<string, unknown>;
  embedding?: DatasetEmbedding;
}

export interface KnowledgeConnection<D = unknown> {
  profiles(dataset: DatasetConfig<D>): string[];
  search(
    dataset: DatasetConfig<D>,
    requests: SearchRequest[],
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
  fetch(dataset: DatasetConfig<D>, ids: string[], signal: AbortSignal): Promise<Hit[]>;
  range(
    dataset: DatasetConfig<D>,
    document: string,
    from: number,
    to: number,
    signal: AbortSignal,
  ): Promise<Hit[]>;
  facets(
    dataset: DatasetConfig<D>,
    fields: string[],
    filters: Record<string, FilterValue>,
    signal: AbortSignal,
  ): Promise<Record<string, FacetValue[]>>;
  documents?(
    dataset: DatasetConfig<D>,
    request: DocumentsRequest,
    signal: AbortSignal,
  ): Promise<DocumentPage>;
  export?: KnowledgeExport<D>;
  served?(dataset: DatasetConfig<D>, signal: AbortSignal): Promise<ServedIndex>;
}

export interface ServedIndex {
  generation?: string;
  collections?: string[];
}

export interface KnowledgeExport<D = unknown> {
  vectors: boolean;
  documents(dataset: DatasetConfig<D>, signal: AbortSignal): AsyncIterable<IndexDocument>;
  count(dataset: DatasetConfig<D>, cap: number, signal: AbortSignal): Promise<number>;
}

export interface KnowledgeAdapter<E = unknown, D = unknown> {
  engine: string;
  title?: string;
  tech?: string;
  dataLocation?: Residency;
  endpointOptions: z.ZodType<E>;
  datasetOptions: z.ZodType<D>;
  /** False when endpoints need no baseURL or auth; such adapters are built with localKnowledgeAdapter. */
  requiresBaseURL?: boolean;
  capabilities?(dataset: DatasetConfig<D>): KnowledgeCapability[];
  /** Dataset options to add when a draft leaves them out, such as default profiles. */
  defaults?(dataset: DatasetDraft): Record<string, unknown>;
  connect(endpoint: KnowledgeEndpointConfig<E>): KnowledgeConnection<D>;
  /** A cheap read-only connection test that throws a KnowledgeError when the endpoint is unusable. */
  probe?(endpoint: KnowledgeEndpointConfig<E>, signal: AbortSignal): Promise<void>;
}

export const localKnowledgeAdapter = <E, D>(
  adapter: Omit<KnowledgeAdapter<E, D>, 'connect' | 'probe' | 'requiresBaseURL'> & {
    connect(endpoint: LocalEndpointConfig<E>): KnowledgeConnection<D>;
    probe?(endpoint: LocalEndpointConfig<E>, signal: AbortSignal): Promise<void>;
  },
): KnowledgeAdapter<E, D> => ({ ...adapter, requiresBaseURL: false });

export const secretRef = () =>
  z.string().regex(secretRefPattern, 'must be a secret:// reference').meta({ 'x-secret': true });
