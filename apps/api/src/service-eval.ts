import { randomUUID } from 'node:crypto';
import { adoptionKind, blockKey } from '@genai/composition';
import type { Part, Principal } from '@genai/contracts';
import { validateDefinition } from '@genai/definitions';
import { residencies, residencyAllows, type Residency } from '@genai/port-model';
import {
  answerText,
  bootstrapMean,
  caseTypeOf,
  caseView,
  criteriaJudgeId,
  defaultObserve,
  evalRun,
  gradeAnswer,
  mean,
  perCaseMeans,
  runState,
  splitsFor,
  sumUsage,
  type CaseSplit,
  type CaseType,
  type EvalRun,
  type Score,
  type StoredRun,
  type TestCase,
  type TestSet,
} from '@genai/eval';
import {
  backgroundLeases,
  restartMessage,
  type BackgroundLeases,
  type LeaseOptions,
} from './background-lease.js';
import { definitionSubject } from './definition-subject.js';
import {
  connectionsCovering,
  deliveryGate,
  type SinkJudge,
  type TraceConnection,
} from './trace-connections.js';
import type { DraftModelUsage } from './draft-runner.js';
import { modelChoice, type Meter } from './model-choice.js';
import type { ModuleDeps } from './platform-modules.js';
import { serviceDrafts } from './service-drafts.js';

export const judgedModels = (byModel: DraftModelUsage[]) =>
  byModel.filter((m) => m.kind !== 'embedder').map((m) => m.model);

export { serviceDraftKind, type ServiceDraft } from './service-drafts.js';

export type RunVersion = 'draft' | number;

/** A sink judge's verdict on one case, with its reason while the case's task keeps it. */
export interface CaseJudgement {
  judge: string;
  state: Score['state'];
  value: number | null;
  dataType?: string;
  asItCame?: unknown;
  reason?: string;
}

export interface CaseResult {
  caseId: string;
  input: string;
  expected: string;
  type: CaseType;
  split: CaseSplit;
  output: string;
  pass: boolean;
  reason?: string;
  judges?: CaseJudgement[];
}

/** Whether an evaluator is a sink's judge: advisory, shown apart from the platform's metrics. */
export type IsSinkJudge = (evaluator: string) => boolean;
const noSinkJudge: IsSinkJudge = () => false;

/** Each sink judge of a run: its score, what it could not judge, and whether it changed. */
export const sinkJudgesOf = (run: EvalRun, isSinkJudge: IsSinkJudge) =>
  [...new Set(run.results.flatMap((r) => r.scores.map((s) => s.evaluator)).filter(isSinkJudge))]
    .sort()
    .map((id) => {
      const scores = run.results.flatMap((r) => r.scores.filter((s) => s.evaluator === id));
      const applicable = scores.filter((s) => s.state !== 'not-applicable');
      const gap = run.incomplete.find((i) => i.evaluator === id);
      const changed = [
        ...new Set(
          scores.flatMap((s) =>
            Array.isArray(s.details?.judgeChanged) ? (s.details.judgeChanged as string[]) : [],
          ),
        ),
      ];
      const categories: Record<string, number> = {};
      for (const s of scores)
        if (s.state === 'scored' && s.value === null && s.details?.asItCame !== undefined) {
          const key = String(s.details.asItCame);
          categories[key] = (categories[key] ?? 0) + 1;
        }
      // Advisory scores stay out of the run's metrics, so the judge's own summary is made here.
      const values = [...perCaseMeans(run, id).values()];
      const metric =
        values.length > 0
          ? { mean: mean(values), ci: bootstrapMean(values), n: values.length }
          : undefined;
      const dataType = scores.find((s) => typeof s.details?.dataType === 'string')?.details
        ?.dataType as string | undefined;
      return {
        id,
        name: id.slice(id.indexOf('/') + 1),
        version: scores[0]?.version ?? '',
        ...(dataType ? { dataType } : {}),
        ...(metric ? { metric } : {}),
        ...(Object.keys(categories).length > 0 ? { categories } : {}),
        notApplicable: scores.length - applicable.length,
        missing: gap?.missing ?? applicable.filter((s) => s.state === 'pending').length,
        failed: gap?.failed ?? 0,
        of: applicable.length,
        changed,
      };
    });

