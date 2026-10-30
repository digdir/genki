import {
  answerText,
  judgedExpectation,
  type CollectedScore,
  type Evaluator,
  type Observation,
  type PendingScore,
  type ReportedUsage,
  type Score,
  type TestCase,
} from '@genai/eval';
import { judgeTraceIdOf } from './sink.js';
import { traceIdFor } from './spans.js';

export interface LangfuseApiOptions {
  host: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
}

/** Where a judge's variable comes from, as the evaluation rule maps it. */
export interface JudgeMapping {
  variable: string;
  source: string;
  jsonPath?: string;
}

export type JudgeDataType = 'BOOLEAN' | 'NUMERIC' | 'CATEGORICAL';

/** Why genki cannot use a judge; message is for the API, reason and field for a screen. */
export interface JudgeRefusal {
  reason: 'not-a-model' | 'default-model' | 'sampled' | 'filtered' | 'unsent-field' | 'unread-path';
  field?: string;
  message: string;
}

/** An experiment rule of the connection's project, as it was when it was read. */
export interface LangfuseJudge {
  /** langfuse:<connection>/<rule name>: the evaluator, and its metric. */
  id: string;
  connection: string;
  rule: { id: string; name: string; mapping: JudgeMapping[] };
  evaluator: {
    id: string;
    name: string;
    version: number;
    dataType: JudgeDataType;
    model?: { provider: string; model: string };
  };
  refused?: JudgeRefusal;
}

/**
 * What genki sends of a case: the question, the answer and what the case expects, only when the
 * connection receives content, and the item's metadata (case, repeat, split) always.
 */
export const contentSources = ['input', 'output', 'expected_output'] as const;
export type ContentSource = (typeof contentSources)[number];
const sentSources = new Set<string>([...contentSources, 'experiment_item_metadata']);

/** The content fields the judges read, so a run sends no field that no judge maps (ADR 0040). */
export const mappedContent = (judges: Pick<LangfuseJudge, 'rule'>[]): ContentSource[] =>
  contentSources.filter((f) => judges.some((j) => j.rule.mapping.some((m) => m.source === f)));

interface RawRule {
  id: string;
  name: string;
  target?: string;
  status?: string;
  enabled?: boolean;
  sampling?: number;
  filter?: unknown[];
  mapping?: JudgeMapping[];
  evaluator?: { id: string; name: string };
}

interface RawEvaluator {
  id: string;
  name: string;
  version: number;
  type?: string;
  outputDefinition?: { dataType?: string };
  modelConfig?: { provider?: string; model?: string } | null;
}

interface RawScore {
  name: string;
  value: unknown;
  stringValue?: string;
  dataType?: string;
  comment?: string | null;
  configId?: string | null;
  timestamp?: string;
  metadata?: { job_configuration_id?: unknown; job_execution_id?: unknown };
}

interface RawObservation {
  type?: string;
  inputUsage?: number;
  outputUsage?: number;
  costDetails?: Record<string, number>;
}

const dataTypes = new Set<string>(['BOOLEAN', 'NUMERIC', 'CATEGORICAL']);

/** $ or a dotted path of plain keys: the paths genki can read to tell whether a field is empty. */
const pathKeys = (path: string | undefined) => {
  if (path === undefined || path === '$') return [];
  return /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path) ? path.slice(2).split('.') : undefined;
};

/** Input and output go as genki's parts, so only the whole of them is what a judge expects. */
const wholeOnly = new Set(['input', 'output']);

