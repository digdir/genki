import type { Principal, Usage } from '@genai/contracts';
import {
  databaseConnection,
  documentLanguages,
  huggingFaceSource,
  parquetTableName,
  parquetMapping,
  readableTextExtensions,
  rowMapping,
  type SkipReason,
  type SkippedDocument,
} from '@genai/ingest';
import { nextRun, parseCron } from '@genai/jobs';
import { z } from 'zod';
import {
  appendVersion,
  serialized,
  VersionConflict,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const glob = z.string().min(1).max(500);

const chunkStrategy = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('header-based'),
    splitMaxLength: z.number().int().positive().optional(),
    overlap: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    kind: z.literal('fixed-width'),
    width: z.number().int().positive(),
    overlap: z.number().int().min(0),
  }),
]);

export const pipelineSpec = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('website'),
      sitemap: z.url({ protocol: /^https$/ }),
      include: z.array(glob).default([]),
      exclude: z.array(glob).default([]),
      baseUrl: z.url().optional(),
      language: z
        .enum([...documentLanguages, 'detect'])
        .optional()
        .describe(
          'For documents whose URL and frontmatter give no language: nb, nn or en, or detect per document',
        ),
    }),
    z.strictObject({
      kind: z.literal('folder'),
      path: z.string().min(1),
      include: z.array(glob).default(['**/*.md']),
      exclude: z.array(glob).optional(),
      baseUrl: z.url().optional(),
      keepExtension: z.boolean().optional(),
      titleFrom: z
        .enum(['file-name', 'heading'])
        .optional()
        .describe('heading: the first # heading, or the top-level name: of a YAML file'),
      extensions: z
        .array(z.enum(readableTextExtensions))
        .min(1)
        .optional()
        .describe('File types read as text; default .md, .txt, .html, .htm'),
    }),
    z.strictObject({
      kind: z.literal('upload'),
    }),
    z.strictObject({
      kind: z.literal('kudos'),
      profile: z.enum(['prod', 'preprod']).default('prod'),
      startingPage: z.number().int().positive().default(1),
      types: z.array(z.string().min(1)).default([]),
      since: z.iso.date().optional(),
      orgs: z.array(z.string().min(1)).optional(),
    }),
    z.strictObject({
      kind: z.literal('episerver'),
      path: z.string().min(1),
      language: z.string().min(1).default('no'),
      pageTypes: z.array(z.string().min(1)).default([]),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().positive().optional(),
      baseUrl: z.url().optional(),
    }),
    z
      .strictObject({
        kind: z.literal('parquet'),
        url: z.url({ protocol: /^https$/ }).optional(),
        huggingface: huggingFaceSource.optional(),
        urls: z
          .array(z.url({ protocol: /^https$/ }))
          .min(1)
          .max(1000)
          .optional(),
        table: parquetTableName.optional(),
        mapping: parquetMapping,
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .max(20 * 1024 * 1024 * 1024)
          .default(1024 * 1024 * 1024)
          .describe(
            'Disk byte cap per shard, up to the platform ceiling; shards download sequentially',
          ),
      })
      .refine((s) => [s.url, s.urls, s.huggingface].filter((v) => v !== undefined).length === 1, {
        message: 'a Parquet source needs exactly one of url, urls and huggingface',
        path: ['url'],
      })
      .refine((s) => (s.urls ? s.table !== undefined : s.table === undefined), {
        message: 'table is required exactly when urls is set',
        path: ['table'],
      })
      .refine((s) => s.huggingface !== undefined || s.mapping.lookups.every((l) => !l.file), {
        message: 'a lookup file needs a huggingface source; use url otherwise',
        path: ['mapping', 'lookups'],
      }),
    z.strictObject({
      kind: z.literal('database'),
      connection: databaseConnection,
      mapping: rowMapping,
    }),
  ]),
  chunking: z
    .strictObject({
      strategy: chunkStrategy.default({ kind: 'header-based' }),
      minimumLength: z.number().int().min(0).default(200),
      maximumLength: z.number().int().positive().default(4000),
      metadataStyle: z.enum(['edn', 'json', 'none']).default('json'),
    })
    .prefault({}),
  phrases: z
    .strictObject({
      model: z.string().min(1),
      fallbackModel: z.string().min(1).optional(),
      perChunk: z.number().int().min(1).max(20).default(5),
    })
    .optional(),
  parallelism: z.number().int().min(1).max(16).default(2),
  maxDocumentFailures: z.number().int().positive().max(100_000).default(10),
  enabled: z.boolean().default(true),
  schedule: z.enum(['none', 'daily', 'weekly']).default('none'),
});