/** The draft or version cannot be run, for the reasons the draft runner gives. */
export class RunRefused extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super(errors.map((e) => e.message).join('; '));
    this.name = 'RunRefused';
  }
}

/** Sending a run's traces is refused: no connection covers the service, or residency forbids it. */
export class TraceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceRefused';
  }
}

const residencyOf = (definition: Record<string, unknown>): Residency => {
  const residency = (
    isRecord(definition.spec) && isRecord(definition.spec.model)
      ? definition.spec.model.residency
      : undefined
  ) as unknown;
  return residencies.includes(residency as Residency) ? (residency as Residency) : 'global';
};

export interface Subject {
  definition: Record<string, unknown>;
  files: Record<string, string>;
  version: RunVersion;
  variant?: string;
}

export interface Outcome {
  results: CaseResult[];
  passed: number;
  total: number;
  score: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const casesIn = (set: TestSet, split?: CaseSplit) =>
  split ? set.spec.cases.filter((c) => splitsFor(split).includes(c.split)) : set.spec.cases;

export const summarize = (results: CaseResult[]): Outcome => {
  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    passed,
    total: results.length,
    score: results.length ? passed / results.length : null,
  };
};

/** In this order: a criteria case that must also refuse is still decided by its criteria. */
const verdictMetrics = ['judge.criteria', 'exact-text', 'refusal'];

/** A case passes on its case type's own metric: the criteria judge, the exact text or the refusal. */
const verdictOf = (scores: Score[]) =>
  verdictMetrics
    .map((m) => scores.find((s) => s.metric === m && s.state !== 'not-applicable'))
    .find((s) => s !== undefined);

const passes = (scores: Score[]) => {
  const verdict = verdictOf(scores);
  return verdict?.state === 'scored' && verdict.value === 1;
};

/** A case's answer as the portal shows it: its text, or a structured answer's fields as JSON. */
export const answerOfParts = (parts: unknown) =>
  Array.isArray(parts) ? answerText(defaultObserve(parts as Part[], [])) : '';

/** A test run as the portal lists it, read from the eval run. */
export const runSummary = (run: EvalRun, isSinkJudge: IsSinkJudge = noSinkJudge) => {
  const state = runState(run);
  // Every case counts, as the case list shows it: one without a verdict did not pass.
  const counted = run.results;
  const passed = counted.filter((r) => passes(r.scores)).length;
  const used = [run.usage?.answers, run.usage?.judges].filter((u) => u !== undefined);
  const usage = used.length > 0 ? sumUsage(used) : undefined;
  return {
    id: run.id,
    status: state,
    testSet: run.testSet.id,
    testSetVersion: run.testSet.version,
    version: run.tested?.version ?? 'draft',
    ...(run.tested?.variant ? { variant: run.tested.variant } : {}),
    ...(run.tested?.split ? { split: run.tested.split } : {}),
    startedAt: run.startedAt,
    endedAt: state === 'running' || state === 'waiting-for-scores' ? null : run.endedAt,
    score: state === 'completed' && counted.length > 0 ? passed / counted.length : null,
    passed,
    total: state === 'completed' ? counted.length : (run.progress?.total ?? 0),
    ...(run.progress ? { progress: run.progress } : {}),
    metrics: run.metrics,
    incomplete: run.incomplete,
    judges: run.provenance.judges,
    cost: usage ? usage.costMicroNok : null,
    tokens: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 },
    ...(run.error ? { error: run.error } : {}),
    sinkJudges: sinkJudgesOf(run, isSinkJudge),
    ...(run.tested?.experiment ? { experiment: run.tested.experiment } : {}),
  };
};

