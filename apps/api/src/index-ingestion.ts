import type { Principal, Ref, Usage } from '@genai/contracts';
import {
  blobPhraseCache,
  chunkingOf,
  defaultSearchPhrasesPrompt,
  estimateKudos,
  memoryPhraseCache,
  runIndexIngest,
  sourceOf,
  sourceProblem,
  type IngestSource,
  type IngestSourceOptions,
  type ParquetReader,
  type PhraseCache,
  type PhraseStorage,
  type PipelineSpec,
} from '@genai/ingest';
import { parquetSourceOf } from './parquet-files.js';
export { parquetLocation, parquetReadTimeoutMs } from './parquet-files.js';
export {
  chunkingOf,
  estimateKudos,
  kudosClientFor,
  kudosFileReadTimeoutMs,
  kudosProfileFor,
  maxDocumentBytes,
  resolvedConnection,
  tenantSecretPrefix,
  uploadPrefix,
  type DatabaseAccess,
  type KudosAccess,
  type PhraseStorage,
} from '@genai/ingest';
import { withModelAdmission } from '@genai/composition';
import type { PortContext } from '@genai/kernel';
import type { EmbeddingOpenOptions, EmbeddingPort } from '@genai/port-embedding';
import type { IndexWriterRouter } from '@genai/port-knowledge';
import type { ModelPort, Residency } from '@genai/port-model';
import type {
  IngestionBackend,
  IngestionJob,
  IngestionReport,
  IngestionTarget,
  Pipeline,
} from './ingestion.js';
import type { CatalogRegistry } from './catalog-registry.js';
import { tenantModelRefusal } from './model-access.js';

export interface EmbedderSource {
  has(model: string): boolean;
  open(ref: Ref, ctx: PortContext, options?: EmbeddingOpenOptions): EmbeddingPort;
  /** The embedding models the platform serves, for a choice of model. */
  models?(): { model: string; dimensions: number; residency?: Residency }[];
}

export interface ParquetAccess {
  reader: ParquetReader;
  workingDirectory?: string;
  maxBytes?: number;
  fetch?: typeof fetch;
  readTimeoutMs?: number;
}

/** The API's source options: Parquet access as configuration, which `ingestSourceOptions` turns into the ingest hook. */
export type IngestSourceConfig = Omit<IngestSourceOptions, 'parquet'> & { parquet?: ParquetAccess };

export const ingestSourceOptions = (config: IngestSourceConfig): IngestSourceOptions => {
  const { parquet, ...rest } = config;
  return parquet
    ? { ...rest, parquet: { source: (spec, web) => parquetSourceOf(parquet, spec, web) } }
    : rest;
};

export interface IndexIngestionOptions extends IngestSourceConfig {
  writers: IndexWriterRouter;
  residencyOf(dataset: string): Residency | undefined;
  embedders?: EmbedderSource;
  models?: { open(ref: Ref, ctx: PortContext): ModelPort };
  catalog?: Pick<CatalogRegistry, 'get'>;
  platformTenant: string;
}

export const phraseCacheDirectory = (kind: PipelineSpec['source']['kind']) =>
  kind === 'kudos' ? 'search-phrases' : `${kind}-search-phrases`;

const phraseCacheFor = (
  storage: PhraseStorage | undefined,
  tenant: string,
  kind: PipelineSpec['source']['kind'],
): PhraseCache =>
  storage?.blobs
    ? blobPhraseCache(storage.blobs, tenant, phraseCacheDirectory(kind))
    : memoryPhraseCache();

const withoutMetadata = (source: IngestSource): IngestSource => ({
  ...source,
  documents: async function* () {
    for await (const document of source.documents())
      yield {
        ...document,
        storedChunks: (chunks) =>
          document
            .storedChunks(chunks)
            .map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'metadata'))),
      };
  },
});

const withIngestedAt = (source: IngestSource, at: string): IngestSource => ({
  ...source,
  documents: async function* () {
    for await (const document of source.documents())
      yield { ...document, stored: (chunks) => ({ ...document.stored(chunks), ingested_at: at }) };
  },
});

