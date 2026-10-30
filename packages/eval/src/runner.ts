import { randomUUID } from 'node:crypto';
import type { Event, Input, Part, Principal } from '@genai/contracts';
import type { Kernel } from '@genai/kernel';
import {
  EvalError,
  type CollectedScore,
  type EvalContext,
  type Evaluator,
  type PendingScore,
} from './evaluators.js';
import { defaultObserve, type Observation, type Observe } from './observe.js';
import {
  sumUsage,
  type EvalRun,
  type MetricSummary,
  type Score,
  type Split,
  type TestCase,
  type TestSet,
  type UsageSummary,
} from './schema.js';
import {
  bootstrapMean,
  mean,
  pairedBootstrap,
  type BootstrapOptions,
  type PairedComparison,
} from './stats.js';

export interface TargetResult {
  task: string;
  parts: Part[];
  events: Event[];
  servedModels: string[];
  /** The served models that wrote the answer; judges are checked against these alone. */
  writers?: string[];
  service?: string;
}

export interface EvalItem {
  case: TestCase;
  repeat: number;
}

export interface EvalTarget {
  capability: string;
  invoke(input: Input, item?: EvalItem): Promise<TargetResult>;
  annotate?(task: string, score: Score): Promise<void>;
}

const searchingKinds = new Set(['embedder']);

const servedModelsOf = (events: Event[], writing = false) => [
  ...new Set(
    events.flatMap((e) => {
      const model = (e.data as { model?: { id?: unknown; kind?: unknown } } | undefined)?.model;
      if (e.type !== 'kernel.usage' || typeof model?.id !== 'string') return [];
      return writing && searchingKinds.has(String(model.kind)) ? [] : [model.id];
    }),
  ),
];

const collect = async (events: AsyncIterable<Event>) => {
  const all: Event[] = [];
  for await (const e of events) all.push(e);
  return all;
};

export const describeTask = async (
  kernel: Kernel,
  principal: Principal,
  task: string,
  parts: Part[],
): Promise<TargetResult> => {
  const events = await collect(await kernel.events(principal, task, { audience: 'audit' }));
  const { service } = await kernel.task(principal, task);
  return {
    task,
    parts,
    events,
    servedModels: servedModelsOf(events),
    writers: servedModelsOf(events, true),
    service: `${service.capability.id}@${service.capability.version}#${service.configHash}`,
  };
};

export const kernelTarget = (
  kernel: Kernel,
  principal: Principal,
  capability: string,
): EvalTarget => ({
  capability,
  invoke: async (input) => {
    const run = await kernel.invoke(principal, capability, input);
    const parts = await run.result;
    return describeTask(kernel, principal, run.task, parts);
  },
  annotate: (task, score) =>
    kernel.annotate(principal, task, { type: 'kernel.score', data: score }),
});