/** One test run with each case as a person reads it: what it asked, answered and why it passed. */
export const runDetail = (
  run: EvalRun,
  set: TestSet | undefined,
  answers: Map<string, string>,
  sink: { isSinkJudge: IsSinkJudge; reasons?: Map<string, Map<string, string>> } = {
    isSinkJudge: noSinkJudge,
  },
) => ({
  ...runSummary(run, sink.isSinkJudge),
  byTag: run.byTag,
  cases: run.results.map((r): CaseResult => {
    const found = set?.spec.cases.find((c) => c.id === r.case);
    const view = found ? caseView(found) : undefined;
    const reason = verdictOf(r.scores)?.reason;
    const said = sink.reasons?.get(`${r.case}#${r.repeat}`);
    const judges = r.scores
      .filter((s) => sink.isSinkJudge(s.evaluator))
      .map((s): CaseJudgement => {
        const why = s.reason ?? said?.get(s.evaluator);
        return {
          judge: s.evaluator,
          state: s.state,
          value: s.value,
          ...(typeof s.details?.dataType === 'string' ? { dataType: s.details.dataType } : {}),
          ...(s.details?.asItCame !== undefined ? { asItCame: s.details.asItCame } : {}),
          ...(why ? { reason: why } : {}),
        };
      });
    return {
      caseId: r.case,
      input: view?.input ?? '',
      expected: view?.expected ?? '',
      type: view?.type ?? 'criteria',
      split: view?.split ?? 'open',
      output: answers.get(`${r.case}#${r.repeat}`) ?? '',
      pass: passes(r.scores),
      ...(reason ? { reason } : {}),
      ...(judges.length > 0 ? { judges } : {}),
    };
  }),
});

/**
 * A run left running by an instance that stopped is interrupted, ended at its last heartbeat. Any
 * reader can tell, since a live run's heartbeat is never older than the lease allows.
 */
export const interruptedIfAbandoned = (
  tenant: string,
  run: EvalRun,
  leases: Pick<BackgroundLeases, 'abandoned'>,
): EvalRun => {
  const state = runState(run);
  if (state !== 'running' && state !== 'waiting-for-scores') return run;
  if (!leases.abandoned(`${tenant}/${run.id}`, run, run.startedAt)) return run;
  return {
    ...run,
    status: 'interrupted',
    endedAt: run.heartbeatAt ?? run.startedAt,
    error: restartMessage,
  };
};

/** A run as a reader sees it: never its lease, and what it used only with view-usage. */
export const shownRun = (run: EvalRun, usage: boolean): EvalRun => {
  const shown = { ...run };
  delete shown.owner;
  delete shown.heartbeatAt;
  if (!usage) delete shown.usage;
  return shown;
};

const finished = (run: EvalRun) => {
  const state = runState(run);
  return state !== 'running' && state !== 'waiting-for-scores';
};

/** Progress from the eval task; a run that has finished keeps what it finished with. */
export const progressed = (
  run: EvalRun,
  progress: { done: number; total: number },
  usage?: EvalRun['usage'],
): EvalRun => (finished(run) ? run : { ...run, progress, ...(usage ? { usage } : {}) });

export const waitingForScores = (run: EvalRun): EvalRun =>
  finished(run) ? run : { ...run, status: 'waiting-for-scores' };

const modelsOf = (definition: Record<string, unknown>) => {
  const model = (isRecord(definition.spec) ? definition.spec.model : undefined) as
    { primary?: unknown; fallback?: unknown } | undefined;
  return [model?.primary, model?.fallback].filter((m): m is string => typeof m === 'string');
};

