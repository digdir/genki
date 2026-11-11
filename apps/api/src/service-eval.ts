import { randomUUID } from 'node:crypto';
import { variantId, variantModelOf, type Variant } from '@genai/definitions';
import type { Principal } from '@genai/contracts';
import {
  caseTypeOf,
  caseView,
  defaultObserve,
  gradeAnswer,
  judgedAgainst,
  splitsFor,
  type CaseSplit,
  type CaseType,
  type TestCase,
  type TestSet,
} from '@genai/eval';
import { publishedSubject } from './definition-subject.js';
import { actorOf } from './admin.js';
import {
  backgroundLeases,
  restartMessage,
  type Leased,
  type LeaseOptions,
} from './background-lease.js';
import { appendVersion, type ConfigEntry } from './config-store.js';
import type { DraftModelUsage } from './draft-runner.js';
import { modelChoice, type Meter } from './model-choice.js';
import { evalSlots, type QueueWatch } from './eval-slots.js';
import { markedNotFound } from './not-found.js';
import type { ModuleDeps } from './platform-modules.js';
import { serviceDrafts } from './service-drafts.js';

export const judgedModels = (byModel: DraftModelUsage[]) =>
  byModel.filter(judgedAgainst).map((m) => m.model);

export const serviceRunKind = 'service-eval-run';
export const serviceRunCaseKind = 'service-eval-case';
export const quotaStopMessage = 'Stoppet fordi månedskvoten for tokens er brukt opp';
export { serviceDraftKind, type ServiceDraft } from './service-drafts.js';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';
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

export interface ServiceRun extends Leased {
  id: string;
  service: string;
  status: RunStatus;
  testSet: string;
  testSetVersion: number;
  version: RunVersion;
  subject?: string;
  variant?: string;
  // The model the run is set to answer with.
  model?: string;
  split?: CaseSplit;
  // The cases the run was limited to.
  selected?: string[];
  startedAt: string;
  endedAt: string | null;
  score: number | null;
  passed: number;
  total: number;
  finished?: number;
  doneCases?: number[];
  queuePlace?: number;
  cost: number | null;
  tokens: { input: number; output: number };
  error?: string;
  interrupted?: boolean;
  cases: CaseResult[];
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

export const casesIn = (set: TestSet, split?: CaseSplit, only?: string[]) =>
  set.spec.cases.filter(
    (c) => (!split || splitsFor(split).includes(c.split)) && (!only || only.includes(c.id)),
  );

export const summarize = (results: CaseResult[]): Outcome => {
  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    passed,
    total: results.length,
    score: results.length ? passed / results.length : null,
  };
};

export const runView = (run: ServiceRun) => {
  const shown: Partial<ServiceRun> = { ...run };
  delete shown.owner;
  delete shown.heartbeatAt;
  delete shown.doneCases;
  if (run.error === restartMessage) shown.interrupted = true;
  return shown;
};

const withoutPlace = (run: ServiceRun): ServiceRun => {
  const rest = { ...run };
  delete rest.queuePlace;
  return rest;
};

export const runSummary = (run: ServiceRun) => {
  const shown = runView(run);
  delete shown.cases;
  return shown;
};

const modelsOf = (definition: Record<string, unknown>) => {
  const model = (isRecord(definition.spec) ? definition.spec.model : undefined) as
    { primary?: unknown; fallback?: unknown } | undefined;
  return [model?.primary, model?.fallback].filter((m): m is string => typeof m === 'string');
};

// Without a chosen variant, the first one, as the draft runner does.
export const answeringModel = ({ definition, variant }: Subject) => {
  const variants = isRecord(definition.spec) ? definition.spec.variants : undefined;
  const list = Array.isArray(variants) ? (variants as Variant[]) : [];
  const chosen = variant === undefined ? list[0] : list.find((v) => variantId(v) === variant);
  return (chosen && variantModelOf(chosen)) ?? modelsOf(definition)[0];
};