export type PipelineSpec = z.infer<typeof pipelineSpec>;

export const scheduleCron = { daily: '0 3 * * *', weekly: '0 3 * * 1' } as const;

export const unboundedKudos = (spec: { source?: unknown }) => {
  const source = (spec.source ?? {}) as { kind?: unknown; types?: unknown; since?: unknown };
  return (
    source.kind === 'kudos' &&
    !(Array.isArray(source.types) && source.types.length > 0) &&
    !source.since
  );
};

export const unboundedKudosMessage =
  'En innlesing fra Kudos må avgrenses med dokumenttyper eller en startdato, ellers leses hele arkivet inn.';

export interface Pipeline {
  dataset: string;
  id: string;
  version: number;
  spec: PipelineSpec;
  by: string;
  at: string;
  reason: string;
}

export type PipelineVersion = Pipeline & { deleted: boolean };

export interface IngestionTarget {
  dataset: string;
  endpoint: string;
  collections: Record<string, string>;
}

export interface IngestionJob {
  execution: string;
  pipeline: Pipeline;
  target: IngestionTarget;
  tenant?: string;
  admitted?: boolean;
}

export interface IngestionReport {
  stored: number;
  skipped: number;
  skippedDocuments?: SkippedDocument[];
  failed: string[];
  generation?: string;
  promoted?: boolean;
  previous?: string;
  usage?: Record<string, Usage>;
  /** Source-specific facts, such as how many rows a Parquet lookup matched. */
  source?: Record<string, unknown>;
}

export interface IngestionBackend {
  readonly name: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** The reason the backend cannot write this dataset, or undefined when it can. */
  unavailableFor?(target: IngestionTarget, pipeline?: Pipeline): string | undefined;
  run(job: IngestionJob, signal: AbortSignal): Promise<IngestionReport>;
  estimate?(pipeline: Pipeline): Promise<SourceEstimate | undefined>;
}

export interface SourceEstimate {
  documents: number;
  exact: boolean;
  basis: { listed: number; sampled: number; matching: number };
}

export interface BackendStatus {
  name: string;
  available: boolean;
  reason?: string;
}

export class IngestionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionUnavailable';
  }
}

export const pendingWriteKeyReason =
  'Real ingestion is pending a separate search write key and a decision by the platform owner. The shared search key is search-only.';

export const pendingIngestionBackend = (): IngestionBackend => ({
  name: 'pending',
  available: false,
  unavailableReason: pendingWriteKeyReason,
  run: async () => {
    throw new IngestionUnavailable(pendingWriteKeyReason);
  },
});

export interface FakeDocument {
  key: string;
  text: string;
  skip?: SkipReason;
}

export class InMemoryIngestionBackend implements IngestionBackend {
  readonly name = 'memory';
  readonly available = true;
  readonly indexes = new Map<string, Map<string, Record<string, unknown>>>();
  readonly jobs: IngestionJob[] = [];

  constructor(private readonly documents: (job: IngestionJob) => FakeDocument[] = () => []) {}

  async run(job: IngestionJob, signal: AbortSignal): Promise<IngestionReport> {
    this.jobs.push(structuredClone(job));
    const { chunking } = job.pipeline.spec;
    const chunks = job.target.collections.chunks ?? `${job.target.dataset}-chunks`;
    const index = this.indexes.get(chunks) ?? new Map<string, Record<string, unknown>>();
    this.indexes.set(chunks, index);
    const report: IngestionReport = { stored: 0, skipped: 0, failed: [] };
    for (const document of this.documents(job)) {
      if (signal.aborted) throw new Error('the ingestion was cancelled');
      const reason = document.skip ?? (document.text.trim() === '' ? 'no_text' : undefined);
      if (reason) {
        report.skipped += 1;
        report.skippedDocuments = [
          ...(report.skippedDocuments ?? []),
          { document: document.key, reason },
        ];
        continue;
      }
      if (document.text.length < chunking.minimumLength) {
        report.skipped += 1;
        continue;
      }
      const size = chunking.maximumLength;
      for (let at = 0, n = 0; at < document.text.length; at += size, n += 1)
        index.set(`${document.key}#${n}`, {
          chunk_id: `${document.key}#${n}`,
          doc_num: document.key,
          chunk_index: n,
          content_markdown: document.text.slice(at, at + size),
        });
      report.stored += 1;
    }
    return report;
  }
}

export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Execution {
  id: string;
  dataset: string;
  pipeline: string;
  pipelineVersion: number;
  backend: string;
  status: ExecutionStatus;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  report?: IngestionReport;
  error?: string;
  cancelledBy?: string;
}