export const serviceEval = (deps: ModuleDeps, leaseOptions: LeaseOptions = {}) => {
  const choice = modelChoice(deps);
  const leases = backgroundLeases(leaseOptions);

  const drafts = serviceDrafts(deps.configEntries, deps.definitions);
  const draftOf = drafts.draftOf;
  const saveDraft = drafts.save;
  const deleteDraft = drafts.remove;

  const published = async (
    tenant: string,
    service: string,
    version?: number,
  ): Promise<Subject | undefined> => {
    const found = await deps.definitions.get('Service', tenant, service, version);
    return found
      ? {
          definition: structuredClone(found.definition) as unknown as Record<string, unknown>,
          files: { ...found.files },
          version: found.version,
        }
      : undefined;
  };

  const subjectOf = async (
    tenant: string,
    service: string,
    version: unknown,
    inline?: { definition?: unknown; files?: unknown },
  ): Promise<Subject | undefined> => {
    if (version === 'draft') {
      if (isRecord(inline?.definition)) {
        const files = isRecord(inline.files)
          ? Object.fromEntries(
              Object.entries(inline.files).filter(
                (e): e is [string, string] => typeof e[1] === 'string',
              ),
            )
          : {};
        const metadata = isRecord(inline.definition.metadata) ? inline.definition.metadata : {};
        return {
          definition: { ...inline.definition, metadata: { ...metadata, tenant, id: service } },
          files,
          version: 'draft',
        };
      }
      const draft = await draftOf(tenant, service);
      return draft
        ? { definition: draft.spec.definition, files: draft.spec.files, version: 'draft' }
        : undefined;
    }
    if (version === undefined || version === 'published') return published(tenant, service);
    return typeof version === 'number' && Number.isInteger(version)
      ? published(tenant, service, version)
      : undefined;
  };

  const runCases = async (
    principal: Principal,
    tenant: string,
    subject: Subject,
    cases: TestCase[],
    meter: Meter,
    options: { avoidAsJudge?: string[]; chargeTo?: string } = {},
  ): Promise<Outcome> => {
    const served = modelsOf(subject.definition);
    const judgeTenant = options.chargeTo ?? tenant;
    const judgeId = cases.some((c) => caseTypeOf(c) === 'criteria')
      ? choice.pickJudge(await choice.usable(judgeTenant), judgeTenant, [
          ...served,
          ...(options.avoidAsJudge ?? []),
        ])
      : undefined;
    const judge = judgeId
      ? choice.judgeModel(principal, judgeTenant, judgeId, 'builder', meter)
      : undefined;
    const results: CaseResult[] = [];
    for (const c of cases) {
      const view = caseView(c);
      const base = {
        caseId: c.id,
        input: view.input,
        expected: view.expected,
        type: view.type,
        split: view.split,
      };
      const outcome = await deps.drafts.run({
        principal,
        tenant,
        definition: subject.definition,
        files: subject.files,
        parts: [{ kind: 'text', text: view.input }],
        origin: 'builder',
        ...(subject.variant ? { variant: subject.variant } : {}),
        ...(options.chargeTo ? { chargeTo: options.chargeTo } : {}),
      });
      meter.add(outcome);
      if (!outcome.ok) {
        results.push({
          ...base,
          output: '',
          pass: false,
          reason: outcome.errors.map((e) => e.message).join('; '),
        });
        continue;
      }
      const usedModels = judgedModels(outcome.usage.byModel);
      const grade = await gradeAnswer(
        c,
        { text: outcome.answer, noAnswer: outcome.noAnswer },
        {
          ...(judge ? { judge } : {}),
          context: {
            servedModels: usedModels.length ? usedModels : served,
            modelFamily: choice.familyOf,
          },
        },
      );
      results.push({
        ...base,
        output: outcome.answer,
        pass: grade.pass,
        ...(grade.reason ? { reason: grade.reason } : {}),
      });
    }
    return summarize(results);
  };

  const evaluatorsFor = (cases: TestCase[]) => [
    'contract',
    ...(cases.some((c) => c.expected.sources.length > 0) ? ['retrieval'] : []),
    ...(cases.some((c) => caseTypeOf(c) === 'criteria') ? [criteriaJudgeId] : []),
  ];

  const save = (stored: StoredRun) => deps.evalStores.runs.save(stored);

  /** A run whose instance stopped without settling it is interrupted, as other background work. */
  const settled = async (stored: StoredRun): Promise<StoredRun> => {
    const run = interruptedIfAbandoned(stored.tenant, stored.run, leases);
    if (run === stored.run) return stored;
    const interrupted: StoredRun = { ...stored, run };
    const replaced = await deps.evalStores.runs
      .replace(interrupted, { status: stored.run.status, heartbeatAt: stored.run.heartbeatAt })
      .catch(() => false);
    if (replaced) return interrupted;
    // The owner saved the run after it was read: show what it saved.
    return (await deps.evalStores.runs.get(stored.run.id)) ?? stored;
  };

  const runOf = async (tenant: string, id: string) => {
    const stored = await deps.evalStores.runs.get(id);
    return stored?.tenant === tenant ? settled(stored) : undefined;
  };

  const runsOf = async (tenant: string, service: string) =>
    Promise.all(
      (await deps.evalStores.runs.list({ tenant, service }))
        .filter((s) => s.run.tested !== undefined)
        .map(settled),
    );

  const latestCompleted = async (tenant: string, service: string, testSet?: string) =>
    (await runsOf(tenant, service)).find(
      (s) =>
        runState(s.run) === 'completed' && (testSet === undefined || s.run.testSet.id === testSet),
    );

  /** What each case answered, read from its task; empty once the task's content is erased. */
  const answersOf = async (run: EvalRun) => {
    const answers = new Map<string, string>();
    for (const r of run.results) {
      let answer = '';
      try {
        for await (const event of deps.events(r.task))
          if (event.type === 'kernel.result') answer = answerOfParts(event.data);
      } catch {
        answer = '';
      }
      answers.set(`${r.case}#${r.repeat}`, answer);
    }
    return answers;
  };

  /** The judges of a connection that the tenant has taken in use as building blocks. */
  const adoptedJudges = async (tenant: string, connection: string) => {
    const judgeOf = deps.traceSinks?.judgeOf;
    if (!judgeOf) return [];
    const prefix = blockKey('judge', '');
    return (await deps.configEntries.latest({ kind: adoptionKind, scope: tenant }))
      .filter(
        (e) =>
          !e.deleted &&
          (e.spec as { status?: string }).status === 'in_use' &&
          e.id.startsWith(prefix) &&
          judgeOf(connection, e.id.slice(prefix.length)),
      )
      .map((e) => e.id.slice(prefix.length))
      .sort();
  };

  /** The adopted judges as the connection's project has them now; any refused one refuses the run. */
  const snapshotJudges = async (tenant: string, connection: TraceConnection, adopted: string[]) => {
    if (adopted.length === 0 || !deps.traceSinks?.judges) return [];
    const listed = await deps.traceSinks.judges(tenant, connection).catch((error: unknown) => {
      throw new TraceRefused(
        `the judges of the connection ${connection.id} could not be read: ${messageOf(error)}`,
      );
    });
    return adopted.map((id): SinkJudge => {
      const judge = listed.find((j) => j.id === id);
      if (!judge)
        throw new TraceRefused(
          `the judge ${id} is no longer an active experiment judge in the project of the connection ${connection.id}`,
        );
      // The refusal names the judge's rule, and reads in the person's language.
      if (judge.refused) throw new TraceRefused(judge.refused.message);
      return judge;
    });
  };

  /** The sink judges' reasons, kept only on each case's task for as long as its retention keeps them. */
  const judgeReasonsOf = async (run: EvalRun, isSinkJudge: IsSinkJudge) => {
    const reasons = new Map<string, Map<string, string>>();
    for (const r of run.results) {
      if (!r.scores.some((s) => isSinkJudge(s.evaluator) && s.state === 'scored')) continue;
      const said = new Map<string, string>();
      try {
        for await (const event of deps.events(r.task)) {
          const score = event.type === 'kernel.score' ? (event.data as Partial<Score>) : undefined;
          if (score?.evaluator && isSinkJudge(score.evaluator) && typeof score.reason === 'string')
            said.set(score.evaluator, score.reason);
        }
      } catch {
        continue;
      }
      reasons.set(`${r.case}#${r.repeat}`, said);
    }
    return reasons;
  };

  /** The residency a run of the definition has: as stated, or its primary model's. */
  const runResidency = (definition: Record<string, unknown>): Residency => {
    const stated = (
      isRecord(definition.spec) && isRecord(definition.spec.model)
        ? definition.spec.model.residency
        : undefined
    ) as Residency | undefined;
    if (stated && residencies.includes(stated)) return stated;
    const primary = modelsOf(definition)[0];
    return primary ? choice.residencyOf(primary) : 'global';
  };

  /** Where a run of the subject would be sent and which sink judges would score it, before it starts. */
  const sendingOf = async (tenant: string, service: string, subject: Subject) => {
    const covering = await connectionsCovering(deps.configEntries, tenant, service);
    const sink = covering[0];
    if (!sink) return { judges: [] };
    const adopted = await adoptedJudges(tenant, sink.id);
    const residency = runResidency(subject.definition);
    const refused =
      covering.length > 1
        ? { reason: 'covered-twice' as const, connections: covering.map((c) => c.id) }
        : !residencyAllows(residency, sink.residency)
          ? { reason: 'residency' as const, service: residency, connection: sink.residency }
          : undefined;
    return {
      connection: { id: sink.id, residency: sink.residency },
      judges: adopted.map((id) => ({ id, name: id.slice(id.indexOf('/') + 1) })),
      ...(refused ? { refused } : {}),
    };
  };

  const startRun = async (
    principal: Principal,
    tenant: string,
    service: string,
    set: TestSet,
    subject: Subject,
    split?: CaseSplit,
    options: { trace?: boolean } = {},
  ) => {
    if (!deps.evalCapability) throw new Error('the platform has no eval capability');
    // Locked cases never leave the platform, so a run of them alone sends nothing anywhere.
    const sendable = split !== 'locked';
    const covering = sendable ? await connectionsCovering(deps.configEntries, tenant, service) : [];
    const adopted = new Map(
      await Promise.all(
        covering.map(async (c) => [c.id, await adoptedJudges(tenant, c.id)] as const),
      ),
    );
    // A run that a sink's judge scores goes to that sink without being asked (ADR 0040).
    const judged = [...adopted.values()].some((ids) => ids.length > 0);
    const traced = sendable && (options.trace === true || judged);
    const sink = traced ? covering[0] : undefined;
    if (traced) {
      if (!sink || !deps.traceSinks)
        throw new TraceRefused(`no trace connection covers the service ${service}`);
      if (covering.length > 1)
        throw new TraceRefused(
          `two trace connections cover the service ${service}: ${covering.map((c) => c.id).join(', ')}`,
        );
    }
    const sinkJudges = sink ? await snapshotJudges(tenant, sink, adopted.get(sink.id) ?? []) : [];
    const prepared = await deps.drafts.prepare({
      principal,
      tenant,
      definition: subject.definition,
      files: subject.files,
      origin: 'builder',
      ...(typeof subject.version === 'number' ? { version: subject.version } : {}),
      ...(subject.variant ? { variant: subject.variant } : {}),
    });
    if (!prepared.ok) throw new RunRefused(prepared.errors);
    if (sink) {
      // The residency the run has, filled from its model when the draft leaves it out.
      const residency = residencyOf(prepared.definition);
      if (!residencyAllows(residency, sink.residency)) {
        prepared.release();
        throw new TraceRefused(
          `the service's residency ${residency} does not allow the connection's ${sink.residency}`,
        );
      }
    }
    const cases = casesIn(set, split);
    const runId = randomUUID();
    // Where the sink shows the run's experiment; a run is no less valid without the link.
    const experiment =
      sink && deps.traceSinks?.experimentUrl
        ? await deps.traceSinks.experimentUrl(tenant, sink, runId).catch(() => undefined)
        : undefined;
    const startedAt = leases.now().toISOString();
    const first: EvalRun = {
      id: runId,
      testSet: { tenant, id: set.metadata.id, version: set.metadata.version },
      capability: prepared.capability,
      splits: split ? splitsFor(split) : ['train', 'validation', 'holdout'],
      repeats: 1,
      startedAt,
      endedAt: startedAt,
      provenance: {
        commit: deps.appVersion ?? 'dev',
        data: 'live',
        servedModels: [],
        judges: [],
        services: [],
      },
      results: [],
      metrics: {},
      byTag: {},
      incomplete: [],
      status: 'running',
      progress: { done: 0, total: cases.length },
      tested: {
        version: subject.version,
        ...(subject.variant ? { variant: subject.variant } : {}),
        ...(split ? { split } : {}),
        ...(sink ? { sink: sink.id } : {}),
        ...(experiment ? { experiment } : {}),
      },
      ...leases.stamp(),
    };
    const validated = validateDefinition(subject.definition, deps.plugins);
    const spec = validated.ok ? validated.definition.spec : subject.definition.spec;
    const record = { tenant, service, subject: definitionSubject(spec) };
    let task = '';
    const lease = leases.hold(`${tenant}/${first.id}`, first, (run) =>
      save({ ...record, task, run }),
    );
    try {
      await lease.update((run) => run, 'started');
    } catch (error) {
      lease.release();
      prepared.release();
      throw error;
    }
    if (sink)
      deps.traceSinks?.open(
        first.id,
        tenant,
        sink,
        deps.traceDeliveries
          ? deliveryGate({
              configEntries: deps.configEntries,
              deliveries: deps.traceDeliveries,
              tenant,
              sink: sink.id,
              opened: { host: sink.host, publicKey: sink.publicKey },
              now: () => leases.now().toISOString(),
            })
          : undefined,
        deps.traceSinks.fieldsOf?.(sinkJudges) ?? [],
      );
    const done = (async () => {
      try {
        const invoked = await deps.kernel.invoke(principal, deps.evalCapability as string, {
          data: {
            id: first.id,
            capability: prepared.capability,
            testSet: set,
            evaluators: [...evaluatorsFor(cases), ...sinkJudges.map((j) => j.id)],
            provenance: { commit: first.provenance.commit, data: first.provenance.data },
            splits: first.splits,
            ...(sink ? { sink: sink.id } : {}),
            ...(sinkJudges.length > 0 ? { sinkJudges: sinkJudges.map((j) => j.snapshot) } : {}),
            // The judge is picked outside every model the service may answer with, fallback too.
            avoidAsJudge: modelsOf(subject.definition),
          },
        });
        task = invoked.task;
        // Notices are applied in order to the latest state, and never reopen a finished run.
        void (async () => {
          for await (const event of invoked.events) {
            const data = event.data as
              { kind?: string; done?: number; total?: number; usage?: unknown } | undefined;
            if (event.type !== 'kernel.notice') continue;
            if (data?.kind === 'eval.progress' && data.done !== undefined) {
              const usage = evalRun.shape.usage.safeParse(data.usage);
              await lease.update(
                (run) =>
                  progressed(
                    run,
                    { done: data.done ?? 0, total: data.total ?? 0 },
                    usage.success ? usage.data : undefined,
                  ),
                'progress',
              );
            }
            if (data?.kind === 'eval.waiting') await lease.update(waitingForScores, 'waiting');
          }
        })().catch(() => undefined);
        const parts = await invoked.result;
        const json = parts.find((p) => p.body.kind === 'json')?.body;
        const result = evalRun.parse(json?.kind === 'json' ? json.json : undefined);
        // The draft's capability lives for one run; the service it tests is what runs compare by.
        const services = result.provenance.services.map((s) =>
          s.startsWith(`${prepared.capability}@`)
            ? `${tenant}/${service}${s.slice(prepared.capability.length)}`
            : s,
        );
        await lease.update(
          () => ({
            ...result,
            provenance: { ...result.provenance, services },
            ...(first.tested ? { tested: first.tested } : {}),
            progress: { done: cases.length, total: cases.length },
          }),
          'completed',
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
            'failed',
          )
          .catch(() => undefined);
      } finally {
        lease.release();
        prepared.release();
        // Deliveries are recorded before each batch goes out (deliveryGate); closing only flushes.
        if (sink) await deps.traceSinks?.close(first.id).catch(() => []);
      }
    })();
    return { run: first, done };
  };

  return {
    choice,
    drafts,
    draftOf,
    saveDraft,
    deleteDraft,
    published,
    subjectOf,
    runCases,
    runOf,
    runsOf,
    latestCompleted,
    answersOf,
    judgeReasonsOf,
    sendingOf,
    leases,
    startRun,
  };
};

export type ServiceEval = ReturnType<typeof serviceEval>;
