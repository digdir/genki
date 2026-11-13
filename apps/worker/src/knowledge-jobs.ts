import type { Principal } from '@genai/contracts';
import { withModelAdmission } from '@genai/composition';
import {
  knowledgePlatformQueues,
  knowledgeServerQueues,
  queueWork,
  workQueues,
  type Job,
  type JobData,
  type JobQueue,
  type QueueDefinition,
  type QueueWork,
  type RunJobs,
} from '@genai/jobs';
import type { StoredConversions } from '@genai/port-knowledge';
import {
  executionScope,
  runtimeRole,
  workerRole,
  type IngestionExecution,
  type QueuedRunRules,
  type RunOutcome,
} from '@genai/providers-postgres';

export const knowledgeWriterRole = 'genai_knowledge_writer';
export const knowledgeReaderRole = 'genai_knowledge_reader';

/** How the worker installs and opens a server's job queue, given by main.ts (ADR 0023). */
export type OpenJobQueue<Pool> = (
  pools: { owner: Pool; runtime: Pool },
  queues: QueueDefinition[],
  options: {
    worker: string;
    readers?: string[];
    senders?: string[];
    works: boolean;
    onError?: (error: unknown) => void;
  },
) => Promise<JobQueue>;

export interface WorkerJobServers<Pool> {
  /** The platform server: the owner installs, genai_worker sends and works. */
  platform: { owner: Pool; worker: Pool };
  /** The knowledge server, when one is configured: its owner installs, the writer sends and works. */
  knowledge?: { owner: Pool; writer: Pool };
  markerTimeoutMs: number;
  /** The platform queues the worker works, each with its handler. */
  work: QueueWork[];
  /** The knowledge server's queues the worker works, each with its handler. */
  knowledgeWork?: QueueWork[];
  open: OpenJobQueue<Pool>;
  runJobs: (pool: Pool, jobs: JobQueue, queues: QueueDefinition[]) => RunJobs;
  /** Wraps the knowledge server's run jobs, so records waiting on a conversion count as open work. */
  knowledgeRunJobs?: (jobs: RunJobs) => RunJobs;
  onError?: (error: unknown) => void;
  /** Where each failed attempt of a knowledge job is logged. */
  log: (msg: string, fields: Record<string, unknown>) => void;
}

export interface WorkerJobs {
  platform: JobQueue;
  knowledge?: JobQueue;
  /** A run's jobs on each server, for the reconciler. */
  runJobs: RunJobs[];
}

type FailureLog = WorkerJobServers<unknown>['log'];

/**
 * An error by its name and code, such as SQLSTATE 22021 or ENOENT, never its message: a message can
 * hold a file path or a URL, and logs name a document only by its record's number (ADR 0042).
 */
const errorKind = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    error: error instanceof Error ? error.name : typeof error,
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
  };
};

/**
 * A job queue whose `knowledge.*` handlers log each failed attempt before pg-boss records it on the
 * job (issue 532): the queue, the job id, the attempt, what follows and the error's name and code,
 * never its message or the job's data, so no source id (ADR 0042). Every `work` goes through it, the night window's too.
 */
