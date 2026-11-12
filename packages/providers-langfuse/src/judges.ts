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
  reason:
    | 'not-a-model'
    | 'default-model'
    | 'sampled'
    | 'filtered'
    | 'unsent-field'
    | 'unread-path'
    | 'several-evaluators'
    /** Another judge in the project has the rule's name, so the two cannot be told apart. */
    | 'same-name'
    /** Langfuse does not run it: no screen lists it, and a run that uses it is refused. */
    | 'paused';
  field?: string;
  message: string;
}

/** An experiment judge of the connection's project, as it was when it was read. */
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

interface RawFilter {
  column?: string;
  operator?: string;
  value?: unknown;
}

/** An evaluation rule as Langfuse 4.72.0's v2 API has it: every rule is an observation rule. */
interface RawRule {
  id: string;
  name: string;
  enabled?: boolean;
  sampling?: number;
  filter?: RawFilter[];
  evaluatorAssignments?: { evaluatorId: string; variableMapping?: JudgeMapping[] | null }[];
}

interface RawEvaluator {
  id: string;
  name: string;
  version: number;
  type?: string;
  status?: string;
  pausedMessage?: string | null;
  variableMapping?: JudgeMapping[] | null;
  outputDefinition?: { dataType?: string };
  modelConfig?: { provider?: string; model?: string } | null;
}

/** The filter that makes a rule judge each experiment item once, on its root span. */
const isItemRoot = (f: RawFilter) =>
  f.column === 'isExperimentItemRootSpan' && f.operator === '=' && f.value === true;

const isActive = (e: RawEvaluator | undefined) => e !== undefined && e.status !== 'paused';

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