const refusalOf = (rule: RawRule, evaluator: RawEvaluator): JudgeRefusal | undefined => {
  if (evaluator.type !== undefined && evaluator.type !== 'llm_as_judge')
    return {
      reason: 'not-a-model',
      message: `${rule.name} is not an LLM-as-a-judge evaluator, so it has no model genki can name`,
    };
  if (!evaluator.modelConfig?.provider || !evaluator.modelConfig.model)
    return {
      reason: 'default-model',
      message: `${rule.name} uses the project's or organisation's default model, which cannot be read through Langfuse's API`,
    };
  // Langfuse judges only the items its sampling and filter let through; the rest would go missing.
  if (rule.sampling !== undefined && rule.sampling < 1)
    return {
      reason: 'sampled',
      message: `${rule.name} judges only part of the items it gets, so some cases would never be scored`,
    };
  if ((rule.filter ?? []).length > 0)
    return {
      reason: 'filtered',
      message: `${rule.name} judges only the items its filter lets through, so some cases would never be scored`,
    };
  for (const m of rule.mapping ?? []) {
    if (!sentSources.has(m.source))
      return {
        reason: 'unsent-field',
        field: m.source,
        message: `${rule.name} reads ${m.source}, which genki does not send`,
      };
    if (
      pathKeys(m.jsonPath) === undefined ||
      (wholeOnly.has(m.source) && (pathKeys(m.jsonPath)?.length ?? 0) > 0)
    )
      return {
        reason: 'unread-path',
        field: `${m.source} ${m.jsonPath}`,
        message: `${rule.name} reads ${m.source} at ${m.jsonPath}, a JSON path genki cannot read`,
      };
  }
  return undefined;
};

const modelText = (model: LangfuseJudge['evaluator']['model']) =>
  model ? `${model.provider}/${model.model}` : 'default';

/** What differs between the judge at the run's start and now; empty when nothing does. */
const changes = (
  before: LangfuseJudge,
  now: { judge: LangfuseJudge | undefined; active: boolean } | undefined,
): string[] => {
  if (!now?.judge) return ['the rule is gone'];
  if (!now.active) return ['the rule is no longer active'];
  return changesOf(before, now.judge);
};

const changesOf = (before: LangfuseJudge, now: LangfuseJudge): string[] => {
  const out: string[] = [];
  if (JSON.stringify(before.rule.mapping) !== JSON.stringify(now.rule.mapping))
    out.push("the rule's mapping");
  if (before.evaluator.id !== now.evaluator.id) out.push("the rule's evaluator");
  if (before.evaluator.version !== now.evaluator.version)
    out.push(`the evaluator's version ${before.evaluator.version} → ${now.evaluator.version}`);
  if (modelText(before.evaluator.model) !== modelText(now.evaluator.model))
    out.push(
      `the evaluator's model ${modelText(before.evaluator.model)} → ${modelText(now.evaluator.model)}`,
    );
  return out;
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (typeof value === 'object' && Object.keys(value).length === 0);

const at = (value: unknown, keys: string[]) =>
  keys.reduce<unknown>(
    (v, k) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined),
    value,
  );

const unanswered: Observation = { answer: '', retrieved: [], citations: [] };

/** The field a mapping reads, as genki would send it for this case. */
const fieldOf = (m: JudgeMapping, c: TestCase, o: Observation): unknown => {
  const keys = pathKeys(m.jsonPath) ?? [];
  if (m.source === 'input') return at(c.input, keys);
  if (m.source === 'output') return at(answerText(o), keys);
  if (m.source === 'expected_output') return at(judgedExpectation(c), keys);
  return 'metadata';
};

/** Langfuse's v3 score as a genki score: boolean 1 or 0, a number scaled by its config's bounds. */
const valueOf = (
  raw: RawScore,
  bounds: { minValue?: number; maxValue?: number } | undefined,
): { value: number } | { asItCame: unknown } => {
  if (raw.dataType === 'BOOLEAN')
    return { value: raw.value === true || raw.value === 1 || raw.value === 'true' ? 1 : 0 };
  if (
    raw.dataType === 'NUMERIC' &&
    typeof raw.value === 'number' &&
    typeof bounds?.minValue === 'number' &&
    typeof bounds.maxValue === 'number' &&
    bounds.maxValue > bounds.minValue
  )
    return {
      value: Math.min(
        1,
        Math.max(0, (raw.value - bounds.minValue) / (bounds.maxValue - bounds.minValue)),
      ),
    };
  return { asItCame: raw.stringValue ?? raw.value };
};

/**
 * Langfuse's evaluation rules and the scores its judges write, read through the connection's
 * keys (4.4.0's unstable evaluator API; ADR 0040).
 */
