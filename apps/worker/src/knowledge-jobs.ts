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
  open: OpenJobQueue<Pool>;
  runJobs: (pool: Pool, jobs: JobQueue, queues: QueueDefinition[]) => RunJobs;
  onError?: (error: unknown) => void;
}

export interface WorkerJobs {
  platform: JobQueue;
  knowledge?: JobQueue;
  /** A run's jobs on each server, for the reconciler. */
  runJobs: RunJobs[];
}

/**
 * Installs the job queues on both servers and works the platform queues that have handlers. The
 * knowledge queues are installed and not worked until their handlers exist (#139, #140, #141).
 */
export const openWorkerJobs = async <Pool>(
  servers: WorkerJobServers<Pool>,
): Promise<WorkerJobs> => {
  const onError = servers.onError ? { onError: servers.onError } : {};
  const platform = await servers.open(
    { owner: servers.platform.owner, runtime: servers.platform.worker },
    [...servers.work.map((w) => w.queue), ...knowledgePlatformQueues],
    { worker: workerRole, readers: [runtimeRole], senders: [runtimeRole], works: true, ...onError },
  );
  await workQueues(platform, servers.work);
  const runJobs: RunJobs[] = [
    servers.runJobs(servers.platform.worker, platform, knowledgePlatformQueues),
  ];
  if (!servers.knowledge) return { platform, runJobs };
  const queues = knowledgeServerQueues(servers.markerTimeoutMs);
  const knowledge = await servers.open(
    { owner: servers.knowledge.owner, runtime: servers.knowledge.writer },
    queues,
    { worker: knowledgeWriterRole, readers: [knowledgeReaderRole], works: true, ...onError },
  );
  runJobs.push(servers.runJobs(servers.knowledge.writer, knowledge, queues));
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