const refusalOf = (
  rule: RawRule,
  evaluators: (RawEvaluator | undefined)[],
  mapping: JudgeMapping[],
): JudgeRefusal | undefined => {
  const evaluator = evaluators[0] as RawEvaluator;
  // Langfuse runs a rule while any one of its evaluators is active, and nothing when all are paused.
  if (evaluators.every((e) => e?.status === 'paused'))
    return {
      reason: 'paused',
      message:
        evaluator.pausedMessage ??
        `${rule.name}'s evaluator ${evaluator.name} is paused in Langfuse`,
    };
  if (evaluators.length > 1)
    return {
      reason: 'several-evaluators',
      message: `${rule.name} runs more than one evaluator; genki reads a rule with one`,
    };
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
  if ((rule.filter ?? []).some((f) => !isItemRoot(f)))
    return {
      reason: 'filtered',
      message: `${rule.name} judges only the items its filter lets through, so some cases would never be scored`,
    };
  for (const m of mapping) {
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
  if (now.judge.refused?.reason === 'paused') return ["the rule's evaluator is paused"];
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
 * keys (4.72.0's v2 evaluation API; ADR 0040).
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

  /** Every page of a v2 listing; one that cannot be read throws, never reads as empty. */
  const all = async <T>(path: string): Promise<T[]> => {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const found = await read<{ data: T[]; meta?: { cursor?: string } }>(
        `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (!found) throw new Error(`Langfuse answered HTTP 404 for ${path}`);
      if (!Array.isArray(found.data)) throw new Error(`Langfuse answered no list for ${path}`);
      out.push(...found.data);
      cursor = found.data.length > 0 ? found.meta?.cursor : undefined;
    } while (cursor);
    return out;
  };

  /** The project's enabled rules, each with its evaluators as the listing has them. */
  const project = async () => {
    const [rules, evaluators] = await Promise.all([
      all<RawRule>('/api/public/v2/evaluation-rules'),
      all<RawEvaluator>('/api/public/v2/evaluators'),
    ]);
    const byId = new Map(evaluators.map((e) => [e.id, e]));
    return rules
      .filter((r) => r.enabled !== false)
      .map((rule) => ({
        rule,
        evaluators: (rule.evaluatorAssignments ?? []).map((a) => byId.get(a.evaluatorId)),
      }));
  };

  /** A rule that judges each experiment item once: one of genki's judges, refused or not. */
  const isJudge = (rule: RawRule) => (rule.filter ?? []).some(isItemRoot);

  const judgeOf = (
    connection: string,
    rule: RawRule,
    evaluators: (RawEvaluator | undefined)[],
  ): LangfuseJudge | undefined => {
    const assigned = rule.evaluatorAssignments?.[0];
    const evaluator = evaluators[0];
    if (!assigned || !evaluator) return undefined;
    const mapping = assigned.variableMapping ?? evaluator.variableMapping ?? [];
    const dataType = evaluator.outputDefinition?.dataType ?? '';
    const refused = refusalOf(rule, evaluators, mapping);
    const model = evaluator.modelConfig;
    return {
      id: `langfuse:${connection}/${rule.name}`,
      connection,
      rule: { id: rule.id, name: rule.name, mapping },
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

  /**
   * Each enabled rule of the project with the item-root filter, refused with a reason when genki
   * cannot use it: one whose evaluator is paused is refused as paused, since Langfuse does not run it.
   */
  const list = async (connection: string): Promise<LangfuseJudge[]> => {
    const judges = (await project())
      .filter(({ rule }) => isJudge(rule))
      .map(({ rule, evaluators }) => judgeOf(connection, rule, evaluators))
      .filter((j): j is LangfuseJudge => j !== undefined);
    // A judge is known by its rule's name, which Langfuse does not keep unique.
    const named = new Map<string, number>();
    for (const j of judges) named.set(j.rule.name, (named.get(j.rule.name) ?? 0) + 1);
    return judges.map((j) =>
      (named.get(j.rule.name) ?? 0) > 1 && j.refused?.reason !== 'paused'
        ? {
            ...j,
            refused: {
              reason: 'same-name',
              message: `${j.rule.name} is the name of more than one rule in the project, so genki cannot tell them apart`,
            },
          }
        : j,
    );
  };

  /**
   * The project's other enabled rules that Langfuse runs on what genki sends but genki cannot
   * read: one without the item-root filter and an active evaluator, which judges every span, and
   * one whose evaluator the listing does not have, which genki cannot tell is paused.
   */
  const others = async (): Promise<string[]> =>
    (await project())
      .filter(({ rule, evaluators }) =>
        isJudge(rule)
          ? evaluators[0] === undefined
          : evaluators.some((e) => e === undefined || isActive(e)),
      )
      .map(({ rule }) => rule.name);

  /**
   * Each score name two or more enabled rules write: their evaluators' name, which Langfuse does
   * not keep unique either.
   */
  const shared = async (): Promise<{ name: string; rules: string[] }[]> => {
    const byName = new Map<string, string[]>();
    for (const { rule, evaluators } of await project())
      for (const e of new Set(evaluators.map((x) => x?.name))) {
        if (e === undefined) continue;
        byName.set(e, [...(byName.get(e) ?? []), rule.name]);
      }
    return [...byName]
      .filter(([, rules]) => rules.length > 1)
      .map(([name, rules]) => ({ name, rules }));
  };

  /** The rule as it is now, read by id, so a rename does not hide a change. */
  const current = async (judge: LangfuseJudge, signal?: AbortSignal) => {
    const rule = await read<RawRule>(
      `/api/public/v2/evaluation-rules/${encodeURIComponent(judge.rule.id)}`,
      signal,
    );
    if (!rule) return undefined;
    const evaluators = await Promise.all(
      (rule.evaluatorAssignments ?? []).map((a) =>
        read<RawEvaluator>(
          `/api/public/v2/evaluators/${encodeURIComponent(a.evaluatorId)}`,
          signal,
        ),
      ),
    );
    return {
      judge: judgeOf(judge.connection, rule, evaluators),
      active: rule.enabled !== false && isJudge(rule),
    };
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
   * What Langfuse reports the judge calls on a run's cases cost, shared by the run's judges so each
   * call counts once: per judge the run uses, and under the connection for the project's others.
   * A call whose cost cannot be read yet is read again on the next pass, never at a score's expense.
   */
  const ledger = {
    connection: '',
    judges: new Map<string, string>(),
    byRule: new Map<string, ReportedUsage>(),
    counted: new Set<string>(),
    unread: new Map<string, string>(),
    /** Every active judge in the project at the run's start: each judges every case sent. */
    expected: new Set<string>(),
    /** The case tasks sent, and per case the judges whose score never came. */
    sent: new Set<string>(),
    missing: new Map<string, string>(),
    settled: false,
    async read(execution: string, rule: string, signal?: AbortSignal) {
      let calls: RawObservation[];
      try {
        const found = await read<{ data: RawObservation[] }>(
          `/api/public/v2/observations?traceId=${judgeTraceIdOf(execution)}&fields=core,basic,usage,model&limit=100`,
          signal,
        );
        calls = (found?.data ?? []).filter((o) => o.type === 'GENERATION');
      } catch {
        calls = [];
      }
      if (calls.length === 0) {
        this.unread.set(execution, rule);
        return;
      }
      this.unread.delete(execution);
      this.counted.add(execution);
      const used = this.byRule.get(rule) ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        unpriced: 0,
        unread: 0,
      };
      for (const o of calls) {
        used.inputTokens += o.inputUsage ?? 0;
        used.outputTokens += o.outputUsage ?? 0;
        const cost = o.costDetails?.total;
        if (typeof cost === 'number') used.costUsd = (used.costUsd ?? 0) + cost;
        else used.unpriced += 1;
      }
      this.byRule.set(rule, used);
    },
    async count(scores: RawScore[], signal?: AbortSignal) {
      for (const s of scores) {
        const execution = s.metadata?.job_execution_id;
        const rule = s.metadata?.job_configuration_id;
        if (typeof execution !== 'string' || typeof rule !== 'string') continue;
        if (this.counted.has(execution) || this.unread.has(execution)) continue;
        await this.read(execution, rule, signal);
      }
    },
    async retry(signal?: AbortSignal) {
      for (const [execution, rule] of [...this.unread]) await this.read(execution, rule, signal);
    },
    /** A last read of every case sent: a judge that scored late is counted, one that never did is unread. */
    async settle(signal?: AbortSignal) {
      if (this.settled) return;
      this.settled = true;
      await this.retry(signal);
      const judging = new Set([...this.expected, ...this.judges.keys()]);
      for (const task of this.sent) {
        const scores = await scoresOn(traceIdFor(task), signal).catch(() => undefined);
        if (!scores) {
          for (const rule of judging) this.missing.set(`${task}|${rule}`, rule);
          continue;
        }
        await this.count(scores, signal);
        const scored = new Set(scores.map((s) => s.metadata?.job_configuration_id));
        for (const rule of judging)
          if (!scored.has(rule)) this.missing.set(`${task}|${rule}`, rule);
      }
    },
    usage(): Record<string, ReportedUsage> {
      const out: Record<string, ReportedUsage> = {};
      const add = (key: string, used: ReportedUsage) => {
        const sum = out[key] ?? {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          unpriced: 0,
          unread: 0,
        };
        out[key] = {
          inputTokens: sum.inputTokens + used.inputTokens,
          outputTokens: sum.outputTokens + used.outputTokens,
          costUsd:
            sum.costUsd === null && used.costUsd === null
              ? null
              : (sum.costUsd ?? 0) + (used.costUsd ?? 0),
          unpriced: sum.unpriced + used.unpriced,
          unread: sum.unread + used.unread,
        };
      };
      const keyOf = (rule: string) => this.judges.get(rule) ?? `langfuse:${this.connection}`;
      for (const [rule, used] of this.byRule) add(keyOf(rule), used);
      for (const rule of [...this.unread.values(), ...this.missing.values()])
        add(keyOf(rule), {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          unpriced: 0,
          unread: 1,
        });
      return out;
    },
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
    ledger.judges.set(judge.rule.id, judge.id);
    ledger.connection = judge.connection;
    // Only the answer is unknown before the case runs; every other field the rule maps is not.
    const readable = (c: TestCase) =>
      judge.rule.mapping.every((m) => m.source === 'output' || !isEmpty(fieldOf(m, c, unanswered)));
    const base = { evaluator: judge.id, version, metric: judge.id };
    // Every score says the judge's type, and the name Langfuse gives its scores (the
    // evaluator's), so a label can be matched to it before it scores.
    const named = { dataType: judge.evaluator.dataType, scoreName: judge.evaluator.name };
    const typed = { details: named };
    const notApplicable = (reason: string): Score => ({
      ...base,
      ...typed,
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
      reportedUsage: () => ledger.usage(),
      settle: (options) => ledger.settle(options?.signal),
      canRead: readable,
      evaluate: async (c, o, ctx) => {
        // The case went to Langfuse if any of the run's judges can read it, and is judged by all.
        if (c.split !== 'holdout' && run.content && ctx.task && readable(c))
          ledger.sent.add(ctx.task);
        if (c.split === 'holdout') return [notApplicable('holdout cases are never sent')];
        if (!run.content) return [notApplicable('the connection does not receive content')];
        const empty = judge.rule.mapping.find((m) => isEmpty(fieldOf(m, c, o)));
        if (empty) {
          const reason = `the case has no ${empty.source}${empty.jsonPath && empty.jsonPath !== '$' ? ` ${empty.jsonPath}` : ''}`;
          // An empty answer still goes out, so a person can label the case in Langfuse.
          return [
            ctx.task && ledger.sent.has(ctx.task)
              ? {
                  ...notApplicable(reason),
                  details: { ...named, sent: true },
                }
              : notApplicable(reason),
          ];
        }
        return [{ ...base, ...typed, value: null, applicable: true, state: 'pending' }];
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
        await ledger.retry(signal);
        for (const p of pending) {
          const scores = await scoresOn(traceIdFor(p.task), signal);
          const ours = scores
            .filter((s) => s.metadata?.job_configuration_id === judge.rule.id)
            .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
          const raw = ours[0];
          if (!raw) continue;
          // Every judge in the project judged the case, and each call is billed: count them all.
          await ledger.count(scores, signal);
          const read = valueOf(raw, raw.configId ? await boundsOf(raw.configId) : undefined);
          const details = {
            dataType: raw.dataType ?? judge.evaluator.dataType,
            scoreName: judge.evaluator.name,
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

  /** The project's active experiment judges at the run's start: each judges every case sent. */
  const expectJudges = (rules: string[]) => {
    ledger.expected = new Set(rules);
  };

  /**
   * Every label people made in the project's UI: ANNOTATION scores whose score config has the
   * score's own name and type, read as good or bad (a number scaled by the config's bounds and split
   * at 0.5), or the category as it came. The Langfuse user id comes along for a pseudonym.
   */
  const annotations = async (): Promise<LangfuseAnnotation[]> => {
    // A page that cannot be read is an error, never "no labels": that would undo accepted ones.
    const need = async <T>(path: string): Promise<T> => {
      const found = await read<T>(path);
      if (found === undefined)
        throw new Error(`Langfuse answered HTTP 404 for ${path.split('?')[0]}`);
      return found;
    };
    const all: RawAnnotation[] = [];
    let cursor: string | undefined;
    do {
      const found = await need<{ data: RawAnnotation[]; meta?: { cursor?: string } }>(
        `/api/public/v3/scores?source=ANNOTATION&fields=core,details,subject,annotation&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      all.push(...found.data);
      cursor = found.data.length > 0 ? found.meta?.cursor : undefined;
    } while (cursor);
    const configs = new Map<string, Promise<RawScoreConfig>>();
    const configOf = (id: string) => {
      if (!configs.has(id))
        configs.set(
          id,
          need<RawScoreConfig>(`/api/public/score-configs/${encodeURIComponent(id)}`),
        );
      return configs.get(id) as Promise<RawScoreConfig>;
    };
    const out: LangfuseAnnotation[] = [];
    for (const a of all) {
      const trace =
        a.subject?.traceId ?? (a.subject?.kind === 'trace' ? a.subject.id : undefined) ?? a.traceId;
      if (!trace) continue;
      // Every annotation still in Langfuse comes back, a label or not, so none is taken for deleted.
      const config = a.configId ? await configOf(a.configId) : undefined;
      const label =
        config && a.dataType && config.name === a.name && config.dataType === a.dataType
          ? labelOf(a, config)
          : undefined;
      out.push({
        id: a.id,
        // Langfuse changes updatedAt on every edit.
        revision: a.updatedAt ?? a.timestamp ?? '',
        trace,
        name: a.name,
        dataType: a.dataType ?? '',
        ...(label === undefined ? {} : { label }),
        ...(config &&
        typeof config.minValue === 'number' &&
        typeof config.maxValue === 'number' &&
        config.maxValue > config.minValue
          ? { bounds: { min: config.minValue, max: config.maxValue } }
          : {}),
        ...(a.authorUserId ? { author: a.authorUserId } : {}),
      });
    }
    return out;
  };

  return { list, others, shared, evaluator, experimentUrl, expectJudges, annotations };
};

/** A person's annotation in Langfuse, read for genki's calibration labels (ADR 0040). */
export interface LangfuseAnnotation {
  id: string;
  /** Changes when the annotation is edited. */
  revision: string;
  trace: string;
  name: string;
  dataType: string;
  /** Absent when it is no label: no score config of its name and type, or a number without range. */
  label?: string;
  /** The score config's range, which splits a number the judge gave without one. */
  bounds?: { min: number; max: number };
  author?: string;
}

interface RawAnnotation {
  id: string;
  name: string;
  value: unknown;
  stringValue?: string;
  dataType?: string;
  configId?: string | null;
  authorUserId?: string | null;
  traceId?: string | null;
  timestamp?: string;
  updatedAt?: string;
  subject?: { kind?: string; id?: string; traceId?: string };
}

interface RawScoreConfig {
  name: string;
  dataType: string;
  minValue?: number | null;
  maxValue?: number | null;
}

/** good or bad for a boolean, or a number within its config's bounds; a category as it came. */
const labelOf = (a: RawAnnotation, config: RawScoreConfig): string | undefined => {
  if (a.dataType === 'BOOLEAN') {
    if (a.value === true || a.value === 1) return 'good';
    if (a.value === false || a.value === 0) return 'bad';
    return undefined;
  }
  if (a.dataType === 'NUMERIC') {
    if (typeof a.value !== 'number') return undefined;
    const { minValue: min, maxValue: max } = config;
    if (typeof min === 'number' && typeof max === 'number' && max > min)
      return (a.value - min) / (max - min) >= 0.5 ? 'good' : 'bad';
    // A number without a range cannot be split into good and bad: it is no label.
    return undefined;
  }
  const category = a.stringValue ?? (typeof a.value === 'string' ? a.value : undefined);
  return category === undefined || category === '' ? undefined : category;
};
