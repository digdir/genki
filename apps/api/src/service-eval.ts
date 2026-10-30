import { randomUUID } from 'node:crypto';
import type { Part, Principal } from '@genai/contracts';
import { validateDefinition } from '@genai/definitions';
import {
  caseTypeOf,
  caseView,
  criteriaJudgeId,
  evalRun,
  gradeAnswer,
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
import { backgroundLeases, restartMessage, type LeaseOptions } from './background-lease.js';
import { definitionSubject } from './definition-subject.js';
import type { DraftModelUsage } from './draft-runner.js';
import { modelChoice, type Meter } from './model-choice.js';
import type { ModuleDeps } from './platform-modules.js';
import { serviceDrafts } from './service-drafts.js';

export const judgedModels = (byModel: DraftModelUsage[]) =>
  byModel.filter((m) => m.kind !== 'embedder').map((m) => m.model);

export { serviceDraftKind, type ServiceDraft } from './service-drafts.js';

export type RunVersion = 'draft' | number;

export interface CaseResult {
  caseId: string;
  input: string;
  expected: string;
  type: CaseType;
  split: CaseSplit;
  output: string;
  pass: boolean;
  reason?: string;
}

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

const verdictMetrics = new Set(['judge.criteria', 'exact-text', 'refusal']);

/** A case passes on its case type's own metric: the criteria judge, the exact text or the refusal. */
const verdictOf = (scores: Score[]) =>
  scores.find((s) => verdictMetrics.has(s.metric) && s.state !== 'not-applicable');

const passes = (scores: Score[]) => {
  const verdict = verdictOf(scores);
  return verdict?.state === 'scored' && verdict.value === 1;
};

const textOfParts = (parts: unknown) =>
  Array.isArray(parts)
    ? (parts as Part[]).flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('\n')
    : '';

/** A test run as the portal lists it, read from the eval run. */
export const runSummary = (run: EvalRun) => {
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
  };
};

/** One test run with each case as a person reads it: what it asked, answered and why it passed. */
export const runDetail = (
  run: EvalRun,
  set: TestSet | undefined,
  answers: Map<string, string>,
) => ({
  ...runSummary(run),
  byTag: run.byTag,
  cases: run.results.map((r): CaseResult => {
    const found = set?.spec.cases.find((c) => c.id === r.case);
    const view = found ? caseView(found) : undefined;
    const reason = verdictOf(r.scores)?.reason;
    return {
      caseId: r.case,
      input: view?.input ?? '',
      expected: view?.expected ?? '',
      type: view?.type ?? 'criteria',
      split: view?.split ?? 'open',
      output: answers.get(`${r.case}#${r.repeat}`) ?? '',
      pass: passes(r.scores),
      ...(reason ? { reason } : {}),
    };
  }),
});

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
    const state = runState(stored.run);
    if (state !== 'running' && state !== 'waiting-for-scores') return stored;
    if (!leases.abandoned(`${stored.tenant}/${stored.run.id}`, stored.run, stored.run.startedAt))
      return stored;
    const interrupted: StoredRun = {
      ...stored,
      run: {
        ...stored.run,
        status: 'interrupted',
        endedAt: leases.now().toISOString(),
        error: restartMessage,
      },
    };
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
          if (event.type === 'kernel.result') answer = textOfParts(event.data);
      } catch {
        answer = '';
      }
      answers.set(`${r.case}#${r.repeat}`, answer);
    }
    return answers;
  };

  const startRun = async (
    principal: Principal,
    tenant: string,
    service: string,
    set: TestSet,
    subject: Subject,
    split?: CaseSplit,
  ) => {
    if (!deps.evalCapability) throw new Error('the platform has no eval capability');
    const prepared = await deps.drafts.prepare({
      principal,
      tenant,
      definition: subject.definition,
      files: subject.files,
      origin: 'builder',
      ...(typeof subject.version === 'number' ? { version: subject.version } : {}),
      ...(subject.variant ? { variant: subject.variant } : {}),
    });
    if (!prepared.ok) throw new Error(prepared.errors.map((e) => e.message).join('; '));
    const cases = casesIn(set, split);
    const startedAt = leases.now().toISOString();
    const first: EvalRun = {
      id: randomUUID(),
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
    const done = (async () => {
      try {
        const invoked = await deps.kernel.invoke(principal, deps.evalCapability as string, {
          data: {
            id: first.id,
            capability: prepared.capability,
            testSet: set,
            evaluators: evaluatorsFor(cases),
            provenance: { commit: first.provenance.commit, data: first.provenance.data },
            splits: first.splits,
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
    leases,
    startRun,
  };
};

export type ServiceEval = ReturnType<typeof serviceEval>;