const loggingFailures = (queue: JobQueue, log: FailureLog): JobQueue =>
  new Proxy(queue, {
    get(target, property) {
      if (property === 'work')
        return <T extends JobData>(
          definition: QueueDefinition<T>,
          handler: (job: Job<T>) => Promise<void>,
          options?: Parameters<JobQueue['work']>[2],
        ) =>
          target.work(
            definition,
            definition.name.startsWith('knowledge.')
              ? async (job: Job<T>) => {
                  try {
                    await handler(job);
                  } catch (error) {
                    const last = job.retryCount >= definition.retryLimit;
                    log('a knowledge job failed', {
                      queue: definition.name,
                      job: job.id,
                      attempt: job.retryCount + 1,
                      next: !last ? 'retry' : definition.deadLetter ? 'dead letter' : 'none',
                      ...errorKind(error),
                    });
                    throw error;
                  }
                }
              : handler,
            options,
          );
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/**
 * Installs the job queues on both servers and works the queues that have handlers on each:
 * `knowledge.ingest` and `knowledge.index` since issue 139; the rest come with #140 and #141.
 */
export const openWorkerJobs = async <Pool>(
  servers: WorkerJobServers<Pool>,
): Promise<WorkerJobs> => {
  const onError = servers.onError ? { onError: servers.onError } : {};
  const logged = (queue: JobQueue) => loggingFailures(queue, servers.log);
  const platform = logged(
    await servers.open(
      { owner: servers.platform.owner, runtime: servers.platform.worker },
      [...servers.work.map((w) => w.queue), ...knowledgePlatformQueues],
      {
        worker: workerRole,
        readers: [runtimeRole],
        senders: [runtimeRole],
        works: true,
        ...onError,
      },
    ),
  );
  await workQueues(platform, servers.work);
  const runJobs: RunJobs[] = [
    servers.runJobs(servers.platform.worker, platform, knowledgePlatformQueues),
  ];
  if (!servers.knowledge) return { platform, runJobs };
  const queues = knowledgeServerQueues(servers.markerTimeoutMs);
  const knowledge = logged(
    await servers.open(
      { owner: servers.knowledge.owner, runtime: servers.knowledge.writer },
      queues,
      { worker: knowledgeWriterRole, readers: [knowledgeReaderRole], works: true, ...onError },
    ),
  );
  await workQueues(knowledge, servers.knowledgeWork ?? []);
  const knowledgeJobs = servers.runJobs(servers.knowledge.writer, knowledge, queues);
  runJobs.push(servers.knowledgeRunJobs ? servers.knowledgeRunJobs(knowledgeJobs) : knowledgeJobs);
  return { platform, knowledge, runJobs };
};

export const admissionHours = 24;

export const notAdmittedMessage =
  'the run was not admitted, so its jobs fetch, convert and embed nothing';

export const admissionRanOutMessage = `the run was admitted more than ${admissionHours} hours ago, and in lockdown its jobs then fetch, convert and embed nothing; start it again`;

export const expiredQueuedRunMessage = `the run waited more than ${admissionHours} hours after it was admitted, and in lockdown it then fails without starting; start it again`;

const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000);

/** Why a job of this run must not fetch, convert or call a model, or nothing when it may. */
export const admissionRefusal = (
  run: IngestionExecution | undefined,
  now: Date,
  lockdown: boolean,
): string | undefined => {
  if (!run) return 'the run is gone';
  if (!run.admittedAt) return notAdmittedMessage;
  if (lockdown && Date.parse(run.admittedAt) < hoursAgo(now, admissionHours).getTime())
    return admissionRanOutMessage;
  return undefined;
};

/** In lockdown, a queued run admitted before this time fails without starting. */
export const queuedRunRules = (now: Date, lockdown: boolean): QueuedRunRules => ({
  ...(lockdown ? { admittedAfter: hoursAgo(now, admissionHours).toISOString() } : {}),
  expiredError: expiredQueuedRunMessage,
});

export interface RunRecords {
  find(id: string): Promise<IngestionExecution | undefined>;
  end(
    run: IngestionExecution,
    outcome: RunOutcome,
    at: string,
    rules: QueuedRunRules,
  ): Promise<{ ended?: IngestionExecution; started?: IngestionExecution }>;
}

export interface KnowledgeJob<T extends JobData> {
  job: Job<T>;
  /** The run as its record says, never as the job's data says. */
  run: IngestionExecution;
  /** Acts for the run's organisation, with model admission only once the run's admission held. */
  principal: Principal;
  /** Whether the run was cancelled; a handler checks it between documents. */
  cancelled(): Promise<boolean>;
}

export interface AdmissionDeps {
  records: RunRecords;
  platformTenant: string;
  lockdown: boolean;
  now?: () => Date;
  onRefused?: (message: string) => void;
}

/**
 * Wraps a handler of a run's job: it reads the run's record and refuses before any fetch,
 * conversion or model call unless the run is open and admitted, and in lockdown admitted within
 * 24 hours (ADR 0042, "Jobs"). Nothing in the job's data can admit it.
 */
export const admittedWork = <T extends JobData & { run: string }>(
  queue: QueueDefinition<T>,
  handler: (job: KnowledgeJob<T>) => Promise<void>,
  deps: AdmissionDeps,
): QueueWork<T> =>
  queueWork(queue, async (job) => {
    const now = deps.now?.() ?? new Date();
    const run = await deps.records.find(job.data.run);
    if (run && run.status !== 'running') return;
    const refused = admissionRefusal(run, now, deps.lockdown);
    if (refused || !run) {
      deps.onRefused?.(`${queue.name} ${job.id} for run ${job.data.run}: ${refused ?? ''}`);
      if (run)
        await deps.records.end(
          run,
          { status: 'failed', error: refused ?? notAdmittedMessage },
          now.toISOString(),
          queuedRunRules(now, deps.lockdown),
        );
      return;
    }
    const scope = executionScope(run.dataset);
    const system: Principal = {
      kind: 'agency-system',
      issuer: 'platform',
      subject: `knowledge-jobs:${run.id}`,
      tenant: scope === 'platform' ? deps.platformTenant : scope,
    };
    await handler({
      job,
      run,
      principal: withModelAdmission(system),
      cancelled: async () => Boolean((await deps.records.find(run.id))?.cancelRequestedAt),
    });
  });

/** The waits of a run's records on conversions, as the reconciler counts and cancels them. */
export type ConversionWaits = Pick<
  StoredConversions,
  'waitKeys' | 'waitsSince' | 'release' | 'waitedKeys'
>;

/**
 * A run's jobs on the knowledge server with its records' waits (ADR 0042, "Jobs"): a record waiting
 * on a conversion is open work of its run while that conversion's job is waiting, retrying or
 * running. Cancelling a run ends its waits; under each key's lock, a conversion no one waits on any
 * more is cancelled, and one another run waits on is handed to that run, so the cancelled run ends.
 */
export const conversionRunJobs = (
  jobs: RunJobs,
  waits: ConversionWaits,
  convertQueue = 'knowledge.convert',
): RunJobs => ({
  open: async (run) => {
    const open = await jobs.open(run);
    if (open > 0 || !jobs.openKeys) return open;
    return jobs.openKeys(convertQueue, await waits.waitKeys(run));
  },
  // A conversion another run sent that its records waited on counts among its failed documents too.
  deadLetters: async (run) => {
    const dead = await jobs.deadLetters(run);
    if (!jobs.deadFiles) return dead;
    const shared = await jobs.deadFiles(convertQueue, await waits.waitsSince(run), run);
    return shared > 0 ? { ...dead, [convertQueue]: (dead[convertQueue] ?? 0) + shared } : dead;
  },
  cancel: async (run, options = {}) => {
    let cancelled = 0;
    await waits.release(run, async (transaction, freed, kept) => {
      cancelled += (await jobs.cancelKeys?.(convertQueue, freed, transaction)) ?? 0;
      for (const { key, ...to } of kept)
        await jobs.handOver?.(convertQueue, key, run, to, transaction);
    });
    return (
      cancelled +
      (await jobs.cancel(run, {
        ...options,
        keep: [...(options.keep ?? []), ...(await waits.waitedKeys())],
      }))
    );
  },
  redrive: (run) => jobs.redrive(run),
  runs: () => jobs.runs(),
  ...(jobs.openKeys ? { openKeys: jobs.openKeys.bind(jobs) } : {}),
});

/**
 * Wraps the handler of a convert job (ADR 0042, "Jobs"): the conversion runs while any run with a
 * record waiting on it, or the run that sent it, is running and admitted, and in lockdown admitted
 * within 24 hours. Without one, it converts nothing.
 */
export const admittedConversion = <T extends JobData & { run: string }>(
  queue: QueueDefinition<T>,
  handler: (job: KnowledgeJob<T> & { sender?: IngestionExecution }) => Promise<void>,
  deps: AdmissionDeps & { waiting(data: T): Promise<string[]> },
): QueueWork<T> =>
  queueWork(queue, async (job) => {
    const now = deps.now?.() ?? new Date();
    const ids = [...new Set([job.data.run, ...(await deps.waiting(job.data))])];
    const runs = (await Promise.all(ids.map((id) => deps.records.find(id)))).filter(
      (r): r is IngestionExecution => r !== undefined,
    );
    const running = runs.filter((r) => r.status === 'running' && !r.cancelRequestedAt);
    const run = running.find((r) => !admissionRefusal(r, now, deps.lockdown));
    if (!run) {
      deps.onRefused?.(`${queue.name} ${job.id}: no run waiting on it is running and admitted`);
      return;
    }
    const scope = executionScope(run.dataset);
    const system: Principal = {
      kind: 'agency-system',
      issuer: 'platform',
      subject: `knowledge-jobs:${run.id}`,
      tenant: scope === 'platform' ? deps.platformTenant : scope,
    };
    const sender = runs.find((r) => r.id === job.data.run);
    await handler({
      job,
      run,
      ...(sender ? { sender } : {}),
      principal: withModelAdmission(system),
      cancelled: async () => Boolean((await deps.records.find(run.id))?.cancelRequestedAt),
    });
  });