export interface WaitOptions {
  deadlineMs?: number;
  everyMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const scoreWaitMs = 5 * 60_000;

export interface RunEvalOptions {
  id?: string;
  target: EvalTarget;
  testSet: TestSet;
  evaluators: Evaluator[];
  provenance: { commit: string; data: string };
  repeats?: number;
  splits?: Split[];
  modelFamily?: (model: string) => string | undefined;
  observe?: Observe;
  bootstrap?: BootstrapOptions;
  wait?: WaitOptions;
  meterAnswers?: (events: Event[]) => UsageSummary;
  /** Cancels the run, including its wait for scores. */
  signal?: AbortSignal;
  /** After each case, with what the run has used so far when answers are metered. */
  onProgress?: (done: number, total: number, usage?: EvalRun['usage']) => void;
  onWaiting?: (pending: number, until: string) => void;
  now?: () => Date;
}

export const inputOf = (c: TestCase): Input =>
  typeof c.input === 'string'
    ? { parts: [{ mime: 'text/plain', body: { kind: 'text', text: c.input } }] }
    : (c.input as Input);

const summarize = (values: number[], options?: BootstrapOptions): MetricSummary => ({
  mean: mean(values),
  ci: bootstrapMean(values, options),
  n: values.length,
});

export const perCaseMeans = (
  run: Pick<EvalRun, 'results'>,
  metric: string,
  tag?: string,
  split?: Split,
) => {
  const byCase = new Map<string, number[]>();
  for (const r of run.results) {
    if (tag !== undefined && !r.tags.includes(tag)) continue;
    if (split !== undefined && r.split !== split) continue;
    for (const s of r.scores) {
      if (s.metric !== metric || !s.applicable || s.value === null) continue;
      byCase.set(r.case, [...(byCase.get(r.case) ?? []), s.value]);
    }
  }
  return new Map([...byCase].map(([c, v]) => [c, mean(v)]));
};

/** An advisory evaluator's scores stay on their cases but out of the run's metrics. */
const aggregate = (
  results: EvalRun['results'],
  bootstrap?: BootstrapOptions,
  advisory: Set<string> = new Set(),
) => {
  const metrics = [
    ...new Set(
      results.flatMap((r) =>
        r.scores.filter((s) => s.applicable && !advisory.has(s.evaluator)).map((s) => s.metric),
      ),
    ),
  ].sort();
  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  const table = (tag?: string) =>
    Object.fromEntries(
      metrics.flatMap((m) => {
        const values = [...perCaseMeans({ results }, m, tag).values()];
        return values.length === 0 ? [] : [[m, summarize(values, bootstrap)]];
      }),
    );
  return { metrics: table(), byTag: Object.fromEntries(tags.map((t) => [t, table(t)])) };
};

const unsettled = new Set<Score['state']>(['pending', 'failed', 'missing']);

/** Per result, not per metric: a judge that missed one of its metrics on a case missed the case. */
export const incompleteOf = (results: EvalRun['results']): EvalRun['incomplete'] => {
  const byEvaluator = new Map<
    string,
    { of: Set<string>; missing: Set<string>; failed: Set<string> }
  >();
  for (const r of results) {
    const key = `${r.case}#${r.repeat}`;
    for (const s of r.scores) {
      if (s.state === 'not-applicable') continue;
      const seen = byEvaluator.get(s.evaluator) ?? {
        of: new Set<string>(),
        missing: new Set<string>(),
        failed: new Set<string>(),
      };
      seen.of.add(key);
      if (s.state === 'missing' || s.state === 'pending') seen.missing.add(key);
      if (s.state === 'failed') seen.failed.add(key);
      byEvaluator.set(s.evaluator, seen);
    }
  }
  return [...byEvaluator]
    .filter(([, seen]) => seen.missing.size + seen.failed.size > 0)
    .map(([evaluator, seen]) => ({
      evaluator,
      missing: seen.missing.size,
      failed: seen.failed.size,
      of: seen.of.size,
      reason: [
        ...(seen.missing.size > 0
          ? [`no score from ${evaluator} for ${seen.missing.size} of ${seen.of.size} cases`]
          : []),
        ...(seen.failed.size > 0
          ? [`${evaluator} failed on ${seen.failed.size} of ${seen.of.size} cases`]
          : []),
      ].join('; '),
    }));
};

/** Counted per result, as for incompleteOf; a not-applicable score is no gap. */
export const unscoredIn = (run: Pick<EvalRun, 'results'>, metric: string, split: Split) => {
  let of = 0;
  let missing = 0;
  for (const r of run.results) {
    if (r.split !== split) continue;
    const scores = r.scores.filter((s) => s.metric === metric && s.state !== 'not-applicable');
    if (scores.length === 0) continue;
    of += 1;
    if (scores.some((s) => unsettled.has(s.state))) missing += 1;
  }
  return { of, missing };
};

const pauseFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The score as the run keeps it: without a judge's reason, which stays only on the case's task. */
const keptInRun = (evaluator: Evaluator | undefined, score: Score): Score => {
  if (!evaluator?.reasonsOnTheCase || score.state !== 'scored' || score.reason === undefined)
    return score;
  const kept = { ...score };
  delete kept.reason;
  return kept;
};

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${ms === 60_000 ? '' : 's'}`;

const collectPending = async (
  results: EvalRun['results'],
  evaluators: Evaluator[],
  options: {
    lastSent: Date;
    wait: WaitOptions;
    now: () => Date;
    annotate: (task: string, score: Score) => Promise<void>;
    onWaiting?: (pending: number, until: string) => void;
    signal?: AbortSignal;
  },
) => {
  const pendingNow = (): PendingScore[] =>
    results.flatMap((r) =>
      r.scores
        .filter((s) => s.state === 'pending')
        .map((score) => ({ case: r.case, repeat: r.repeat, task: r.task, score })),
    );
  let pending = pendingNow();
  if (pending.length === 0) return;
  const deadlineMs = options.wait.deadlineMs ?? scoreWaitMs;
  const everyMs = options.wait.everyMs ?? 5_000;
  const sleep = options.wait.sleep ?? pauseFor;
  const deadline = options.lastSent.getTime() + deadlineMs;
  const until = new Date(deadline).toISOString();
  const byId = new Map(evaluators.map((e) => [e.id, e]));
  const lastError = new Map<string, string>();
  let reported = 0;
  const report = () => {
    if (pending.length === 0 || pending.length === reported) return;
    reported = pending.length;
    options.onWaiting?.(pending.length, until);
  };

  const settle = async (collected: CollectedScore) => {
    if (collected.score.state === 'pending') return;
    const result = results.find((r) => r.case === collected.case && r.repeat === collected.repeat);
    const at = result?.scores.findIndex(
      (s) =>
        s.state === 'pending' &&
        s.evaluator === collected.score.evaluator &&
        s.metric === collected.score.metric,
    );
    if (!result || at === undefined || at < 0) return;
    result.scores[at] = keptInRun(byId.get(collected.score.evaluator), collected.score);
    await options.annotate(result.task, collected.score);
  };

  const left = () => deadline - options.now().getTime();
  report();
  while (pending.length > 0 && left() > 0) {
    await sleep(Math.min(everyMs, left()), options.signal);
    options.signal?.throwIfAborted();
    const byEvaluator = Map.groupBy(pending, (p) => p.score.evaluator);
    for (const [id, items] of byEvaluator) {
      if (left() <= 0) break;
      const expiry = AbortSignal.timeout(left());
      const signal = options.signal ? AbortSignal.any([options.signal, expiry]) : expiry;
      let collected: CollectedScore[];
      try {
        collected = (await byId.get(id)?.collect?.(items, { signal })) ?? [];
      } catch (error) {
        options.signal?.throwIfAborted();
        lastError.set(id, error instanceof Error ? error.message : String(error));
        continue;
      }
      options.signal?.throwIfAborted();
      // What arrives after the deadline is not taken, so a run never outlasts its wait.
      if (left() <= 0) break;
      for (const c of collected) await settle(c);
    }
    pending = pendingNow();
    report();
  }

  for (const item of pending) {
    const { evaluator, version, metric } = item.score;
    const error = lastError.get(evaluator);
    await settle({
      case: item.case,
      repeat: item.repeat,
      score: {
        evaluator,
        version,
        metric,
        value: null,
        applicable: true,
        state: 'missing',
        reason: `no score within ${minutes(deadlineMs)} of the last case${error ? ` (last error: ${error})` : ''}`,
      },
    });
  }
};

export const runEval = async (options: RunEvalOptions): Promise<EvalRun> => {
  const { target, testSet, evaluators, provenance } = options;
  const repeats = options.repeats ?? 1;
  const chosen = options.splits ?? ['train', 'validation'];
  const now = options.now ?? (() => new Date());
  const observe = options.observe ?? defaultObserve;
  if (!provenance.commit.trim())
    throw new EvalError('an eval run needs the commit it was taken on');
  if (!provenance.data.trim())
    throw new EvalError('an eval run needs the data version it was taken on');
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new EvalError('repeats must be a positive integer');
  if (evaluators.length === 0) throw new EvalError('an eval run needs at least one evaluator');
  const cases = testSet.spec.cases.filter((c) => chosen.includes(c.split));
  if (cases.length === 0)
    throw new EvalError(`test set ${testSet.metadata.id} has no cases in ${chosen.join(', ')}`);

  const startedAt = now().toISOString();
  const results: EvalRun['results'] = [];
  const servedModels = new Set<string>();
  const services = new Set<string>();
  const total = cases.length * repeats;
  const answered: UsageSummary[] = [];
  const annotate = (task: string, score: Score) =>
    target.annotate ? target.annotate(task, score) : Promise.resolve();
  const usageSoFar = (): EvalRun['usage'] => {
    if (!options.meterAnswers) return undefined;
    const judged = evaluators.flatMap((e) => (e.usage ? [e.usage()] : []));
    // A sink's judges share what they report, so one key may come from several evaluators.
    const reported = Object.fromEntries(
      evaluators
        .flatMap((e) => Object.entries(e.reportedUsage?.() ?? {}))
        .filter(([, r]) => r.inputTokens + r.outputTokens > 0 || r.unpriced + r.unread > 0),
    );
    return {
      answers: sumUsage(answered),
      ...(judged.length > 0 ? { judges: sumUsage(judged) } : {}),
      ...(Object.keys(reported).length > 0 ? { reported } : {}),
    };
  };
  let lastSent = now();
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const c of cases) {
      options.signal?.throwIfAborted();
      let outcome: TargetResult;
      try {
        outcome = await target.invoke(inputOf(c), { case: c, repeat });
      } catch (error) {
        throw new EvalError(
          `case ${c.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // A case may reach no model, as when a guardrail refuses before it; the run must reach one.
      outcome.servedModels.forEach((m) => servedModels.add(m));
      if (outcome.service) services.add(outcome.service);
      if (options.meterAnswers) answered.push(options.meterAnswers(outcome.events));
      const observation: Observation = observe(outcome.parts, outcome.events);
      const ctx: EvalContext = {
        ...(options.id ? { run: options.id } : {}),
        task: outcome.task,
        servedModels: outcome.writers ?? outcome.servedModels,
        modelFamily: options.modelFamily ?? (() => undefined),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const scores: Score[] = [];
      lastSent = now();
      for (const evaluator of evaluators) {
        options.signal?.throwIfAborted();
        let answered: Score[];
        try {
          answered = await evaluator.evaluate(c, observation, ctx);
        } catch (error) {
          throw new EvalError(
            `evaluator ${evaluator.id} failed on case ${c.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!evaluator.collect && answered.some((s) => s.state === 'pending'))
          throw new EvalError(
            `evaluator ${evaluator.id} answered pending on case ${c.id} but cannot be collected`,
          );
        scores.push(...answered);
      }
      for (const s of scores) if (s.state !== 'pending') await annotate(outcome.task, s);
      const byId = new Map(evaluators.map((e) => [e.id, e]));
      const kept = scores.map((s) => keptInRun(byId.get(s.evaluator), s));
      results.push({
        case: c.id,
        split: c.split,
        repeat,
        task: outcome.task,
        tags: c.tags,
        ...(c.language ? { language: c.language } : {}),
        scores: kept,
      });
      options.onProgress?.(results.length, total, usageSoFar());
    }
  }
  if (servedModels.size === 0) throw new EvalError('the run recorded no served model');
  await collectPending(results, evaluators, {
    lastSent,
    wait: options.wait ?? {},
    now,
    annotate,
    ...(options.onWaiting ? { onWaiting: options.onWaiting } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // What a sink reports may still arrive after its scores; a failed read never fails the run.
  for (const e of evaluators)
    await e.settle?.(options.signal ? { signal: options.signal } : {}).catch(() => undefined);

  return {
    id: options.id ?? randomUUID(),
    testSet: {
      tenant: testSet.metadata.tenant,
      id: testSet.metadata.id,
      version: testSet.metadata.version,
    },
    capability: target.capability,
    splits: chosen,
    repeats,
    startedAt,
    endedAt: now().toISOString(),
    provenance: {
      commit: provenance.commit,
      data: provenance.data,
      servedModels: [...servedModels].sort(),
      judges: [...new Set(evaluators.flatMap((e) => (e.judge ? [e.judge] : [])))].sort(),
      services: [...services].sort(),
    },
    results,
    ...aggregate(
      results,
      options.bootstrap,
      new Set(evaluators.filter((e) => e.advisory).map((e) => e.id)),
    ),
    incomplete: incompleteOf(results),
    status: 'completed',
    ...(options.meterAnswers ? { usage: usageSoFar() } : {}),
  };
};

export type ComparableField = 'commit' | 'data' | 'servedModels' | 'judges' | 'services';

export interface CompareOptions extends BootstrapOptions {
  tag?: string;
  split?: Split;
  allowDifferent?: ComparableField[];
  /** Judges whose scores never gate, such as a sink's: two runs are compared without them. */
  advisoryJudge?: (judge: string) => boolean;
}

export const compareRuns = (
  baseline: EvalRun,
  candidate: EvalRun,
  metric: string,
  options: CompareOptions = {},
): PairedComparison => {
  if (
    baseline.testSet.id !== candidate.testSet.id ||
    baseline.testSet.version !== candidate.testSet.version
  )
    throw new EvalError('runs on different test sets or versions cannot be compared');
  const allowed = new Set(options.allowDifferent ?? []);
  const advisory = options.advisoryJudge ?? (() => false);
  const compared = (run: EvalRun, field: ComparableField) =>
    field === 'judges' ? run.provenance.judges.filter((j) => !advisory(j)) : run.provenance[field];
  for (const field of ['commit', 'data', 'servedModels', 'judges', 'services'] as const) {
    if (allowed.has(field)) continue;
    if (JSON.stringify(compared(baseline, field)) !== JSON.stringify(compared(candidate, field)))
      throw new EvalError(
        `runs differ in ${field}; only like is compared with like unless that difference is the point`,
      );
  }
  const a = perCaseMeans(baseline, metric, options.tag, options.split);
  const b = perCaseMeans(candidate, metric, options.tag, options.split);
  const shared = [...a.keys()].filter((k) => b.has(k)).sort();
  if (shared.length === 0) throw new EvalError(`no cases scored on ${metric} in both runs`);
  return pairedBootstrap(
    shared.map((k) => a.get(k) as number),
    shared.map((k) => b.get(k) as number),
    options,
  );
};