export interface ExecutionStore {
  save(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
  list(dataset: string, pipeline: string): Promise<Execution[]>;
  failStale(input: {
    startedBefore: string;
    except: string[];
    endedAt: string;
    error: string;
  }): Promise<number>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly #executions = new Map<string, Execution>();

  async save(execution: Execution) {
    this.#executions.set(execution.id, structuredClone(execution));
  }

  async get(id: string) {
    const found = this.#executions.get(id);
    return found && structuredClone(found);
  }

  async list(dataset: string, pipeline: string) {
    return [...this.#executions.values()]
      .filter((e) => e.dataset === dataset && e.pipeline === pipeline)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((e) => structuredClone(e));
  }

  async failStale(input: {
    startedBefore: string;
    except: string[];
    endedAt: string;
    error: string;
  }) {
    const stale = [...this.#executions.values()].filter(
      (e) =>
        e.status === 'running' && e.startedAt < input.startedBefore && !input.except.includes(e.id),
    );
    for (const e of stale)
      this.#executions.set(e.id, {
        ...e,
        status: 'failed',
        endedAt: input.endedAt,
        error: input.error,
      });
    return stale.length;
  }
}

export type PipelineResult =
  | { ok: true; value: Pipeline }
  | { ok: false; errors: { path: string; message: string }[]; conflict?: boolean };

const kind = 'ingestion-pipeline';
const scheduleKind = 'ingestion-schedule';
const scheduleActor = 'platform:ingestion-schedule';

const toPipeline = (entry: ConfigEntry<unknown>): Pipeline => {
  const split = entry.id.lastIndexOf('#');
  return {
    dataset: entry.id.slice(0, split),
    id: entry.id.slice(split + 1),
    version: entry.version,
    spec: entry.spec as PipelineSpec,
    by: entry.by,
    at: entry.at,
    reason: entry.reason,
  };
};

export const ingestionLockedMessage =
  'the environment is locked: only clients from the configuration may run ingestion here';

export const runLockedMessage = (dataset: string, execution: string) =>
  `the dataset ${dataset} is already being ingested by run ${execution}; wait for it to finish or cancel it`;

export const staleRunMessage = 'the platform restarted while the run was going';

export const staleRunHours = 6;

export const writerLockKeys = (target: IngestionTarget) => [
  `dataset:${target.dataset}`,
  ...Object.values(target.collections).map((c) => `collection:${target.endpoint}/${c}`),
];

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
  );

interface RunningExecution {
  execution: Execution;
  controller: AbortController;
  keys: string[];
  cancelledBy?: string;
}

export class IngestionService {
  readonly #serial = serialized();
  readonly #finished = new Set<(execution: Execution) => void>();
  readonly #running = new Map<string, RunningExecution>();

  constructor(
    private readonly options: {
      store: ConfigEntryStore;
      executions: ExecutionStore;
      backend: IngestionBackend;
      now?: () => Date;
      newId?: () => string;
      admits?: (principal: Principal | undefined) => boolean;
      onRefused?: (message: string) => void;
      onError?: (message: string) => void;
    },
  ) {}

  get backend() {
    return {
      name: this.options.backend.name,
      available: this.options.backend.available,
      ...(this.options.backend.unavailableReason
        ? { reason: this.options.backend.unavailableReason }
        : {}),
    };
  }

  availability(target: IngestionTarget, pipeline?: Pipeline): BackendStatus {
    const backend = this.options.backend;
    const reason = backend.available
      ? backend.unavailableFor?.(target, pipeline)
      : (backend.unavailableReason ?? 'ingestion is not available');
    return { name: backend.name, available: reason === undefined, ...(reason ? { reason } : {}) };
  }

