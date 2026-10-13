import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { send } from './http.js';
import { mcp } from './scenarios/mcp.js';
import { toolName } from './scope.js';
import { meanWithCi, type Judge } from './sweep.js';
import type { JsonValue, Target } from './types.js';

export interface SourceRef {
  chunkId?: string;
  document?: string;
  position?: number;
}

export interface QualityCase {
  id: string;
  question: string;
  tags: string[];
  grounding?: string;
  reference: string | null;
  answerPattern: string | null;
  sources: SourceRef[];
}

export interface TestSetFile {
  source: string;
  status: string;
  cases: QualityCase[];
}

export interface RetrievedChunk {
  chunkId: string;
  document?: string;
  position?: number;
}

export interface ToolRun {
  ms: number;
  status: number;
  isError: boolean;
  error?: string;
  text: string;
  chunks: RetrievedChunk[];
  links: string[];
  insufficient: boolean;
  attribution?: Record<string, JsonValue>;
  servedModel?: string;
  task?: string;
}

export interface StageHit {
  chunkId: string;
  document?: string;
  position?: number;
}

export interface StageAttribution {
  pool: StageHit[];
  displayed: StageHit[];
  read: StageHit[];
}

export interface GoldenStages {
  inPool: boolean;
  displayed: boolean;
  read: boolean;
}

export type Kind = 'retrieval' | 'answer';

export interface RunRecord {
  kind: Kind;
  caseId: string;
  target: string;
  repeat: number;
  run: ToolRun;
  judgement?: { score: number; reasons?: string; error?: string };
  stages?: GoldenStages | { error: string };
}

export type ToolCaller = (
  target: Target,
  tool: string,
  question: string,
  args?: Record<string, JsonValue>,
) => Promise<ToolRun>;

export type Attributor = (target: Target, run: ToolRun) => Promise<StageAttribution | undefined>;

