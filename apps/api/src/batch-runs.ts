import { randomUUID } from 'node:crypto';
import {
  checkInputFields,
  fieldsQuery,
  publicSourceUrl,
  type InputField,
  type InputValue,
  type Principal,
  type SourceLinkRule,
} from '@genai/contracts';
import type { DocumentSummary, FilterValue, KnowledgePort } from '@genai/port-knowledge';
import type { PortContext } from '@genai/kernel';
import { defaultMaxOutputTokens } from '@genai/port-model';
import { soundsLikeRefusal } from '@genai/strategy-agent-loop';
import { actorOf } from './admin.js';
import {
  backgroundLeases,
  restartMessage,
  type Leased,
  type LeaseOptions,
} from './background-lease.js';
import { appendVersion, type ConfigEntry } from './config-store.js';
import type { ServiceRunOutcome, ServiceRunSuccess } from './draft-runner.js';
import type { ModuleDeps } from './platform-modules.js';
import { lifecycleOf, runRefusal } from './service-lifecycle.js';

export const batchEstimateKind = 'batch-estimate';
export const batchRunKind = 'batch-run';
export const batchItemKind = 'batch-run-item';
export const batchCancelKind = 'batch-run-cancel';
export const approvalLimitKey = 'batch.approvalLimitNok';
export const defaultApprovalLimitNok = 150;
const minApprovalReason = 10;

export const maxBatchItems = 1000;
export const maxConcurrency = 8;
const defaultConcurrency = 4;
const estimateTtlMs = 24 * 60 * 60_000;
const pageSize = 250;
const chunkTokens = 350;
const retrievedTokens = 8 * chunkTokens;
const maxDocumentTokens = 30_000;
const singleCallStrategies = new Set(['single-call', 'rag-single-shot']);
const rangeWindow = 50;
const defaultContextTokens = 16_000;
const sampleSize = 3;
const sampleMargin = 1.5;
const assumedOutputPerCall = 4000;
const minItemOutputTokens = 1500;
const truncatedMarker = '[Dokumentet er avkortet her fordi det er for langt for modellen.]';

export interface Range {
  low: number;
  high: number;
}

export interface BatchDocument {
  id: string;
  title: string;
  url?: string;
}

export interface BatchExclusions {
  duplicates: { document: BatchDocument; keptId: string }[];
  otherYear: BatchDocument[];
}

export interface BatchSample {
  document: string;
  inputTokens: number;
  outputTokens: number;
  costMicroNok: number | null;
  output: string;
  error?: string;
}

export interface BatchEstimate {
  id: string;
  service: string;
  version: number;
  model: string | null;
  priced: boolean;
  dataset: string;
  filters: Record<string, FilterValue>;
  prompt?: string;
  input?: Record<string, InputValue>;
  documents: BatchDocument[];
  found?: number;
  excluded?: BatchExclusions;
  items: number;
  perItem: { inputTokens: Range; outputTokens: Range; costMicroNok: Range | null };
  maxOutputTokens: number;
  tokens: Range;
  costMicroNok: Range | null;
  basis: 'measured' | 'assumed';
  samples: BatchSample[];
  createdAt: string;
  expiresAt: string;
}

export type BatchRunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';
export type BatchItemStatus =
  'queued' | 'running' | 'succeeded' | 'notFound' | 'failed' | 'skipped';

export interface BatchCap {
  costMicroNok?: number;
  tokens?: number;
}

export interface BatchRun extends Leased {
  id: string;
  service: string;
  version: number;
  model: string | null;
  priced: boolean;
  dataset: string;
  filters: Record<string, FilterValue>;
  prompt?: string;
  input?: Record<string, InputValue>;
  estimate: string;
  startedBy?: string;
  startedByName?: string;
  costApproval?: BatchApproval;
  status: BatchRunStatus;
  total: number;
  concurrency: number;
  cap: BatchCap;
  perItem: BatchEstimate['perItem'];
  maxOutputTokens?: number;
  pass: number;
  queue?: number[];
  startedAt: string;
  endedAt: string | null;
  error?: string;
  errorCode?: string;
}

export interface BatchApproval {
  by: string;
  at: string;
  reason: string;
  limitNok: number;
}

export interface BatchSource {
  title?: string;
  url?: string;
  document?: string;
}

const legacyFailureTexts: [RegExp, string][] = [
  [/^task emitted more than \d+ events/, 'limit_exceeded'],
  [/^budget for \w+ exceeded/, 'budget_exceeded'],
  [/^deadline of \d+ ms passed/, 'deadline_exceeded'],
];

const legacyFailureCode = (item: Pick<BatchItem, 'error' | 'errorCode'>) => {
  if (item.errorCode || !item.error) return {};
  const found = legacyFailureTexts.find(([pattern]) => pattern.test(item.error as string));
  return found ? { errorCode: found[1] } : {};
};

export interface BatchItem {
  run: string;
  index: number;
  document: BatchDocument;
  status: BatchItemStatus;
  attempts: number;
  pass: number;
  task?: string;
  version?: number;
  output?: string;
  noAnswer?: boolean;
  truncated?: boolean;
  error?: string;
  errorCode?: string;
  sources: BatchSource[];
  models: string[];
  tokens: { input: number; output: number };
  costMicroNok: number;
  startedAt?: string;
  endedAt?: string;
}

export interface BatchTotals {
  counts: Record<BatchItemStatus, number>;
  tokens: { input: number; output: number };
  costMicroNok: number | null;
}

export class BatchProblem extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    message: string,
    readonly path = '',
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BatchProblem';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shortRefusalLength = 80;

export const notFoundOf = (outcome: Pick<ServiceRunSuccess, 'noAnswer' | 'answer' | 'parts'>) =>
  outcome.noAnswer ||
  outcome.parts.some((p) => p.meta?.noAnswer === true) ||
  (outcome.answer.trim().length <= shortRefusalLength && soundsLikeRefusal(outcome.answer));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const microOf = (tokens: { input: number; output: number }, price: ModelPriceLike | undefined) =>
  price
    ? Math.round(
        ((tokens.input / 1000) * price.inputPerThousand +
          (tokens.output / 1000) * price.outputPerThousand) *
          1_000_000,
      )
    : 0;