export const serviceEval = (deps: ModuleDeps, leaseOptions: LeaseOptions = {}) => {
  const choice = modelChoice(deps);
  const slots = deps.evalSlots ?? evalSlots();
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
    options: {
      avoidAsJudge?: string[];
      chargeTo?: string;
      run?: string;
      onCaseStart?: () => void;
      onCase?: (index: number, result: CaseResult) => Promise<void>;
      onQueue?: QueueWatch;
    } = {},
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
    const runCase = async (c: TestCase): Promise<CaseResult> => {
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
      if (!outcome.ok)
        return {
          ...base,
          output: '',
          pass: false,
          reason: outcome.errors.map((e) => e.message).join('; '),
        };
      const usedModels = judgedModels(outcome.usage.byModel);
      const grade = await gradeAnswer(
        c,
        {
          ...defaultObserve(outcome.parts, []),
          text: outcome.answer,
          noAnswer: markedNotFound(outcome),
        },
        {
          ...(judge ? { judge } : {}),
          context: {
            servedModels: usedModels.length ? usedModels : served,
            modelFamily: choice.familyOf,
          },
        },
      );
      return {
        ...base,
        output: outcome.answer,
        pass: grade.pass,
        ...(grade.reason ? { reason: grade.reason } : {}),
      };
    };
    const results: (CaseResult | undefined)[] = Array.from({ length: cases.length });
    const session = slots.session(options.run ?? randomUUID(), judgeTenant, options.onQueue);
    let next = 0;
    let stop: { error: unknown } | undefined;
    const worker = async () => {
      while (!stop && next < cases.length) {
        const release = await session.acquire();
        try {
          if (stop || next >= cases.length) return;
          if ((await deps.quota?.(judgeTenant, { fresh: true }))?.exhausted) {
            stop = { error: new Error(quotaStopMessage) };
            return;
          }
          const index = next++;
          const c = cases[index] as TestCase;
          options.onCaseStart?.();
          const result = await runCase(c);
          results[index] = result;
          await options.onCase?.(index, result);
        } catch (error) {
          stop ??= { error };
        } finally {
          release();
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(slots.limits.perRun, cases.length) }, worker),
      );
    } finally {
      session.end();
    }
    if (stop) throw stop.error;
    return summarize(results.filter((r): r is CaseResult => r !== undefined));
  };

  const saveRun = (actor: string, tenant: string, run: ServiceRun, reason: string) =>
    appendVersion<ServiceRun>(deps.configEntries, {
      kind: serviceRunKind,
      scope: tenant,
      id: run.id,
      spec: run,
      deleted: false,
      by: actor,
      reason,
    });

  const caseKey = (run: string, index: number) => `${run}/${index}`;

  const saveCase = (
    actor: string,
    tenant: string,
    run: string,
    index: number,
    result: CaseResult,
  ) =>
    appendVersion<CaseResult>(deps.configEntries, {
      kind: serviceRunCaseKind,
      scope: tenant,
      id: caseKey(run, index),
      spec: result,
      deleted: false,
      by: actor,
      reason: `Testtilfelle ${index + 1}`,
    });

  const finishedCases = async (tenant: string, run: ServiceRun) => {
    if (run.cases.length > 0 || !run.finished) return run.cases;
    const indexes = run.doneCases ?? Array.from({ length: run.finished }, (_, index) => index);
    const found = await Promise.all(
      indexes.map(async (index) =>
        (await deps.configEntries.history(serviceRunCaseKind, tenant, caseKey(run.id, index))).at(
          -1,
        ),
      ),
    );
    return found.flatMap((e) => (e ? [e.spec as CaseResult] : []));
  };

  const settled = async (entry: ConfigEntry<ServiceRun>) => {
    const run = entry.spec;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    if (!leases.abandoned(`${entry.scope}/${run.id}`, run, run.startedAt)) return run;
    const failed: ServiceRun = {
      ...run,
      status: 'failed',
      endedAt: leases.now().toISOString(),
      error: restartMessage,
      interrupted: true,
      cases: await finishedCases(entry.scope, run),
    };
    await appendVersion<ServiceRun>(deps.configEntries, {
      kind: serviceRunKind,
      scope: entry.scope,
      id: run.id,
      spec: failed,
      deleted: false,
      by: 'platform:restart',
      reason: restartMessage,
      ifVersion: entry.version,
    }).catch(() => undefined);
    return failed;
  };

  const runOf = async (tenant: string, id: string) => {
    const entry = (await deps.configEntries.history(serviceRunKind, tenant, id)).at(-1) as
      ConfigEntry<ServiceRun> | undefined;
    if (!entry) return undefined;
    const run = await settled(entry);
    return { ...run, cases: await finishedCases(tenant, run) };
  };

  const runsOf = async (tenant: string, service: string) =>
    (
      await Promise.all(
        (await deps.configEntries.latest({ kind: serviceRunKind, scope: tenant }))
          .filter((e) => (e.spec as ServiceRun).service === service)
          .map((e) => settled(e as ConfigEntry<ServiceRun>)),
      )
    ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const recoverRuns = async () => {
    for (const entry of await deps.configEntries.latest({ kind: serviceRunKind }))
      await settled(entry as ConfigEntry<ServiceRun>);
  };

  const startRun = async (
    principal: Principal,
    tenant: string,
    service: string,
    set: TestSet,
    subject: Subject,
    split?: CaseSplit,
    only?: string[],
  ) => {
    const actor = actorOf(principal.actor ?? principal);
    const model = answeringModel(subject);
    const queued: ServiceRun = {
      id: randomUUID(),
      service,
      status: 'queued',
      testSet: set.metadata.id,
      testSetVersion: set.metadata.version,
      version: subject.version,
      subject: publishedSubject(subject.definition, deps.plugins),
      ...(subject.variant ? { variant: subject.variant } : {}),
      ...(model ? { model } : {}),
      ...(split ? { split } : {}),
      ...(only ? { selected: only } : {}),
      startedAt: new Date().toISOString(),
      endedAt: null,
      score: null,
      passed: 0,
      total: casesIn(set, split, only).length,
      finished: 0,
      cost: 0,
      tokens: { input: 0, output: 0 },
      cases: [],
      ...leases.stamp(),
    };
    const lease = leases.hold(`${tenant}/${queued.id}`, queued, (run, reason) =>
      saveRun(actor, tenant, run, reason),
    );
    try {
      await lease.update((run) => run, `Testkjøring av ${set.metadata.id}`);
    } catch (error) {
      lease.release();
      throw error;
    }
    const done = (async () => {
      const meter = choice.meter();
      const saved = new Map<number, CaseResult>();
      const completed = new Map<number, CaseResult>();
      const inOrder = () => [...saved.keys()].sort((a, b) => a - b);
      const progress = (run: ServiceRun): ServiceRun => {
        const doneCases = inOrder();
        const { passed, score } = summarize(doneCases.map((i) => saved.get(i) as CaseResult));
        return {
          ...run,
          passed,
          score,
          finished: doneCases.length,
          doneCases,
          cost: meter.costMicroNok(),
          tokens: { input: meter.inputTokens, output: meter.outputTokens },
        };
      };
      const onCase = async (index: number, result: CaseResult) => {
        completed.set(index, result);
        await saveCase(actor, tenant, queued.id, index, result)
          .then(() => {
            saved.set(index, result);
            return lease.update(progress, `Testtilfelle ${saved.size} av ${queued.total}`);
          })
          .catch(() => undefined);
      };
      const onCaseStart = () => {
        if (started) return;
        started = true;
        void lease
          .update((run) => ({ ...withoutPlace(run), status: 'running' }), 'Kjører')
          .catch(() => undefined);
      };
      const onQueue = (place: number | undefined) => {
        void lease
          .update(
            (run) => (place === undefined ? withoutPlace(run) : { ...run, queuePlace: place }),
            place === undefined ? 'Kjører' : `Venter på ledig plass, nr. ${place}`,
          )
          .catch(() => undefined);
      };
      let started = false;
      try {
        const outcome = await runCases(
          principal,
          tenant,
          subject,
          casesIn(set, split, only),
          meter,
          { run: queued.id, onCase, onCaseStart, onQueue },
        );
        await lease.update(
          (run) => ({
            ...withoutPlace(progress(run)),
            status: 'succeeded',
            endedAt: new Date().toISOString(),
            passed: outcome.passed,
            score: outcome.score,
            finished: outcome.total,
            total: outcome.total,
            cases: outcome.results,
          }),
          'Ferdig',
        );
      } catch (error) {
        await lease.update(
          (run) => ({
            ...withoutPlace(progress(run)),
            status: 'failed',
            endedAt: new Date().toISOString(),
            error: messageOf(error),
            cases: [...completed.keys()]
              .sort((a, b) => a - b)
              .map((i) => completed.get(i) as CaseResult),
          }),
          'Feilet',
        );
      } finally {
        lease.release();
      }
    })();
    return { run: queued, done };
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
    recoverRuns,
    leases,
    startRun,
  };
};

export type ServiceEval = ReturnType<typeof serviceEval>;