const record = (v: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;

const str = (v: JsonValue | undefined) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

export const toolArguments = (
  question: string,
  args: Record<string, JsonValue> = {
    tenant: 'public-sector-knowledge',
    dataset_config_key: 'default',
  },
) => ({ ...args, query: question });

const servedModelOf = (meta: Record<string, JsonValue> | undefined) => {
  const execution = record(meta?.execution_metadata);
  return str(meta?.model) ?? str(meta?.served_model) ?? str(execution?.model);
};

export const parseToolRun = (
  status: number,
  body: JsonValue | undefined,
  ms: number,
  task?: string,
): ToolRun => {
  const root = record(body);
  const result = record(root?.result);
  const rpcError = record(root?.error);
  const content = Array.isArray(result?.content) ? result.content : [];
  const structured = record(result?.structuredContent);
  const meta = record(result?._meta);
  const chunks = (Array.isArray(structured?.chunks) ? structured.chunks : []).flatMap((c) => {
    const chunk = record(c);
    const chunkId = str(chunk?.chunk_id);
    if (!chunkId) return [];
    const document = str(chunk?.doc_num);
    const position = chunk?.chunk_index;
    return [
      {
        chunkId,
        ...(document ? { document } : {}),
        ...(typeof position === 'number' ? { position } : {}),
      },
    ];
  });
  const text = content
    .map((c) => record(c))
    .filter((c) => c?.type === 'text')
    .map((c) => str(c?.text) ?? '')
    .join('\n');
  const links = content
    .map((c) => record(c))
    .filter((c) => c?.type === 'resource_link')
    .flatMap((c) => (str(c?.uri) ? [str(c?.uri) as string] : []));
  const isError = Boolean(rpcError) || result?.isError === true || status !== 200;
  const attribution = record(structured?.search_attribution);
  const servedModel = servedModelOf(meta);
  return {
    ms,
    status,
    isError,
    ...(rpcError ? { error: str(rpcError.message) ?? 'rpc error' } : {}),
    ...(isError && !rpcError ? { error: text.slice(0, 200) || `HTTP ${status}` } : {}),
    text,
    chunks,
    links,
    insufficient: meta?.insufficient === true,
    ...(attribution ? { attribution } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(task ? { task } : {}),
  };
};

export const mcpToolCaller: ToolCaller = async (target, tool, question, args) => {
  const started = Date.now();
  try {
    const response = await send(
      target,
      mcp('tools/call', { name: tool, arguments: toolArguments(question, args) }, { name: tool }),
    );
    return parseToolRun(
      response.status,
      response.body as JsonValue | undefined,
      Date.now() - started,
      response.headers['genai-task'],
    );
  } catch (error) {
    return {
      ms: Date.now() - started,
      status: 0,
      isError: true,
      error: error instanceof Error ? error.message : String(error),
      text: '',
      chunks: [],
      links: [],
      insufficient: false,
    };
  }
};

export const matchesSource = (chunk: RetrievedChunk, source: SourceRef) =>
  (source.chunkId !== undefined && chunk.chunkId === source.chunkId) ||
  (source.document !== undefined &&
    source.position !== undefined &&
    chunk.document === source.document &&
    chunk.position === source.position);

export const recallAt = (chunks: RetrievedChunk[], sources: SourceRef[], k: number) => {
  if (sources.length === 0) return undefined;
  const top = chunks.slice(0, k);
  return sources.filter((s) => top.some((c) => matchesSource(c, s))).length / sources.length;
};

export const goldenStages = (attribution: StageAttribution, sources: SourceRef[]): GoldenStages => {
  const hit = (hits: StageHit[]) => sources.some((s) => hits.some((h) => matchesSource(h, s)));
  return {
    inPool: hit(attribution.pool),
    displayed: hit(attribution.displayed),
    read: hit(attribution.read),
  };
};

export const citesDocument = (chunks: RetrievedChunk[], sources: SourceRef[]) => {
  if (sources.length === 0) return undefined;
  return sources.some((s) =>
    chunks.some((c) => s.document !== undefined && c.document === s.document),
  )
    ? 1
    : 0;
};

export const overlap = (a: string[], b: string[], k: number) => {
  const left = new Set(a.slice(0, k));
  const right = b.slice(0, k);
  const size = Math.min(left.size, right.length);
  if (size === 0) return undefined;
  return right.filter((id) => left.has(id)).length / size;
};

export const jaccard = (a: string[], b: string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  return [...left].filter((x) => right.has(x)).length / union.size;
};

export const meanPairwise = (lists: string[][], measure: (a: string[], b: string[]) => number) => {
  const values: number[] = [];
  for (let i = 0; i < lists.length; i += 1)
    for (let j = i + 1; j < lists.length; j += 1)
      values.push(measure(lists[i] as string[], lists[j] as string[]));
  return values.length ? values.reduce((x, y) => x + y, 0) / values.length : undefined;
};

export const patternMatches = (pattern: string | null, text: string) => {
  if (!pattern) return undefined;
  const insensitive = pattern.startsWith('(?i)');
  const body = insensitive ? pattern.slice(4) : pattern;
  return new RegExp(body, insensitive ? 'iu' : 'u').test(text) ? 1 : 0;
};

const refusalWords =
  /(dekker ikke|finner (ingen|ikke)|har ikke (funnet|informasjon|tilgang)|kunne ikke finne|kan ikke (svare|finne)|ingen (informasjon|opplysninger)|ikke (nevnt|omtalt|oppgitt)|foreligger ikke|not (covered|available))/iu;

export const refuses = (run: ToolRun) => run.insufficient || refusalWords.test(run.text);

const mean = (xs: (number | undefined)[]) => {
  const values = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
};

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export interface SystemRetrieval {
  target: string;
  runs: number;
  errors: number;
  recallAt10: number | undefined;
  recallAt20: number | undefined;
  meanChunks: number | undefined;
  stability: number | undefined;
  latencyMs: { p50: number | undefined; p90: number | undefined };
}

export interface RetrievalSummary {
  systems: [SystemRetrieval, SystemRetrieval];
  overlapAt10: number | undefined;
  overlapAt10Ci: [number, number] | undefined;
  recallDifference: { mean: number; ci: [number, number]; n: number } | undefined;
  perCase: {
    id: string;
    recall: [number | undefined, number | undefined];
    overlap: number | undefined;
    stability: [number | undefined, number | undefined];
  }[];
}

const runsFor = (records: RunRecord[], kind: Kind, caseId: string, target: string) =>
  records
    .filter((r) => r.kind === kind && r.caseId === caseId && r.target === target)
    .sort((a, b) => a.repeat - b.repeat);

export const summarizeRetrieval = (
  cases: QualityCase[],
  records: RunRecord[],
  targets: [string, string],
): RetrievalSummary => {
  const perCase = cases.map((c) => {
    const [a, b] = targets.map((t) =>
      runsFor(records, 'retrieval', c.id, t).filter((r) => !r.run.isError),
    );
    const ids = (rs: RunRecord[] | undefined) =>
      (rs ?? []).map((r) => r.run.chunks.map((x) => x.chunkId));
    const recall = (rs: RunRecord[] | undefined) =>
      mean((rs ?? []).map((r) => recallAt(r.run.chunks, c.sources, 10)));
    const pairs = Math.min(a?.length ?? 0, b?.length ?? 0);
    const overlaps = Array.from({ length: pairs }, (_, i) =>
      overlap(ids(a)[i] as string[], ids(b)[i] as string[], 10),
    );
    return {
      id: c.id,
      recall: [recall(a), recall(b)] as [number | undefined, number | undefined],
      overlap: mean(overlaps),
      stability: [meanPairwise(ids(a), jaccard), meanPairwise(ids(b), jaccard)] as [
        number | undefined,
        number | undefined,
      ],
    };
  });
  const system = (target: string, index: 0 | 1): SystemRetrieval => {
    const all = records.filter((r) => r.kind === 'retrieval' && r.target === target);
    const ok = all.filter((r) => !r.run.isError);
    const byCase = new Map(cases.map((c) => [c.id, c]));
    return {
      target,
      runs: all.length,
      errors: all.length - ok.length,
      recallAt10: mean(perCase.map((p) => p.recall[index])),
      recallAt20: mean(
        ok.map((r) => recallAt(r.run.chunks, byCase.get(r.caseId)?.sources ?? [], 20)),
      ),
      meanChunks: mean(ok.map((r) => r.run.chunks.length)),
      stability: mean(perCase.map((p) => p.stability[index])),
      latencyMs: {
        p50: percentile(
          ok.map((r) => r.run.ms),
          50,
        ),
        p90: percentile(
          ok.map((r) => r.run.ms),
          90,
        ),
      },
    };
  };
  const overlaps = perCase.flatMap((p) => (p.overlap === undefined ? [] : [p.overlap]));
  const diffs = perCase.flatMap((p) =>
    p.recall[0] === undefined || p.recall[1] === undefined ? [] : [p.recall[1] - p.recall[0]],
  );
  const overlapStats = overlaps.length ? meanWithCi(overlaps) : undefined;
  const diffStats = diffs.length ? meanWithCi(diffs) : undefined;
  return {
    systems: [system(targets[0], 0), system(targets[1], 1)],
    overlapAt10: overlapStats?.mean,
    overlapAt10Ci: overlapStats?.ci,
    recallDifference: diffStats ? { ...diffStats, n: diffs.length } : undefined,
    perCase,
  };
};

export interface SystemAnswers {
  target: string;
  runs: number;
  errors: number;
  judgeErrors: number;
  score: { mean: number; ci: [number, number] } | undefined;
  patternMatch: number | undefined;
  refusalOnNotCovered: number | undefined;
  falseRefusal: number | undefined;
  citesExpectedDocument: number | undefined;
  citesAnything: number | undefined;
  stages: {
    runs: number;
    inPool: number | undefined;
    displayed: number | undefined;
    read: number | undefined;
  };
  latencyMs: { p50: number | undefined; p90: number | undefined };
}

export interface AnswerSummary {
  systems: [SystemAnswers, SystemAnswers];
  paired: { meanDifference: number; ci: [number, number]; n: number } | undefined;
  byTag: { tag: string; n: number; scores: [number | undefined, number | undefined] }[];
  perCase: { id: string; scores: [number | undefined, number | undefined] }[];
}

const stageRates = (runs: RunRecord[]) => {
  const attributed = runs.flatMap((r) => (r.stages && !('error' in r.stages) ? [r.stages] : []));
  const rate = (key: keyof GoldenStages) => mean(attributed.map((s) => (s[key] ? 1 : 0)));
  return {
    runs: attributed.length,
    inPool: rate('inPool'),
    displayed: rate('displayed'),
    read: rate('read'),
  };
};

export interface ServedModels {
  target: string;
  models: string[];
  source: 'reported' | 'declared' | 'unknown';
}

export const servedModels = (
  records: RunRecord[],
  targets: [string, string],
  declared: Record<string, string | undefined> = {},
): { systems: [ServedModels, ServedModels]; problems: string[] } => {
  const problems: string[] = [];
  const system = (target: string): ServedModels => {
    const answers = records.filter(
      (r) => r.kind === 'answer' && r.target === target && !r.run.isError,
    );
    const reported = [
      ...new Set(answers.flatMap((r) => (r.run.servedModel ? [r.run.servedModel] : []))),
    ].sort();
    const silent = answers.filter((r) => !r.run.servedModel).length;
    if (reported.length > 0) {
      if (silent > 0)
        problems.push(`${target} did not report its served model on ${silent} answers`);
      if (reported.length > 1)
        problems.push(`${target} answered with several models: ${reported.join(', ')}`);
      return { target, models: reported, source: 'reported' };
    }
    const named = declared[target];
    if (named) {
      problems.push(
        `${target} does not report its served model; ${named} is declared by the operator`,
      );
      return { target, models: [named], source: 'declared' };
    }
    if (answers.length > 0) problems.push(`the served model of ${target} is unknown`);
    return { target, models: [], source: 'unknown' };
  };
  const systems: [ServedModels, ServedModels] = [system(targets[0]), system(targets[1])];
  const [a, b] = systems;
  if (
    a.models.length > 0 &&
    b.models.length > 0 &&
    JSON.stringify(a.models) !== JSON.stringify(b.models)
  )
    problems.push(`served models differ: ${a.models.join(', ')} vs ${b.models.join(', ')}`);
  return { systems, problems };
};

const isNotCovered = (c: QualityCase) =>
  c.tags.includes('not-covered') || c.grounding === 'refusal-expected';

export const summarizeAnswers = (
  cases: QualityCase[],
  records: RunRecord[],
  targets: [string, string],
): AnswerSummary => {
  const caseScore = (c: QualityCase, target: string) =>
    mean(
      runsFor(records, 'answer', c.id, target)
        .filter((r) => !r.run.isError)
        .map((r) => r.judgement?.score),
    );
  const perCase = cases.map((c) => ({
    id: c.id,
    scores: [caseScore(c, targets[0]), caseScore(c, targets[1])] as [
      number | undefined,
      number | undefined,
    ],
  }));
  const system = (target: string, index: 0 | 1): SystemAnswers => {
    const all = records.filter((r) => r.kind === 'answer' && r.target === target);
    const ok = all.filter((r) => !r.run.isError);
    const byCase = new Map(cases.map((c) => [c.id, c]));
    const scores = perCase.flatMap((p) =>
      p.scores[index] === undefined ? [] : [p.scores[index] as number],
    );
    const notCovered = ok.filter((r) => isNotCovered(byCase.get(r.caseId) as QualityCase));
    const covered = ok.filter((r) => !isNotCovered(byCase.get(r.caseId) as QualityCase));
    return {
      target,
      runs: all.length,
      errors: all.length - ok.length,
      judgeErrors: ok.filter((r) => r.judgement?.error !== undefined || r.judgement === undefined)
        .length,
      score: scores.length ? meanWithCi(scores) : undefined,
      patternMatch: mean(
        covered.map((r) => patternMatches(byCase.get(r.caseId)?.answerPattern ?? null, r.run.text)),
      ),
      refusalOnNotCovered: mean(notCovered.map((r) => (refuses(r.run) ? 1 : 0))),
      falseRefusal: mean(covered.map((r) => (refuses(r.run) ? 1 : 0))),
      citesExpectedDocument: mean(
        covered.map((r) => citesDocument(r.run.chunks, byCase.get(r.caseId)?.sources ?? [])),
      ),
      citesAnything: mean(
        covered.map((r) => (r.run.chunks.length > 0 || r.run.links.length > 0 ? 1 : 0)),
      ),
      stages: stageRates(covered),
      latencyMs: {
        p50: percentile(
          ok.map((r) => r.run.ms),
          50,
        ),
        p90: percentile(
          ok.map((r) => r.run.ms),
          90,
        ),
      },
    };
  };
  const diffs = perCase.flatMap((p) =>
    p.scores[0] === undefined || p.scores[1] === undefined ? [] : [p.scores[1] - p.scores[0]],
  );
  const tags = [
    ...new Set(cases.flatMap((c) => c.tags.filter((t) => !/^(year|org)-/.test(t)))),
  ].sort();
  const byTag = tags.map((tag) => {
    const ids = new Set(cases.filter((c) => c.tags.includes(tag)).map((c) => c.id));
    const rows = perCase.filter((p) => ids.has(p.id));
    return {
      tag,
      n: ids.size,
      scores: [mean(rows.map((r) => r.scores[0])), mean(rows.map((r) => r.scores[1]))] as [
        number | undefined,
        number | undefined,
      ],
    };
  });
  const diffStats = diffs.length ? meanWithCi(diffs) : undefined;
  return {
    systems: [system(targets[0], 0), system(targets[1], 1)],
    paired: diffStats
      ? { meanDifference: diffStats.mean, ci: diffStats.ci, n: diffs.length }
      : undefined,
    byTag,
    perCase,
  };
};

export const loadRecords = async (file: string): Promise<RunRecord[]> => {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunRecord);
};

const key = (r: Pick<RunRecord, 'kind' | 'caseId' | 'target' | 'repeat'>) =>
  `${r.kind}|${r.caseId}|${r.target}|${r.repeat}`;

export const pool = async <T>(items: T[], size: number, work: (item: T) => Promise<void>) => {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
};

export interface QualityOptions {
  cases: QualityCase[];
  targets: [Target, Target];
  kinds: Kind[];
  repeats: number;
  concurrency: number;
  file: string;
  call?: ToolCaller;
  tools?: Record<string, { agent: string; probe: string; arguments: Record<string, JsonValue> }>;
  attribute?: Attributor;
  judge?: Judge;
  maxErrorRate?: number;
  onProgress?: (done: number, total: number, errors: number) => void;
}

export class TooManyErrors extends Error {}

export const runQuality = async (options: QualityOptions): Promise<RunRecord[]> => {
  const call = options.call ?? mcpToolCaller;
  await mkdir(dirname(options.file), { recursive: true });
  const existing = await loadRecords(options.file);
  const done = new Set(existing.map(key));
  const jobs = options.kinds.flatMap((kind) =>
    options.cases.flatMap((c) =>
      options.targets.flatMap((target) =>
        Array.from({ length: options.repeats }, (_, repeat) => ({ kind, c, target, repeat })),
      ),
    ),
  );
  const pending = jobs.filter(
    (j) =>
      !done.has(key({ kind: j.kind, caseId: j.c.id, target: j.target.name, repeat: j.repeat })),
  );
  const fresh: RunRecord[] = [];
  let errors = 0;
  let finished = 0;
  const maxRate = options.maxErrorRate ?? 0.1;
  let stopped = false;
  await pool(pending, options.concurrency, async (job) => {
    if (stopped) return;
    const tools = options.tools?.[job.target.name];
    const side = job.target.name === 'new' ? 'new' : 'old';
    const tool =
      job.kind === 'retrieval'
        ? (tools?.probe ?? toolName('probe', side))
        : (tools?.agent ?? toolName('agent', side));
    const run = await call(job.target, tool, job.c.question, tools?.arguments);
    let stages: RunRecord['stages'];
    if (job.kind === 'answer' && !run.isError && options.attribute && job.c.sources.length > 0) {
      try {
        const attribution = await options.attribute(job.target, run);
        if (attribution) stages = goldenStages(attribution, job.c.sources);
      } catch (error) {
        stages = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    let judgement: RunRecord['judgement'];
    if (job.kind === 'answer' && !run.isError && options.judge) {
      try {
        judgement = await options.judge.score(
          {
            id: job.c.id,
            question: job.c.question,
            ...(job.c.reference ? { reference: job.c.reference } : {}),
          },
          { text: run.text, citations: run.links },
        );
      } catch (error) {
        judgement = {
          score: Number.NaN,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const entry: RunRecord = {
      kind: job.kind,
      caseId: job.c.id,
      target: job.target.name,
      repeat: job.repeat,
      run,
      ...(judgement ? { judgement } : {}),
      ...(stages ? { stages } : {}),
    };
    fresh.push(entry);
    await appendFile(options.file, `${JSON.stringify(entry)}\n`);
    finished += 1;
    if (run.isError) errors += 1;
    options.onProgress?.(finished, pending.length, errors);
    if (finished >= 20 && errors / finished > maxRate) stopped = true;
  });
  if (stopped)
    throw new TooManyErrors(
      `stopped after ${finished} calls: ${errors} errors exceed ${maxRate * 100}%`,
    );
  return [...existing, ...fresh];
};