interface ModelPriceLike {
  inputPerThousand: number;
  outputPerThousand: number;
}

const queryOf = (
  prompt: string | undefined,
  document: BatchDocument,
  fields: InputField[] = [],
  input: Record<string, InputValue> = {},
) =>
  fieldsQuery(fields, input, prompt ? `${prompt}\n\nDokument: ${document.title}` : document.title);

const reservationOf = (perItem: BatchEstimate['perItem']) => ({
  micro: perItem.costMicroNok?.high ?? 0,
  tokens: perItem.inputTokens.high + perItem.outputTokens.high,
});

const sizeOf = (doc: DocumentSummary) => {
  const chunks = Number(doc.fields.total_chunks);
  return Number.isFinite(chunks) ? chunks : 0;
};

const samplesOf = (docs: DocumentSummary[]) => {
  const sorted = [...docs].sort((a, b) => sizeOf(a) - sizeOf(b));
  const count = Math.min(sampleSize, sorted.length);
  if (count <= 1) return sorted.slice(0, count);
  const picked = new Set<number>();
  for (let i = 0; i < count; i += 1)
    picked.add(Math.round((i * (sorted.length - 1)) / (count - 1)));
  return [...picked].sort((a, b) => a - b).flatMap((i) => sorted[i] ?? []);
};

const itemKey = (run: string, index: number) => `${run}/${String(index).padStart(5, '0')}`;

const toDocument = (doc: DocumentSummary): BatchDocument => ({
  id: doc.id,
  title: doc.title ?? doc.id,
  ...(doc.url ? { url: doc.url } : {}),
});

const yearValue = /^(?:19|20)\d{2}$/;
const statedYears = /\b(?:19|20)\d{2}\b/g;

const selectedYears = (filters: Record<string, FilterValue>) => {
  const years = new Set<string>();
  for (const value of Object.values(filters)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 0 && values.every((v) => yearValue.test(String(v))))
      for (const v of values) years.add(String(v));
  }
  return years;
};

const listOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : value === undefined || value === null
      ? []
      : [String(value)];

const versionKeys = (doc: DocumentSummary) => {
  const digests = listOf(doc.fields.file_sha256);
  const files = Array.isArray(doc.fields.files)
    ? doc.fields.files.flatMap((f: unknown) => {
        const sha = isRecord(f) ? f.sha256 : undefined;
        return typeof sha === 'string' ? [sha] : [];
      })
    : [];
  const digest = digests.length ? digests : files;
  const title = doc.title?.trim().toLowerCase().replace(/\s+/g, ' ');
  const orgs = listOf(doc.fields.orgs_short).sort().join(',');
  return [
    ...(digest.length === 1 ? [`file:${digest[0]}`] : []),
    ...(title ? [`title:${title}|${orgs}`] : []),
  ];
};

const publishedAt = (doc: DocumentSummary) => {
  const value = doc.fields.publish_date;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
};

const newestFirst = (a: DocumentSummary, b: DocumentSummary) => {
  const byDate = publishedAt(b) - publishedAt(a);
  if (byDate !== 0) return byDate;
  const numbers = /^\d+$/.test(a.id) && /^\d+$/.test(b.id);
  return numbers ? Number(b.id) - Number(a.id) : b.id.localeCompare(a.id);
};

export const selectDocuments = (docs: DocumentSummary[], filters: Record<string, FilterValue>) => {
  const years = selectedYears(filters);
  const otherYear: DocumentSummary[] = [];
  const inYear = docs.filter((doc) => {
    const stated = doc.title?.match(statedYears) ?? [];
    const outside = years.size > 0 && stated.length > 0 && !stated.some((y) => years.has(y));
    if (outside) otherYear.push(doc);
    return !outside;
  });
  const keptBy = new Map<string, string>();
  const duplicates: { doc: DocumentSummary; keptId: string }[] = [];
  const kept = new Set<string>();
  for (const doc of [...inYear].sort(newestFirst)) {
    const keys = versionKeys(doc);
    const newer = keys.map((k) => keptBy.get(k)).find((id) => id !== undefined);
    if (newer !== undefined) {
      duplicates.push({ doc, keptId: newer });
      continue;
    }
    kept.add(doc.id);
    for (const key of keys) keptBy.set(key, doc.id);
  }
  return { kept: inYear.filter((d) => kept.has(d.id)), duplicates, otherYear };
};

const linkedSource = (source: BatchSource, rule: SourceLinkRule | undefined): BatchSource => {
  const url = publicSourceUrl(source, rule);
  const rest: BatchSource = { ...source };
  delete rest.url;
  return { ...rest, ...(url ? { url } : {}) };
};

export const cleanSources = (
  document: BatchDocument,
  sources: BatchSource[],
  rule?: SourceLinkRule,
): BatchSource[] => {
  const own = linkedSource(
    {
      title: document.title,
      document: document.id,
      ...(document.url ? { url: document.url } : {}),
    },
    rule,
  );
  const byKey = new Map<string, BatchSource>();
  for (const source of [own, ...sources.map((s) => linkedSource(s, rule))]) {
    const key = source.document ?? source.url ?? source.title;
    if (!key) continue;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, source);
    else if (!seen.url && source.url) byKey.set(key, { ...seen, url: source.url });
  }
  return [...byKey.values()];
};

