import type { Principal } from '@genai/contracts';
import type { Kernel } from '@genai/kernel';
import { EvalError } from './evaluators.js';
import { compareRuns, type CompareOptions } from './runner.js';
import { evalRun, splits, type EvalRun, type Split, type TestSet } from './schema.js';
import type { EvalRunStore, StoredRun, TestSetStore } from './store.js';

export class EvalAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalAccessError';
  }
}

export interface TestSetSummary {
  id: string;
  name: string;
  version: number;
  service?: string;
  cases: number;
  splits: Record<Split, number>;
  needsReview: number;
}

export interface StartRunRequest {
  tenant: string;
  capability: string;
  testSet: { id: string; version?: number };
  evaluators: string[];
  provenance: { commit: string; data: string };
  service?: string;
  subject?: string;
  repeats?: number;
  splits?: Split[];
}

export type RunStatus =
  | { state: 'running'; task: string }
  | { state: 'completed'; task: string; run: string }
  | { state: 'failed'; task: string; error: string };

export interface EvalServiceOptions {
  kernel: Kernel;
  evalCapability: string;
  testSets: TestSetStore;
  runs: EvalRunStore;
}

export const mayAccess = (principal: Principal, tenant: string) =>
  principal.kind === 'operator'
    ? principal.actor !== undefined && principal.tenant === tenant
    : principal.tenant === tenant ||
      (principal.authorizedFor?.some((a) => a.org === tenant) ?? false);

const summaryOf = (set: TestSet): TestSetSummary => ({
  id: set.metadata.id,
  name: set.metadata.name,
  version: set.metadata.version,
  ...(set.spec.service ? { service: set.spec.service } : {}),
  cases: set.spec.cases.length,
  splits: Object.fromEntries(
    splits.map((s) => [s, set.spec.cases.filter((c) => c.split === s).length]),
  ) as Record<Split, number>,
  needsReview: set.spec.cases.filter((c) => c.needsReview).length,
});

const runOf = (parts: { body: { kind: string; json?: unknown } }[]): EvalRun => {
  const part = parts.find((p) => p.body.kind === 'json');
  if (!part) throw new EvalError('the eval task returned no run');
  return evalRun.parse(part.body.json);
};

export const createEvalService = (options: EvalServiceOptions) => {
  const jobs = new Map<string, RunStatus & { tenant: string }>();

  const failureOf = async (principal: Principal, task: string, status: string) => {
    try {
      let message: string | undefined;
      for await (const event of await options.kernel.events(principal, task))
        if (event.type === 'kernel.error')
          message = (event.data as { message?: string } | undefined)?.message ?? message;
      return message ?? status;
    } catch {
      return status;
    }
  };

  const guard = (principal: Principal, tenant: string) => {
    if (!mayAccess(principal, tenant))
      throw new EvalAccessError(`not allowed for tenant ${tenant}`);
  };

  const readable = async (principal: Principal, id: string): Promise<StoredRun> => {
    const stored = await options.runs.get(id);
    if (!stored || !mayAccess(principal, stored.tenant))
      throw new EvalAccessError(`eval run ${id} not found`);
    return stored;
  };

  return {
    listTestSets: async (principal: Principal, tenant: string, service?: string) => {
      guard(principal, tenant);
      return (await options.testSets.list(tenant, service)).map(summaryOf);
    },

    startRun: async (principal: Principal, request: StartRunRequest): Promise<RunStatus> => {
      guard(principal, request.tenant);
      const set = await options.testSets.get(
        request.tenant,
        request.testSet.id,
        request.testSet.version,
      );
      if (!set) throw new EvalError(`no test set ${request.testSet.id} for ${request.tenant}`);
      const run = await options.kernel.invoke(principal, options.evalCapability, {
        data: {
          capability: request.capability,
          testSet: set,
          evaluators: request.evaluators,
          provenance: request.provenance,
          ...(request.repeats === undefined ? {} : { repeats: request.repeats }),
          ...(request.splits === undefined ? {} : { splits: request.splits }),
        },
      });
      jobs.set(run.task, { state: 'running', task: run.task, tenant: request.tenant });
      run.result
        .then(async (parts) => {
          const result = runOf(parts);
          await options.runs.save({
            run: result,
            tenant: request.tenant,
            task: run.task,
            ...(request.service ? { service: request.service } : {}),
            ...(request.subject ? { subject: request.subject } : {}),
          });
          jobs.set(run.task, {
            state: 'completed',
            task: run.task,
            run: result.id,
            tenant: request.tenant,
          });
        })
        .catch((error: unknown) => {
          jobs.set(run.task, {
            state: 'failed',
            task: run.task,
            error: error instanceof Error ? error.message : String(error),
            tenant: request.tenant,
          });
        });
      return { state: 'running', task: run.task };
    },

    status: async (principal: Principal, task: string): Promise<RunStatus> => {
      const job = jobs.get(task);
      if (job) {
        if (!mayAccess(principal, job.tenant))
          throw new EvalAccessError(`eval task ${task} not found`);
        if (job.state === 'completed') return { state: job.state, task: job.task, run: job.run };
        if (job.state === 'failed') return { state: job.state, task: job.task, error: job.error };
      }
      const found = await options.kernel.task(principal, task).catch(() => undefined);
      if (!found || found.service.capability.id !== options.evalCapability)
        throw new EvalAccessError(`eval task ${task} not found`);
      if (!mayAccess(principal, found.tenant))
        throw new EvalAccessError(`eval task ${task} not found`);
      if (found.status === 'completed') {
        const saved = (await options.runs.list({ tenant: found.tenant })).find(
          (s) => s.task === task,
        );
        return saved ? { state: 'completed', task, run: saved.run.id } : { state: 'running', task };
      }
      if (found.status === 'failed' || found.status === 'cancelled')
        return { state: 'failed', task, error: await failureOf(principal, task, found.status) };
      return { state: 'running', task };
    },

    listRuns: async (principal: Principal, filter: Parameters<EvalRunStore['list']>[0]) => {
      guard(principal, filter.tenant);
      return (await options.runs.list(filter)).map((s) => ({
        id: s.run.id,
        testSet: s.run.testSet,
        capability: s.run.capability,
        endedAt: s.run.endedAt,
        metrics: s.run.metrics,
        ...(s.service ? { service: s.service } : {}),
        ...(s.subject ? { subject: s.subject } : {}),
      }));
    },

    getRun: async (principal: Principal, id: string) => {
      const stored = await readable(principal, id);
      return {
        run: stored.run,
        provenance: stored.run.provenance,
        metrics: stored.run.metrics,
        byTag: stored.run.byTag,
      };
    },

    compare: async (
      principal: Principal,
      baseline: string,
      candidate: string,
      metric: string,
      compare: CompareOptions = {},
    ) => {
      const a = await readable(principal, baseline);
      const b = await readable(principal, candidate);
      return compareRuns(a.run, b.run, metric, compare);
    },
  };
};

export type EvalService = ReturnType<typeof createEvalService>;