export const langfuseJudges = (api: LangfuseApiOptions) => {
  const send = api.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${api.publicKey}:${api.secretKey}`).toString('base64')}`;
  const read = async <T>(path: string, signal?: AbortSignal): Promise<T | undefined> => {
    const response = await send(new URL(path, api.host), {
      headers: { authorization },
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`Langfuse answered HTTP ${response.status} for ${path.split('?')[0]}`);
    return (await response.json()) as T;
  };

  const rules = async () => {
    const all: RawRule[] = [];
    for (let page = 1; ; page += 1) {
      const found = await read<{ data: RawRule[]; meta?: { totalPages?: number } }>(
        `/api/public/unstable/evaluation-rules?page=${page}&limit=50`,
      );
      all.push(...(found?.data ?? []));
      if (!found || page >= (found.meta?.totalPages ?? 1)) return all;
    }
  };

  const judgeOf = async (
    connection: string,
    rule: RawRule,
    evaluators: Map<string, Promise<RawEvaluator | undefined>>,
  ): Promise<LangfuseJudge | undefined> => {
    if (!rule.evaluator) return undefined;
    const id = rule.evaluator.id;
    if (!evaluators.has(id))
      evaluators.set(
        id,
        read<RawEvaluator>(`/api/public/unstable/evaluators/${encodeURIComponent(id)}`),
      );
    const evaluator = await evaluators.get(id);
    if (!evaluator) return undefined;
    const dataType = evaluator.outputDefinition?.dataType ?? '';
    const refused = refusalOf(rule, evaluator);
    const model = evaluator.modelConfig;
    return {
      id: `langfuse:${connection}/${rule.name}`,
      connection,
      rule: { id: rule.id, name: rule.name, mapping: rule.mapping ?? [] },
      evaluator: {
        id: evaluator.id,
        name: evaluator.name,
        version: evaluator.version,
        dataType: (dataTypes.has(dataType) ? dataType : 'CATEGORICAL') as JudgeDataType,
        ...(model?.provider && model.model
          ? { model: { provider: model.provider, model: model.model } }
          : {}),
      },
      ...(refused ? { refused } : {}),
    };
  };

  /** Each active experiment rule of the project, refused with a reason when genki cannot use it. */
  const list = async (connection: string): Promise<LangfuseJudge[]> => {
    const evaluators = new Map<string, Promise<RawEvaluator | undefined>>();
    const found = await Promise.all(
      (await rules())
        .filter((r) => r.target === 'experiment' && r.status === 'active' && r.enabled !== false)
        .map((r) => judgeOf(connection, r, evaluators)),
    );
    return found.filter((j): j is LangfuseJudge => j !== undefined);
  };

  /** The rule as it is now, read by id, so a rename does not hide a change. */
  const current = async (judge: LangfuseJudge, signal?: AbortSignal) => {
    const rule = await read<RawRule>(
      `/api/public/unstable/evaluation-rules/${encodeURIComponent(judge.rule.id)}`,
      signal,
    );
    return rule
      ? {
          judge: await judgeOf(judge.connection, rule, new Map()),
          active: rule.status === 'active' && rule.enabled !== false,
        }
      : undefined;
  };

  const scoresOn = async (trace: string, signal?: AbortSignal) => {
    const all: RawScore[] = [];
    let cursor: string | undefined;
    do {
      const found = await read<{ data: RawScore[]; meta?: { cursor?: string } }>(
        `/api/public/v3/scores?traceId=${encodeURIComponent(trace)}&fields=details&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
        signal,
      );
      all.push(...(found?.data ?? []));
      cursor = found && found.data.length > 0 ? found.meta?.cursor : undefined;
    } while (cursor);
    return all;
  };

  /**
   * A judge as a built-in evaluator of a run, from its snapshot at the run's start. Its scores
   * come from Langfuse later, so each case it applies to is pending until they are collected.
   */
  const evaluator = (
    judge: LangfuseJudge,
    run: { tenant: string; content: boolean },
  ): Evaluator => {
    const version = `v${judge.evaluator.version}+${modelText(judge.evaluator.model)}`;
    // What Langfuse reports the judge's own calls cost, read from each execution's trace once.
    const reported: ReportedUsage = { inputTokens: 0, outputTokens: 0, costUsd: null, unpriced: 0 };
    const counted = new Set<string>();
    const countCalls = async (execution: string, signal?: AbortSignal) => {
      if (counted.has(execution)) return;
      const found = await read<{ data: RawObservation[] }>(
        `/api/public/v2/observations?traceId=${judgeTraceIdOf(execution)}&fields=core,basic,usage,model&limit=100`,
        signal,
      );
      counted.add(execution);
      for (const o of found?.data ?? []) {
        if (o.type !== 'GENERATION') continue;
        reported.inputTokens += o.inputUsage ?? 0;
        reported.outputTokens += o.outputUsage ?? 0;
        const cost = o.costDetails?.total;
        if (typeof cost === 'number') reported.costUsd = (reported.costUsd ?? 0) + cost;
        else reported.unpriced += 1;
      }
    };
    const base = { evaluator: judge.id, version, metric: judge.id };
    const notApplicable = (reason: string): Score => ({
      ...base,
      value: null,
      applicable: false,
      state: 'not-applicable',
      reason,
    });
    return {
      id: judge.id,
      version,
      kind: 'model',
      judge: `langfuse:${run.tenant}/${judge.connection}/${judge.rule.name}@${version}`,
      reasonsOnTheCase: true,
      advisory: true,
      reportedUsage: () => ({ ...reported }),
      // Only the answer is unknown before the case runs; every other field the rule maps is not.
      canRead: (c) =>
        judge.rule.mapping.every(
          (m) => m.source === 'output' || !isEmpty(fieldOf(m, c, unanswered)),
        ),
      evaluate: async (c, o) => {
        if (c.split === 'holdout') return [notApplicable('holdout cases are never sent')];
        if (!run.content) return [notApplicable('the connection does not receive content')];
        const empty = judge.rule.mapping.find((m) => isEmpty(fieldOf(m, c, o)));
        if (empty)
          return [
            notApplicable(
              `the case has no ${empty.source}${empty.jsonPath && empty.jsonPath !== '$' ? ` ${empty.jsonPath}` : ''}`,
            ),
          ];
        return [{ ...base, value: null, applicable: true, state: 'pending' }];
      },
      collect: async (pending: PendingScore[], options) => {
        const signal = options?.signal;
        const changed = changes(judge, await current(judge, signal));
        const bounds = new Map<
          string,
          Promise<{ minValue?: number; maxValue?: number } | undefined>
        >();
        const boundsOf = (id: string) => {
          if (!bounds.has(id))
            bounds.set(id, read(`/api/public/score-configs/${encodeURIComponent(id)}`, signal));
          return bounds.get(id);
        };
        const collected: CollectedScore[] = [];
        for (const p of pending) {
          const ours = (await scoresOn(traceIdFor(p.task), signal))
            .filter((s) => s.metadata?.job_configuration_id === judge.rule.id)
            .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
          const raw = ours[0];
          if (!raw) continue;
          if (typeof raw.metadata?.job_execution_id === 'string')
            await countCalls(raw.metadata.job_execution_id, signal);
          const read = valueOf(raw, raw.configId ? await boundsOf(raw.configId) : undefined);
          const details = {
            ...(raw.dataType ? { dataType: raw.dataType } : {}),
            ...('asItCame' in read ? { asItCame: read.asItCame } : {}),
            ...(changed.length > 0 ? { judgeChanged: changed } : {}),
          };
          collected.push({
            case: p.case,
            repeat: p.repeat,
            score: {
              ...base,
              value: 'value' in read ? read.value : null,
              applicable: true,
              state: 'scored',
              ...(raw.comment ? { reason: raw.comment } : {}),
              ...(Object.keys(details).length > 0 ? { details } : {}),
            },
          });
        }
        return collected;
      },
    };
  };

  /** Langfuse 4.4.0 shows an experiment on its results page, with the experiment as baseline. */
  const experimentUrl = async (run: string) => {
    const project = (await read<{ data: { id: string }[] }>('/api/public/projects'))?.data[0]?.id;
    return project
      ? new URL(
          `/project/${encodeURIComponent(project)}/experiments/results?baseline=${encodeURIComponent(run)}`,
          api.host,
        ).toString()
      : undefined;
  };

  return { list, evaluator, experimentUrl };
};