  async failStaleRuns(): Promise<number> {
    const now = this.options.now?.() ?? new Date();
    return this.options.executions.failStale({
      startedBefore: new Date(now.getTime() - staleRunHours * 3_600_000).toISOString(),
      except: [...this.#running.keys()],
      endedAt: now.toISOString(),
      error: staleRunMessage,
    });
  }

  #now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  async list(scope: string, dataset: string): Promise<Pipeline[]> {
    return (await this.options.store.latest({ kind, scope }))
      .filter((e) => !e.deleted && e.id.startsWith(`${dataset}#`))
      .map(toPipeline)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(scope: string, dataset: string, id: string): Promise<Pipeline | undefined> {
    const latest = (await this.options.store.history(kind, scope, `${dataset}#${id}`)).at(-1);
    return latest && !latest.deleted ? toPipeline(latest) : undefined;
  }

  async versions(scope: string, dataset: string, id: string): Promise<PipelineVersion[]> {
    return (await this.options.store.history(kind, scope, `${dataset}#${id}`)).map((entry) => ({
      ...toPipeline(entry),
      deleted: entry.deleted,
    }));
  }

  async save(input: {
    scope: string;
    dataset: string;
    id: string;
    spec: unknown;
    by: string;
    reason: string;
    ifVersion?: number;
  }): Promise<PipelineResult> {
    return this.#serial(async () => {
      if (!slug.safeParse(input.id).success)
        return { ok: false, errors: [{ path: 'id', message: 'not a valid id' }] };
      const parsed = pipelineSpec.safeParse(input.spec);
      if (!parsed.success)
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => ({
            path: ['spec', ...i.path.map(String)].join('.'),
            message: i.message,
          })),
        };
      try {
        const saved = await appendVersion(this.options.store, {
          kind,
          scope: input.scope,
          id: `${input.dataset}#${input.id}`,
          spec: parsed.data,
          deleted: false,
          by: input.by,
          reason: input.reason,
          at: this.#now(),
          ...(input.ifVersion !== undefined ? { ifVersion: input.ifVersion } : {}),
        });
        return { ok: true, value: toPipeline(saved) };
      } catch (error) {
        if (error instanceof VersionConflict)
          return {
            ok: false,
            conflict: true,
            errors: [{ path: 'if-match', message: error.message }],
          };
        throw error;
      }
    });
  }

  async remove(input: {
    scope: string;
    dataset: string;
    id: string;
    by: string;
    reason: string;
  }): Promise<PipelineResult> {
    return this.#serial(async () => {
      const current = await this.get(input.scope, input.dataset, input.id);
      if (!current)
        return { ok: false, errors: [{ path: 'id', message: `no pipeline ${input.id}` }] };
      const saved = await appendVersion(this.options.store, {
        kind,
        scope: input.scope,
        id: `${input.dataset}#${input.id}`,
        spec: current.spec,
        deleted: true,
        by: input.by,
        reason: input.reason,
        at: this.#now(),
      });
      return { ok: true, value: toPipeline(saved) };
    });
  }

  #holder(target: IngestionTarget) {
    const keys = new Set(writerLockKeys(target));
    return [...this.#running.values()].find((r) => r.keys.some((k) => keys.has(k)));
  }

  running(dataset: string) {
    return [...this.#running.values()]
      .filter((r) => r.execution.dataset === dataset)
      .map((r) => r.execution);
  }

  async execute(input: {
    pipeline: Pipeline;
    target: IngestionTarget;
    by: string;
    tenant?: string;
    principal?: Principal;
  }): Promise<
    | { ok: true; value: Execution; done: Promise<Execution> }
    | { ok: false; errors: { path: string; message: string }[]; conflict?: boolean }
  > {
    if (this.options.admits && !this.options.admits(input.principal)) {
      this.options.onRefused?.(
        `${ingestionLockedMessage}; ${input.pipeline.dataset}/${input.pipeline.id} by ${input.by} did not run`,
      );
      return { ok: false, errors: [{ path: 'principal', message: ingestionLockedMessage }] };
    }
    const backend = this.options.backend;
    const status = this.availability(input.target, input.pipeline);
    if (!status.available)
      return {
        ok: false,
        errors: [{ path: 'backend', message: status.reason ?? 'ingestion is not available' }],
      };
    if (!input.pipeline.spec.enabled)
      return { ok: false, errors: [{ path: 'enabled', message: 'the pipeline is turned off' }] };
    const holder = this.#holder(input.target);
    if (holder)
      return {
        ok: false,
        conflict: true,
        errors: [
          { path: 'dataset', message: runLockedMessage(input.target.dataset, holder.execution.id) },
        ],
      };
    const execution: Execution = {
      id: this.options.newId?.() ?? crypto.randomUUID(),
      dataset: input.pipeline.dataset,
      pipeline: input.pipeline.id,
      pipelineVersion: input.pipeline.version,
      backend: backend.name,
      status: 'running',
      startedBy: input.by,
      startedAt: this.#now(),
    };
    const controller = new AbortController();
    const running: RunningExecution = {
      execution,
      controller,
      keys: writerLockKeys(input.target),
    };
    this.#running.set(execution.id, running);
    const done = this.options.executions
      .save(execution)
      .then(() =>
        Promise.race([
          backend.run(
            {
              execution: execution.id,
              pipeline: input.pipeline,
              target: input.target,
              ...(input.tenant ? { tenant: input.tenant } : {}),
              ...(this.options.admits ? { admitted: true } : {}),
            },
            controller.signal,
          ),
          aborted(controller.signal),
        ]),
      )
      .then(
        (report): Execution => ({
          ...execution,
          status: 'succeeded',
          report,
          endedAt: this.#now(),
        }),
        (error: unknown): Execution =>
          controller.signal.aborted
            ? {
                ...execution,
                status: 'cancelled',
                endedAt: this.#now(),
                ...(running.cancelledBy ? { cancelledBy: running.cancelledBy } : {}),
              }
            : {
                ...execution,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
                endedAt: this.#now(),
              },
      )
      .then(async (finished) => {
        try {
          await this.options.executions.save(finished);
        } catch (error) {
          this.options.onError?.(
            `ingestion ${execution.id} ended as ${finished.status} but was not saved: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          this.#running.delete(execution.id);
        }
        for (const listener of this.#finished) listener(finished);
        return finished;
      });
    return { ok: true, value: execution, done };
  }

  cancel(input: {
    dataset: string;
    execution: string;
    by: string;
  }): { ok: true; value: Execution } | { ok: false; errors: { path: string; message: string }[] } {
    const running = this.#running.get(input.execution);
    if (!running || running.execution.dataset !== input.dataset)
      return {
        ok: false,
        errors: [{ path: 'execution', message: `no running ingestion ${input.execution}` }],
      };
    running.cancelledBy = input.by;
    running.controller.abort(new Error(`cancelled by ${input.by}`));
    return { ok: true, value: running.execution };
  }

  onFinished(listener: (execution: Execution) => void) {
    this.#finished.add(listener);
    return () => {
      this.#finished.delete(listener);
    };
  }

  estimate(pipeline: Pipeline) {
    return this.options.backend.estimate?.(pipeline) ?? Promise.resolve(undefined);
  }

  executions(dataset: string, pipeline: string) {
    return this.options.executions.list(dataset, pipeline);
  }

  async nextRunAt(scope: string, pipeline: Pipeline): Promise<string | null> {
    const { schedule, enabled } = pipeline.spec;
    if (!enabled || !schedule || schedule === 'none') return null;
    const fired = (await this.options.store.history(scheduleKind, scope, scheduleId(pipeline))).at(
      -1,
    );
    const base = (fired?.spec as { firedAt?: string } | undefined)?.firedAt ?? pipeline.at;
    return nextRun(parseCron(scheduleCron[schedule]), new Date(base)).toISOString();
  }

  async runDue(
    targetOf: (pipeline: Pipeline) => IngestionTarget | undefined,
    platformScope: string,
  ): Promise<Execution[]> {
    const started: Execution[] = [];
    const now = this.#now();
    for (const entry of await this.options.store.latest({ kind })) {
      if (entry.deleted) continue;
      const pipeline = toPipeline(entry);
      const next = await this.nextRunAt(entry.scope, pipeline);
      if (!next || next > now) continue;
      const id = scheduleId(pipeline);
      const last = (await this.options.store.history(scheduleKind, entry.scope, id)).at(-1);
      try {
        await appendVersion(this.options.store, {
          kind: scheduleKind,
          scope: entry.scope,
          id,
          spec: { firedAt: now, slot: next },
          deleted: false,
          by: scheduleActor,
          reason: 'Planlagt innlesing',
          at: now,
          ifVersion: last?.version ?? 0,
        });
      } catch {
        continue;
      }
      const target = targetOf(pipeline);
      const result = target
        ? await this.execute({
            pipeline,
            target,
            by: scheduleActor,
            ...(entry.scope === platformScope ? {} : { tenant: entry.scope }),
          })
        : { ok: false as const, errors: [{ path: 'dataset', message: 'the dataset is gone' }] };
      if (result.ok) {
        started.push(result.value);
        continue;
      }
      const refused: Execution = {
        id: this.options.newId?.() ?? crypto.randomUUID(),
        dataset: pipeline.dataset,
        pipeline: pipeline.id,
        pipelineVersion: pipeline.version,
        backend: this.options.backend.name,
        status: 'failed',
        startedBy: scheduleActor,
        startedAt: now,
        endedAt: now,
        error: result.errors.map((e) => e.message).join('; '),
      };
      await this.options.executions.save(refused);
      started.push(refused);
    }
    return started;
  }
}

const scheduleId = (pipeline: Pipeline) => `${pipeline.dataset}#${pipeline.id}`;