const addUsage = (total: Usage | undefined, usage: Usage): Usage => {
  const sum = (a?: number, b?: number) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const out: Usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'requests', 'costMicroNok'] as const) {
    const value = sum(total?.[key], usage[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const indexIngestionBackend = (options: IndexIngestionOptions): IngestionBackend => {
  const sources = ingestSourceOptions(options);
  const probe = (target: IngestionTarget) => {
    if (!options.writers.supports(target.dataset))
      return {
        reason: `dataset ${target.dataset} is on an engine without an index writer; create it on an engine with one, such as pgvector`,
      };
    try {
      return {
        route: options.writers.open(target.dataset, { signal: new AbortController().signal }),
      };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    name: 'index-writer',
    available: true,
    unavailableFor: (target: IngestionTarget, pipeline?: Pipeline) => {
      const probed = probe(target);
      if (!probed.route) return probed.reason;
      const embedding = probed.route.dataset.embedding;
      if (probed.route.needs.vectors && embedding && !options.embedders?.has(embedding.model))
        return `dataset ${target.dataset} embeds with ${embedding.model}, which is not configured`;
      if (pipeline?.spec.phrases && !options.models)
        return 'search phrases need a model, and no model router is configured';
      return pipeline ? sourceProblem(pipeline.spec, sources) : undefined;
    },
    estimate: async (pipeline: Pipeline) => {
      const source = pipeline.spec.source;
      if (source.kind !== 'kudos') return undefined;
      return estimateKudos(options.kudos ?? {}, source);
    },
    run: async (job: IngestionJob, signal: AbortSignal): Promise<IngestionReport> => {
      const tenant = job.tenant ?? options.platformTenant;
      const phraseModels = [
        job.pipeline.spec.phrases?.model,
        job.pipeline.spec.phrases?.fallbackModel,
      ];
      for (const model of phraseModels) {
        const refused =
          job.tenant && model && options.catalog
            ? tenantModelRefusal(options.catalog, model, job.tenant)
            : undefined;
        if (refused) throw new Error(refused);
      }
      const usage: Record<string, Usage> = {};
      const system: Principal = {
        kind: 'agency-system',
        issuer: 'platform',
        subject: 'ingestion',
        tenant,
      };
      const principal = job.admitted ? withModelAdmission(system) : system;
      const ctx: PortContext = {
        tenant,
        principal,
        task: `ingestion:${job.execution}`,
        signal,
        meter: async (used, ref) => {
          const key = ref ? `${ref.kind}:${ref.id}` : 'other';
          usage[key] = addUsage(usage[key], used);
        },
      };
      const route = options.writers.open(job.target.dataset, { signal });
      const embedding = route.needs.vectors ? route.dataset.embedding : undefined;
      const residency = options.residencyOf(job.target.dataset);
      const embedder =
        embedding && options.embedders
          ? options.embedders.open({ kind: 'embedder', id: embedding.model }, ctx, {
              ...(residency ? { maxResidency: residency } : {}),
            })
          : undefined;
      const spec = job.pipeline.spec;
      const modelRef = (id: string): Ref => ({
        kind: 'model',
        id,
        ...(job.tenant && job.tenant !== options.platformTenant ? { tenant: job.tenant } : {}),
      });
      const phrases =
        spec.phrases && options.models
          ? {
              model: options.models.open(modelRef(spec.phrases.model), ctx),
              generation: {
                prompt: defaultSearchPhrasesPrompt,
                identity: { provider: 'platform', model: spec.phrases.model },
                cache: phraseCacheFor(options.phrases, tenant, spec.source.kind),
                cacheEmpty: spec.source.kind === 'kudos',
                ...(spec.phrases.fallbackModel
                  ? { fallback: options.models.open(modelRef(spec.phrases.fallbackModel), ctx) }
                  : {}),
                ...(spec.source.kind === 'folder' && options.phrases?.archive
                  ? { declared: options.phrases.archive }
                  : {}),
              },
            }
          : undefined;
      const source = await sourceOf(spec, sources, { tenant, dataset: job.target.dataset }, signal);
      const result = await runIndexIngest({
        source: withIngestedAt(
          spec.chunking.metadataStyle === 'none' ? withoutMetadata(source) : source,
          new Date().toISOString(),
        ),
        chunking: chunkingOf(spec.chunking),
        ...(phrases ? { phrases } : {}),
        parallelism: spec.parallelism,
        maxDocumentFailures: spec.maxDocumentFailures,
        signal,
        target: {
          engine: route.engine,
          needs: { vectors: embedding !== undefined },
          dataset: route.dataset,
          writer: route.writer,
          generation: job.execution,
          ...(embedder ? { embedder } : {}),
        },
      });
      return {
        stored: result.stored,
        skipped: result.skipped,
        ...(result.skippedDocuments ? { skippedDocuments: result.skippedDocuments } : {}),
        failed: result.failed,
        generation: result.generation,
        promoted: result.promoted,
        ...(result.previous === undefined ? {} : { previous: result.previous }),
        ...(Object.keys(usage).length > 0 ? { usage } : {}),
        ...(source.summary ? { source: source.summary() } : {}),
      };
    },
  };
};