export const batchRuns = (deps: ModuleDeps, leaseOptions: LeaseOptions = {}) => {
  const leases = backgroundLeases(leaseOptions);
  const cancels = new Map<string, () => void>();

  const visibleDatasets = (tenant: string) =>
    [...deps.knowledge.datasets()]
      .filter(([, d]) => !d.tenants || d.tenants.includes(tenant))
      .map(([id, d]) => ({ id, name: d.name ?? id.slice(id.lastIndexOf('/') + 1) }));

  const contextFor = (principal: Principal, tenant: string): PortContext => ({
    tenant,
    principal,
    task: `batch:${randomUUID()}`,
    signal: new AbortController().signal,
    meter: async () => undefined,
  });

  const linkRuleOf = (dataset: string) => {
    const id = deps.knowledge.resolve(dataset) ?? dataset;
    return deps.catalog.get('dataset', id)?.spec.links as SourceLinkRule | undefined;
  };

  const linkedDocument = (document: BatchDocument, rule: SourceLinkRule | undefined) => {
    if (document.url || !rule) return document;
    const url = publicSourceUrl({ document: document.id, title: document.title }, rule);
    return url ? { ...document, url } : document;
  };

  const portFor = (principal: Principal, tenant: string, dataset: string): KnowledgePort => {
    const id = deps.knowledge.resolve(dataset);
    if (!id || !visibleDatasets(tenant).some((d) => d.id === id))
      throw new BatchProblem(404, `Fant ikke datasettet ${dataset}`, 'dataset');
    return deps.knowledge.open({ kind: 'dataset', id, tenant }, contextFor(principal, tenant));
  };

  const assertRunnable = async (tenant: string, service: string) => {
    const refusal = runRefusal(await lifecycleOf(deps.configEntries, tenant, service));
    if (refusal) throw new BatchProblem(503, refusal.message, 'service', refusal.code);
  };

  const published = async (tenant: string, service: string, version?: number) => {
    const compiled = (await deps.definitions.capabilities()).find(
      (c) => c.service.tenant === tenant && c.service.id === service,
    );
    const stored = await deps.definitions.get('Service', tenant, service, version);
    if (!compiled || !stored) throw new BatchProblem(404, 'Tjenesten er ikke publisert');
    const capability =
      version === undefined || version === compiled.service.version
        ? compiled.capability.descriptor.id
        : await deps.pinService?.(tenant, service, version);
    if (!capability || stored.version !== (version ?? stored.version))
      throw new BatchProblem(409, `Tjenesten har ingen publisert versjon ${version}`);
    const spec = (stored.definition as { spec?: Record<string, unknown> }).spec ?? {};
    const model =
      isRecord(spec.model) && typeof spec.model.primary === 'string' ? spec.model.primary : null;
    const strategy = isRecord(spec.strategy) ? spec.strategy : {};
    const datasets =
      isRecord(spec.knowledge) && Array.isArray(spec.knowledge.datasets)
        ? spec.knowledge.datasets.flatMap((d) =>
            isRecord(d) && typeof d.dataset === 'string' ? [d.dataset] : [],
          )
        : [];
    const config = isRecord(strategy.config) ? strategy.config : {};
    const settings = isRecord(spec.settings) ? spec.settings : {};
    const configured = [
      config.maxTokens,
      config.synthesisMaxTokens,
      settings['synthesis.maxTokens'],
    ].filter((v): v is number => typeof v === 'number' && v > 0);
    const maxTokens = configured.length ? Math.max(...configured) : undefined;
    const fields = (
      isRecord(spec.input) && Array.isArray(spec.input.fields) ? spec.input.fields : []
    ) as InputField[];
    return { capability, version: stored.version, model, strategy, datasets, maxTokens, fields };
  };

  type Subject = Awaited<ReturnType<typeof published>>;

  const contextTokens = (principal: Principal, tenant: string, model: string | null) => {
    if (!model) return defaultContextTokens;
    try {
      const window = deps.models
        .open({ kind: 'model', id: model, tenant }, contextFor(principal, tenant))
        .info().contextWindow;
      return window ? Math.floor(window / 2) : defaultContextTokens;
    } catch {
      return defaultContextTokens;
    }
  };

  const documentText = async (
    principal: Principal,
    tenant: string,
    dataset: string,
    document: BatchDocument,
    maxTokens: number,
  ) => {
    const port = portFor(principal, tenant, dataset);
    const maxChars = maxTokens * 4;
    let text = '';
    for (let from = 0; text.length <= maxChars; from += rangeWindow) {
      const window = await port.range(document.id, from, from + rangeWindow - 1);
      text += window.map((h) => h.text).join('\n\n') + (window.length ? '\n\n' : '');
      if (window.length < rangeWindow) break;
    }
    text = text.trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n${truncatedMarker}` : text;
  };

  const sources = async (principal: Principal, tenant: string, service: string) => {
    const subject = await published(tenant, service);
    const used = new Set(subject.datasets.map((d) => deps.knowledge.resolve(d) ?? d));
    const out = [];
    for (const dataset of visibleDatasets(tenant)) {
      let port: KnowledgePort;
      try {
        port = portFor(principal, tenant, dataset.id);
      } catch {
        continue;
      }
      if (!port.documents) continue;
      const declared = Object.entries(port.info().filters).filter(([, kind]) =>
        (Array.isArray(kind) ? kind : [kind]).some((k) => k === 'select' || k === 'multiselect'),
      );
      const values = declared.length
        ? await port.facets(declared.map(([field]) => field)).catch(() => ({}))
        : {};
      const filters = declared.flatMap(([field]) => {
        const options = (values as Record<string, { value: string; count: number }[]>)[field] ?? [];
        const identifying = options.length > 20 && options.every((o) => o.count === 1);
        return options.length === 0 || identifying ? [] : [{ field, values: options }];
      });
      out.push({
        id: dataset.id,
        name: dataset.name,
        usedByService: used.has(dataset.id),
        filters,
      });
    }
    return out.sort((a, b) => Number(b.usedByService) - Number(a.usedByService));
  };

  const resolveDocuments = async (
    port: KnowledgePort,
    request: { ids?: string[]; filters: Record<string, FilterValue> },
  ) => {
    const list = port.documents?.bind(port);
    if (!list) throw new BatchProblem(422, 'Datasettet kan ikke liste dokumentene sine', 'dataset');
    const found: DocumentSummary[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await list({
        ...(request.ids ? { ids: request.ids } : {}),
        filters: request.filters,
        limit: pageSize,
        offset,
      });
      found.push(...page.documents);
      if ((page.found ?? 0) > maxBatchItems || found.length > maxBatchItems)
        throw new BatchProblem(
          422,
          `Utvalget har ${page.found ?? found.length} dokumenter. Snevre inn til høyst ${maxBatchItems}.`,
          'filters',
        );
      if (page.documents.length < pageSize) break;
    }
    const unique = new Map(found.filter((d) => d.id).map((d) => [d.id, d]));
    return [...unique.values()];
  };

  const heuristic = (
    subject: Subject,
    prompt: string | undefined,
    docs: DocumentSummary[],
    inline: number | undefined,
  ) => {
    const { strategy } = subject;
    const calls = singleCallStrategies.has(String(strategy.id)) ? 1 : 3;
    const promptTokens = Math.ceil(
      (JSON.stringify(strategy.config ?? {}).length + (prompt?.length ?? 0) + 200) / 4,
    );
    const input: Range = { low: 0, high: 0 };
    for (const doc of docs) {
      const chunks = Number(doc.fields.total_chunks);
      const size = Number.isFinite(chunks) && chunks > 0 ? chunks * chunkTokens : retrievedTokens;
      if (inline !== undefined) {
        input.low += promptTokens + Math.min(size, inline);
        input.high += (promptTokens + Math.min(size, inline)) * calls;
        continue;
      }
      input.low += promptTokens + Math.min(size, retrievedTokens);
      input.high +=
        (promptTokens + Math.min(Math.max(size, retrievedTokens), maxDocumentTokens)) * calls;
    }
    const n = Math.max(docs.length, 1);
    return {
      inputTokens: { low: Math.round(input.low / n), high: Math.round(input.high / n) },
      outputTokens: { low: 150, high: assumedOutputPerCall * calls },
    };
  };

  const invokeItem = async (
    principal: Principal,
    tenant: string,
    subject: Subject,
    dataset: string,
    prompt: string | undefined,
    document: BatchDocument,
    maxOutputTokens?: number,
    input: Record<string, InputValue> = {},
  ): Promise<ServiceRunOutcome> => {
    const query = queryOf(prompt, document, subject.fields, input);
    const text =
      subject.datasets.length === 0
        ? await documentText(
            principal,
            tenant,
            dataset,
            document,
            contextTokens(principal, tenant, subject.model),
          )
        : '';
    const message = text ? `${query}\n\n${text}` : query;
    return deps.drafts.invoke({
      principal,
      tenant,
      capability: subject.capability,
      ...(subject.model ? { primaryModel: subject.model } : {}),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      data: { ...input, query, history: [], document: { ...document, dataset } },
      parts: [{ kind: 'text', text: message }],
    });
  };

  const estimate = async (
    principal: Principal,
    tenant: string,
    service: string,
    body: {
      dataset: string;
      filters: Record<string, FilterValue>;
      documents?: string[];
      prompt?: string;
      input?: Record<string, unknown>;
      sample?: boolean;
    },
    reason: string,
  ): Promise<BatchEstimate> => {
    const subject = await published(tenant, service);
    let input: Record<string, InputValue> | undefined;
    if (body.input !== undefined) {
      const checked = checkInputFields(subject.fields, body.input);
      if (!checked.ok)
        throw new BatchProblem(
          422,
          checked.errors.map((e) => e.message).join(' '),
          `input.${checked.errors[0]?.path ?? ''}`,
        );
      input = checked.values;
    }
    const port = portFor(principal, tenant, body.dataset);
    const dataset = port.info().id;
    let docs: DocumentSummary[];
    try {
      docs = await resolveDocuments(port, {
        ...(body.documents ? { ids: body.documents } : {}),
        filters: body.filters,
      });
    } catch (error) {
      if (error instanceof BatchProblem) throw error;
      throw new BatchProblem(422, messageOf(error), 'filters');
    }
    const found = docs.length;
    let excluded: BatchExclusions | undefined;
    if (!body.documents) {
      const selected = selectDocuments(docs, body.filters);
      docs = selected.kept;
      excluded = {
        duplicates: selected.duplicates.map((d) => ({
          document: toDocument(d.doc),
          keptId: d.keptId,
        })),
        otherYear: selected.otherYear.map(toDocument),
      };
    }
    if (docs.length === 0) throw new BatchProblem(422, 'Utvalget har ingen dokumenter', 'filters');
    const price = subject.model ? deps.prices[subject.model] : undefined;
    let perItem = heuristic(
      subject,
      body.prompt,
      docs,
      subject.datasets.length === 0 ? contextTokens(principal, tenant, subject.model) : undefined,
    );
    const samples: BatchSample[] = [];
    if (body.sample !== false && docs.length > sampleSize)
      for (const doc of samplesOf(docs)) {
        const outcome = await invokeItem(
          principal,
          tenant,
          subject,
          dataset,
          body.prompt,
          toDocument(doc),
          undefined,
          input,
        );
        samples.push(
          outcome.ok
            ? {
                document: doc.id,
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
                costMicroNok: price ? outcome.costMicroNok : null,
                output: outcome.answer,
              }
            : {
                document: doc.id,
                inputTokens: 0,
                outputTokens: 0,
                costMicroNok: null,
                output: '',
                error: outcome.errors.map((e) => e.message).join('; '),
              },
        );
      }
    const measured = samples.filter((s) => !s.error);
    if (measured.length) {
      const spread = (values: number[]) => ({
        low: Math.round(Math.min(...values) * 0.7),
        high: Math.round(Math.max(...values) * sampleMargin),
      });
      perItem = {
        inputTokens: spread(measured.map((s) => s.inputTokens)),
        outputTokens: spread(measured.map((s) => s.outputTokens)),
      };
    }
    const maxOutputTokens = Math.min(
      Math.max(perItem.outputTokens.high, minItemOutputTokens),
      subject.maxTokens ?? defaultMaxOutputTokens,
    );
    perItem = {
      ...perItem,
      outputTokens: {
        low: Math.min(perItem.outputTokens.low, maxOutputTokens),
        high: maxOutputTokens,
      },
    };
    const items = docs.length;
    const perItemCost = price
      ? {
          low: microOf({ input: perItem.inputTokens.low, output: perItem.outputTokens.low }, price),
          high: microOf(
            { input: perItem.inputTokens.high, output: perItem.outputTokens.high },
            price,
          ),
        }
      : null;
    const now = leases.now();
    const saved: BatchEstimate = {
      id: randomUUID(),
      service,
      version: subject.version,
      model: subject.model,
      priced: Boolean(price),
      dataset,
      filters: body.filters,
      ...(body.prompt ? { prompt: body.prompt } : {}),
      ...(input && Object.keys(input).length ? { input } : {}),
      documents: docs.map(toDocument),
      found,
      ...(excluded ? { excluded } : {}),
      items,
      perItem: { ...perItem, costMicroNok: perItemCost },
      maxOutputTokens,
      tokens: {
        low: items * (perItem.inputTokens.low + perItem.outputTokens.low),
        high: items * (perItem.inputTokens.high + perItem.outputTokens.high),
      },
      costMicroNok: perItemCost
        ? { low: items * perItemCost.low, high: items * perItemCost.high }
        : null,
      basis: measured.length ? 'measured' : 'assumed',
      samples,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + estimateTtlMs).toISOString(),
    };
    await appendVersion<BatchEstimate>(deps.configEntries, {
      kind: batchEstimateKind,
      scope: tenant,
      id: saved.id,
      spec: saved,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
    });
    return saved;
  };

  const latestOf = async <T>(kind: string, tenant: string, id: string) =>
    (await deps.configEntries.history(kind, tenant, id)).at(-1) as ConfigEntry<T> | undefined;

  const itemsOf = async (tenant: string, run: string) => {
    const entries = await deps.configEntries.latest({ kind: batchItemKind, scope: tenant });
    const byIndex = new Map<number, BatchItem>();
    for (const entry of entries) {
      const item = entry.spec as BatchItem;
      if (item.run === run) byIndex.set(item.index, item);
    }
    return byIndex;
  };

  const saveItem = (actor: string, tenant: string, item: BatchItem, reason: string) =>
    appendVersion<BatchItem>(deps.configEntries, {
      kind: batchItemKind,
      scope: tenant,
      id: itemKey(item.run, item.index),
      spec: item,
      deleted: false,
      by: actor,
      reason,
    });

  const saveRun = (actor: string, tenant: string, run: BatchRun, reason: string) =>
    appendVersion<BatchRun>(deps.configEntries, {
      kind: batchRunKind,
      scope: tenant,
      id: run.id,
      spec: run,
      deleted: false,
      by: actor,
      reason,
    });

  const active = (run: BatchRun) => run.status === 'queued' || run.status === 'running';

  const withStarter = async (scope: string, run: BatchRun) => {
    if (run.startedBy) return run;
    const first = (await deps.configEntries.history(batchRunKind, scope, run.id))[0];
    return first ? { ...run, startedBy: first.by } : run;
  };

  const settled = async (entry: ConfigEntry<BatchRun>) =>
    withStarter(entry.scope, await settle(entry));

  const settle = async (entry: ConfigEntry<BatchRun>) => {
    const run = entry.spec;
    if (!active(run)) return run;
    if (!leases.abandoned(`${entry.scope}/${run.id}`, run, run.startedAt)) return run;
    const failed: BatchRun = {
      ...run,
      status: 'failed',
      endedAt: leases.now().toISOString(),
      error: restartMessage,
      errorCode: 'restarted',
    };
    try {
      await appendVersion<BatchRun>(deps.configEntries, {
        kind: batchRunKind,
        scope: entry.scope,
        id: run.id,
        spec: failed,
        deleted: false,
        by: 'platform:restart',
        reason: restartMessage,
        ifVersion: entry.version,
      });
    } catch {
      return failed;
    }
    for (const item of (await itemsOf(entry.scope, run.id)).values())
      if (item.status === 'running')
        await saveItem(
          'platform:restart',
          entry.scope,
          {
            ...item,
            status: 'failed',
            error: restartMessage,
            errorCode: 'restarted',
            endedAt: failed.endedAt ?? '',
          },
          restartMessage,
        );
    return failed;
  };

  const runOf = async (tenant: string, service: string, id: string) => {
    const entry = await latestOf<BatchRun>(batchRunKind, tenant, id);
    if (!entry || entry.spec.service !== service) return undefined;
    return settled(entry);
  };

  const runsOf = async (tenant: string, service: string) =>
    (
      await Promise.all(
        (await deps.configEntries.latest({ kind: batchRunKind, scope: tenant }))
          .filter((e) => (e.spec as BatchRun).service === service)
          .map((e) => settled(e as ConfigEntry<BatchRun>)),
      )
    ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const recover = async () => {
    for (const entry of await deps.configEntries.latest({ kind: batchRunKind }))
      await settled(entry as ConfigEntry<BatchRun>);
  };

  const documentsOf = async (tenant: string, run: BatchRun) =>
    (await latestOf<BatchEstimate>(batchEstimateKind, tenant, run.estimate))?.spec.documents ?? [];

  const totalsOf = (run: BatchRun, items: BatchItem[]): BatchTotals => {
    const counts: Record<BatchItemStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      notFound: 0,
      failed: 0,
      skipped: 0,
    };
    let input = 0;
    let output = 0;
    let micro = 0;
    for (const item of items) {
      counts[item.status] += 1;
      input += item.tokens.input;
      output += item.tokens.output;
      micro += item.costMicroNok;
    }
    return {
      counts,
      tokens: { input, output },
      costMicroNok: run.priced || input + output === 0 ? micro : null,
    };
  };

  const detail = async (tenant: string, run: BatchRun) => {
    const documents = await documentsOf(tenant, run);
    const stored = await itemsOf(tenant, run.id);
    const waiting = (index: number) => active(run) && (!run.queue || run.queue.includes(index));
    const rule = linkRuleOf(run.dataset);
    const items = documents.map((listed, index): BatchItem => {
      const document = linkedDocument(listed, rule);
      const saved = stored.get(index);
      const item = saved && {
        ...saved,
        ...legacyFailureCode(saved),
        ...(saved.status === 'succeeded' && saved.noAnswer ? { status: 'notFound' as const } : {}),
        document: linkedDocument(saved.document, rule),
        sources:
          saved.status === 'succeeded' || saved.status === 'notFound'
            ? cleanSources(document, saved.sources, rule)
            : saved.sources,
      };
      if (item)
        return waiting(index) && item.pass < run.pass ? { ...item, status: 'queued' } : item;
      return {
        run: run.id,
        index,
        document,
        status: waiting(index) ? 'queued' : 'skipped',
        attempts: 0,
        pass: 0,
        sources: [],
        models: [],
        tokens: { input: 0, output: 0 },
        costMicroNok: 0,
      };
    });
    return { run, items, totals: totalsOf(run, items) };
  };

  const capOf = (
    estimate: { priced: boolean; perItem: BatchEstimate['perItem'] },
    body: { maxCostNok?: number; maxTokens?: number },
    spent: { micro: number; tokens: number } = { micro: 0, tokens: 0 },
  ): BatchCap => {
    const cost = body.maxCostNok;
    const tokens = body.maxTokens;
    if (estimate.priced && cost === undefined)
      throw new BatchProblem(400, 'Sett et kostnadstak i kroner før du starter', 'maxCostNok');
    if (!estimate.priced && tokens === undefined)
      throw new BatchProblem(
        400,
        'Modellen har ingen pris. Sett et tak på antall tokens før du starter',
        'maxTokens',
      );
    const reserve = reservationOf(estimate.perItem);
    if (cost !== undefined && cost * 1_000_000 < reserve.micro)
      throw new BatchProblem(
        400,
        `Taket er lavere enn det ett dokument kan koste med fullt svar (${(reserve.micro / 1_000_000).toLocaleString('nb-NO')} kr)`,
        'maxCostNok',
      );
    if (tokens !== undefined && tokens < reserve.tokens)
      throw new BatchProblem(
        400,
        `Taket er lavere enn det ett dokument kan bruke med fullt svar (${reserve.tokens.toLocaleString('nb-NO')} tokens)`,
        'maxTokens',
      );
    return {
      ...(cost === undefined ? {} : { costMicroNok: spent.micro + Math.round(cost * 1_000_000) }),
      ...(tokens === undefined ? {} : { tokens: spent.tokens + Math.round(tokens) }),
    };
  };

  const quotaMessage = 'Stoppet fordi månedskvoten for tokens er brukt opp';

  const capMessage = (cap: BatchCap) =>
    cap.costMicroNok !== undefined
      ? `Stoppet fordi kostnaden nådde taket på ${(cap.costMicroNok / 1_000_000).toLocaleString('nb-NO')} kr`
      : `Stoppet fordi forbruket nådde taket på ${(cap.tokens ?? 0).toLocaleString('nb-NO')} tokens`;

  const execute = (
    principal: Principal,
    tenant: string,
    first: BatchRun,
    documents: BatchDocument[],
    indexes: number[],
    previous: Map<number, BatchItem>,
  ) => {
    const actor = actorOf(principal.actor ?? principal);
    const key = `${tenant}/${first.id}`;
    const lease = leases.hold(key, first, (run, reason) => saveRun(actor, tenant, run, reason));
    let cancelled = false;
    cancels.set(key, () => {
      cancelled = true;
    });
    const spent = { micro: 0, tokens: 0 };
    for (const item of previous.values()) {
      spent.micro += item.costMicroNok;
      spent.tokens += item.tokens.input + item.tokens.output;
    }
    const estimated = reservationOf(first.perItem);
    const price = first.model ? deps.prices[first.model] : undefined;
    const rule = linkRuleOf(first.dataset);
    let quotaSpent = 0;
    let quotaAtStart: { usedTokens: number; monthlyTokens: number } | undefined;
    const output = first.maxOutputTokens ?? first.perItem.outputTokens.high;
    let largestInput = 0;
    const observe = (item: Pick<BatchItem, 'tokens'>) => {
      largestInput = Math.max(largestInput, item.tokens.input);
    };
    for (const item of previous.values()) observe(item);
    const reserve = () => {
      const input = Math.max(
        first.perItem.inputTokens.high,
        Math.ceil(largestInput * sampleMargin),
      );
      return {
        micro: Math.max(estimated.micro, microOf({ input, output }, price)),
        tokens: Math.max(estimated.tokens, input + output),
      };
    };
    const quotaFits = async () => {
      if (!deps.quota) return true;
      quotaAtStart ??= await deps.quota(tenant, { fresh: true });
      const now = await deps.quota(tenant);
      const used = Math.max(now.usedTokens, quotaAtStart.usedTokens + quotaSpent);
      return used + (inflight + 1) * reserve().tokens <= now.monthlyTokens;
    };
    const fits = () => {
      const each = reserve();
      const held = inflight + 1;
      return (
        (first.cap.costMicroNok === undefined ||
          spent.micro + held * each.micro <= first.cap.costMicroNok) &&
        (first.cap.tokens === undefined || spent.tokens + held * each.tokens <= first.cap.tokens)
      );
    };
    let inflight = 0;
    let waiting: (() => void)[] = [];
    const released = () => new Promise<void>((resolve) => waiting.push(resolve));
    const cancelRequested = async () =>
      cancelled ||
      (await latestOf<{ run: string }>(batchCancelKind, tenant, first.id))?.spec.run === first.id;

    const runItem = async (index: number) => {
      const document = documents[index];
      if (!document) return;
      const before = previous.get(index);
      const started: BatchItem = {
        run: first.id,
        index,
        document,
        status: 'running',
        attempts: (before?.attempts ?? 0) + 1,
        pass: first.pass,
        sources: [],
        models: [],
        tokens: { input: 0, output: 0 },
        costMicroNok: 0,
        startedAt: leases.now().toISOString(),
      };
      await saveItem(actor, tenant, started, `Kjører ${document.title}`);
      let outcome: ServiceRunOutcome;
      let subject: Subject | undefined;
      try {
        subject = await published(tenant, first.service, first.version);
        outcome = await invokeItem(
          principal,
          tenant,
          subject,
          first.dataset,
          first.prompt,
          document,
          first.maxOutputTokens,
          first.input,
        );
      } catch (error) {
        outcome = { ok: false, status: 422, errors: [{ path: '', message: messageOf(error) }] };
      }
      const endedAt = leases.now().toISOString();
      if (!outcome.ok) {
        const { tokens, costMicroNok } = outcome.task
          ? await spentBy(outcome.task)
          : { tokens: { input: 0, output: 0 }, costMicroNok: 0 };
        spent.micro += costMicroNok;
        spent.tokens += tokens.input + tokens.output;
        quotaSpent += tokens.input + tokens.output;
        await saveItem(
          actor,
          tenant,
          {
            ...started,
            status: 'failed',
            ...(outcome.task ? { task: outcome.task } : {}),
            error: outcome.errors.map((e) => e.message).join('; '),
            ...(outcome.code ? { errorCode: outcome.code } : {}),
            tokens,
            costMicroNok,
            endedAt,
          },
          `Feilet: ${document.title}`,
        );
        return;
      }
      const tokens = { input: outcome.usage.inputTokens, output: outcome.usage.outputTokens };
      spent.micro += outcome.costMicroNok;
      spent.tokens += tokens.input + tokens.output;
      quotaSpent += tokens.input + tokens.output;
      observe({ tokens });
      const notFound = notFoundOf(outcome);
      await saveItem(
        actor,
        tenant,
        {
          ...started,
          status: notFound ? 'notFound' : 'succeeded',
          task: outcome.task,
          ...(subject ? { version: subject.version } : {}),
          output: outcome.answer,
          noAnswer: notFound,
          ...(first.maxOutputTokens !== undefined && tokens.output >= first.maxOutputTokens
            ? { truncated: true }
            : {}),
          sources: cleanSources(
            document,
            outcome.sources.map((s) => {
              const source = s as { title?: unknown; url?: unknown; document?: unknown };
              return {
                ...(typeof source.title === 'string' ? { title: source.title } : {}),
                ...(typeof source.url === 'string' ? { url: source.url } : {}),
                ...(typeof source.document === 'string' ? { document: source.document } : {}),
              };
            }),
            rule,
          ),
          models: outcome.usage.byModel.map((m) => m.model),
          tokens,
          costMicroNok: outcome.costMicroNok,
          endedAt,
        },
        `Ferdig: ${document.title}`,
      );
    };

    const done = (async () => {
      let stop: 'cancelled' | 'cap' | 'quota' | undefined;
      try {
        await lease.update((run) => ({ ...run, status: 'running' }), 'Kjører');
        const queue = [...indexes];
        const worker = async () => {
          for (;;) {
            if (stop || queue.length === 0) return;
            if (await cancelRequested()) {
              stop = 'cancelled';
              return;
            }
            const withinQuota = await quotaFits();
            if (!withinQuota || !fits()) {
              if (inflight === 0) {
                stop = withinQuota ? 'cap' : 'quota';
                return;
              }
              await released();
              continue;
            }
            const index = queue.shift();
            if (index === undefined) return;
            inflight += 1;
            try {
              await runItem(index);
            } finally {
              inflight -= 1;
              const wake = waiting;
              waiting = [];
              for (const resume of wake) resume();
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(first.concurrency, indexes.length) }, worker),
        );
        if (!stop && queue.length > 0) stop = 'cap';
        await lease.update(
          (run) => ({
            ...run,
            status:
              stop === 'cancelled'
                ? 'cancelled'
                : stop === 'cap' || stop === 'quota'
                  ? 'stopped'
                  : 'succeeded',
            endedAt: leases.now().toISOString(),
            ...(stop === 'cap' ? { error: capMessage(run.cap), errorCode: 'cap_reached' } : {}),
            ...(stop === 'quota' ? { error: quotaMessage, errorCode: 'quota_exhausted' } : {}),
          }),
          stop === 'cancelled'
            ? 'Avbrutt'
            : stop === 'cap'
              ? 'Stoppet ved kostnadstaket'
              : stop === 'quota'
                ? 'Stoppet ved månedskvoten'
                : 'Ferdig',
        );
      } catch (error) {
        await lease
          .update(
            (run) => ({
              ...run,
              status: 'failed',
              endedAt: leases.now().toISOString(),
              error: messageOf(error),
            }),
            'Feilet',
          )
          .catch(() => undefined);
      } finally {
        cancels.delete(key);
        lease.release();
      }
    })();
    return done;
  };

  const admit = async (tenant: string) => {
    if ((await deps.quota?.(tenant, { fresh: true }))?.exhausted)
      throw new BatchProblem(
        409,
        'Månedskvoten for tokens er brukt opp. Jobben kan starte igjen neste måned eller når kvoten økes.',
        'quota',
      );
  };

  const spentBy = async (task: string) => {
    const tokens = { input: 0, output: 0 };
    let costMicroNok = 0;
    for await (const event of deps.events(task)) {
      if (event.type !== 'kernel.usage' || !isRecord(event.data)) continue;
      const usage = isRecord(event.data.usage) ? event.data.usage : {};
      const model = isRecord(event.data.model) ? event.data.model.id : undefined;
      const used = {
        input: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
        output: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
      };
      tokens.input += used.input;
      tokens.output += used.output;
      costMicroNok += microOf(used, typeof model === 'string' ? deps.prices[model] : undefined);
    }
    return { tokens, costMicroNok };
  };

  const approvalLimitOf = (tenant: string) => {
    const value = (deps.settings.effective(tenant) as Record<string, { value?: unknown }>)[
      approvalLimitKey
    ]?.value;
    return typeof value === 'number' && value >= 0 ? value : defaultApprovalLimitNok;
  };

  const needsApproval = (estimate: Pick<BatchEstimate, 'costMicroNok'>, limitNok: number) =>
    limitNok > 0 && (estimate.costMicroNok?.high ?? 0) > limitNok * 1_000_000;

  const start = async (
    principal: Principal,
    tenant: string,
    service: string,
    body: {
      estimate: string;
      maxCostNok?: number;
      maxTokens?: number;
      concurrency?: number;
      approval?: string;
    },
    reason: string,
    gate: { approval?: boolean; startedByName?: string } = {},
  ) => {
    const found = await latestOf<BatchEstimate>(batchEstimateKind, tenant, body.estimate);
    const estimate = found?.spec;
    if (!estimate || estimate.service !== service)
      throw new BatchProblem(404, 'Fant ikke kostnadsberegningen', 'estimate');
    if (estimate.expiresAt < leases.now().toISOString())
      throw new BatchProblem(409, 'Kostnadsberegningen er for gammel. Beregn på nytt.', 'estimate');
    await assertRunnable(tenant, service);
    await published(tenant, service, estimate.version);
    const cap = capOf(estimate, body);
    await admit(tenant);
    const actor = actorOf(principal.actor ?? principal);
    const limitNok = approvalLimitOf(tenant);
    let approval: BatchApproval | undefined;
    if (gate.approval && needsApproval(estimate, limitNok)) {
      const why = body.approval?.trim() ?? '';
      if (why.length < minApprovalReason)
        throw new BatchProblem(
          409,
          `Anslaget er over grensen på ${limitNok.toLocaleString('nb-NO')} kr per jobb. Jobben må godkjennes med en begrunnelse på minst ${minApprovalReason} tegn.`,
          'approval',
        );
      approval = { by: actor, at: leases.now().toISOString(), reason: why, limitNok };
    }
    const run: BatchRun = {
      id: randomUUID(),
      service,
      version: estimate.version,
      model: estimate.model,
      priced: estimate.priced,
      dataset: estimate.dataset,
      filters: estimate.filters,
      ...(estimate.prompt ? { prompt: estimate.prompt } : {}),
      ...(estimate.input ? { input: estimate.input } : {}),
      estimate: estimate.id,
      startedBy: actor,
      ...(gate.startedByName ? { startedByName: gate.startedByName } : {}),
      ...(approval ? { costApproval: approval } : {}),
      status: 'queued',
      total: estimate.items,
      concurrency: Math.min(Math.max(body.concurrency ?? defaultConcurrency, 1), maxConcurrency),
      cap,
      perItem: estimate.perItem,
      maxOutputTokens: estimate.maxOutputTokens,
      pass: 1,
      startedAt: leases.now().toISOString(),
      endedAt: null,
      ...leases.stamp(),
    };
    await saveRun(
      actor,
      tenant,
      run,
      approval ? `${reason}. Godkjent over grensen: ${approval.reason}` : reason,
    );
    const done = execute(
      principal,
      tenant,
      run,
      estimate.documents,
      estimate.documents.map((_, i) => i),
      new Map(),
    );
    return { run, done };
  };

  const retry = async (
    principal: Principal,
    tenant: string,
    service: string,
    id: string,
    body: { maxCostNok?: number; maxTokens?: number; items?: number[] },
    reason: string,
  ) => {
    await assertRunnable(tenant, service);
    const run = await runOf(tenant, service, id);
    if (!run) throw new BatchProblem(404, 'Fant ikke kjøringen');
    if (active(run)) throw new BatchProblem(409, 'Kjøringen pågår fortsatt');
    const { items } = await detail(tenant, run);
    const wanted = body.items ? new Set(body.items) : undefined;
    const todo = items
      .filter(
        (i) =>
          (i.status === 'failed' || i.status === 'skipped') && (!wanted || wanted.has(i.index)),
      )
      .map((i) => i.index);
    if (todo.length === 0) throw new BatchProblem(409, 'Ingen feilede elementer å kjøre på nytt');
    await admit(tenant);
    const previous = new Map(items.filter((i) => i.attempts > 0).map((i) => [i.index, i]));
    const spent = { micro: 0, tokens: 0 };
    for (const item of previous.values()) {
      spent.micro += item.costMicroNok;
      spent.tokens += item.tokens.input + item.tokens.output;
    }
    const next: BatchRun = {
      ...run,
      status: 'queued',
      cap: capOf(run, body, spent),
      maxOutputTokens:
        run.maxOutputTokens ?? Math.max(run.perItem.outputTokens.high, minItemOutputTokens),
      pass: run.pass + 1,
      queue: todo,
      endedAt: null,
      ...leases.stamp(),
    };
    delete next.error;
    delete next.errorCode;
    await saveRun(actorOf(principal.actor ?? principal), tenant, next, reason);
    const marker = await latestOf<{ run: string }>(batchCancelKind, tenant, id);
    if (marker?.spec.run)
      await appendVersion(deps.configEntries, {
        kind: batchCancelKind,
        scope: tenant,
        id,
        spec: { run: '' },
        deleted: true,
        by: actorOf(principal.actor ?? principal),
        reason,
      });
    const documents = await documentsOf(tenant, run);
    const done = execute(principal, tenant, next, documents, todo, previous);
    return { run: next, retried: todo.length, done };
  };

  const cancel = async (
    principal: Principal,
    tenant: string,
    service: string,
    id: string,
    reason: string,
  ) => {
    const run = await runOf(tenant, service, id);
    if (!run) throw new BatchProblem(404, 'Fant ikke kjøringen');
    if (!active(run)) throw new BatchProblem(409, 'Kjøringen er allerede ferdig');
    await appendVersion(deps.configEntries, {
      kind: batchCancelKind,
      scope: tenant,
      id,
      spec: { run: id },
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
    });
    cancels.get(`${tenant}/${id}`)?.();
    return run;
  };

  return {
    leases,
    sources,
    estimate,
    approvalLimitOf,
    needsApproval,
    start,
    retry,
    cancel,
    runOf,
    runsOf,
    detail,
    totalsOf,
    itemsOf,
    recover,
  };
};

export type BatchRuns = ReturnType<typeof batchRuns>;
