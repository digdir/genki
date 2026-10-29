import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { nextRun, parseCron, type Cron } from './cron.js';

export type JobData = Readonly<Record<string, string | number | boolean>>;

export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive';

export interface QueueDefinition<T extends JobData = JobData> {
  name: string;
  policy: QueuePolicy;
  payload: z.ZodType<T>;
  expireInSeconds: number;
  heartbeatSeconds: number;
  retryLimit: number;
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
  deadLetter: boolean;
}

export interface JobTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SendOptions {
  key?: string;
  priority?: number;
  startAfter?: Date;
  transaction?: JobTransaction;
}

export interface Job<T extends JobData = JobData> {
  id: string;
  queue: string;
  data: T;
  retryCount: number;
  signal: AbortSignal;
}

export type JobHandler<T extends JobData = JobData> = (job: Job<T>) => Promise<void>;

export interface DeadJob<T extends JobData = JobData> {
  id: string;
  queue: string;
  data: T;
  error?: string;
  failedAt: Date;
}

export interface ReadOptions {
  transaction?: JobTransaction;
}

export interface DeadLetterFilter extends ReadOptions {
  tenant?: string;
  limit?: number;
}

export interface QueueCounts {
  queue: string;
  queued: number;
  active: number;
  failed: number;
  deadLetters: number;
}

export interface ScheduleOptions {
  tz: string;
  key?: string;
}

export interface JobQueue {
  send<T extends JobData>(
    queue: QueueDefinition<T>,
    data: T,
    options?: SendOptions,
  ): Promise<string | null>;
  work<T extends JobData>(
    queue: QueueDefinition<T>,
    handler: JobHandler<T>,
  ): Promise<() => Promise<void>>;
  schedule<T extends JobData>(
    queue: QueueDefinition<T>,
    cron: string,
    data: T,
    options: ScheduleOptions,
  ): Promise<void>;
  unschedule(queue: QueueDefinition, key?: string): Promise<void>;
  cancel(queue: QueueDefinition, id: string): Promise<void>;
  deadLetters(queue: QueueDefinition, filter?: DeadLetterFilter): Promise<DeadJob[]>;
  redrive(queue: QueueDefinition, ids: string[]): Promise<number>;
  counts(queues: QueueDefinition[], options?: ReadOptions): Promise<QueueCounts[]>;
  stop(): Promise<void>;
}

export class JobQueueError extends Error {}

export const minimumHeartbeatSeconds = 10;

export const defineQueue = <T extends JobData>(queue: QueueDefinition<T>): QueueDefinition<T> => {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(queue.name) || queue.name.endsWith('.dead'))
    throw new JobQueueError(`invalid queue name ${queue.name}`);
  if (queue.heartbeatSeconds < minimumHeartbeatSeconds)
    throw new JobQueueError(
      `queue ${queue.name} needs a heartbeat of at least ${minimumHeartbeatSeconds} seconds`,
    );
  if (queue.heartbeatSeconds >= queue.expireInSeconds)
    throw new JobQueueError(`queue ${queue.name} must expire later than its heartbeat`);
  return queue;
};

export const deadLetterQueue = (queue: string) => `${queue}.dead`;

export const jobTenant = (data: JobData) =>
  typeof data.tenant === 'string' ? data.tenant : undefined;

const keyLike = /^[^\s]{1,128}$/;

export const admitPayload = <T extends JobData>(queue: QueueDefinition<T>, data: unknown): T => {
  const parsed = queue.payload.safeParse(data);
  if (!parsed.success)
    throw new JobQueueError(
      `queue ${queue.name} refuses the payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  const content = Object.entries(parsed.data).find(
    ([, value]) => typeof value === 'string' && !keyLike.test(value),
  );
  if (content)
    throw new JobQueueError(
      `queue ${queue.name} refuses ${content[0]}: job data carries keys, never content`,
    );
  return parsed.data;
};

export const retryDelayMs = (queue: QueueDefinition, retryCount: number) => {
  const base = (queue.retryDelaySeconds ?? 0) * 1000;
  return queue.retryBackoff ? Math.max(base, 1000) * 2 ** Math.min(16, retryCount - 1) : base;
};

type State = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

interface StoredJob {
  id: string;
  queue: string;
  data: JobData;
  key?: string;
  priority: number;
  startAfter: number;
  state: State;
  retryCount: number;
  createdAt: number;
  error?: string;
  source?: string;
  abort?: AbortController;
}

interface Worker {
  queue: QueueDefinition;
  handler: JobHandler;
  busy: boolean;
}

interface StoredSchedule {
  queue: QueueDefinition;
  cron: Cron;
  data: JobData;
  tz: string;
  next: number;
}

export interface InMemoryJobQueueOptions {
  now?: () => Date;
  pollMs?: number;
}

const queued = (job: StoredJob) => job.state === 'created' || job.state === 'retry';

export class InMemoryJobQueue implements JobQueue {
  readonly #jobs = new Map<string, StoredJob>();
  readonly #workers = new Map<string, Worker>();
  readonly #schedules = new Map<string, StoredSchedule>();
  readonly #openTransactions = new Map<JobTransaction, StoredJob[]>();
  readonly #now: () => Date;
  readonly #timer: NodeJS.Timeout;
  #ticking = false;
  #stopped = false;

  constructor(options: InMemoryJobQueueOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#timer = setInterval(() => void this.#tick(), options.pollMs ?? 50);
    this.#timer.unref?.();
  }

  transaction() {
    const transaction: JobTransaction = {
      query: () => Promise.reject(new JobQueueError('an in-memory transaction runs no SQL')),
    };
    this.#openTransactions.set(transaction, []);
    const close = () => {
      const jobs = this.#openTransactions.get(transaction) ?? [];
      this.#openTransactions.delete(transaction);
      return jobs;
    };
    return {
      transaction,
      commit: async () => {
        for (const job of close()) this.#jobs.set(job.id, job);
        void this.#tick();
      },
      rollback: async () => {
        close();
      },
    };
  }

  async send<T extends JobData>(queue: QueueDefinition<T>, data: T, options: SendOptions = {}) {
    const admitted = admitPayload(queue, data);
    if (options.key !== undefined && this.#refusesKey(queue, options.key)) return null;
    const job: StoredJob = {
      id: randomUUID(),
      queue: queue.name,
      data: admitted,
      ...(options.key === undefined ? {} : { key: options.key }),
      priority: options.priority ?? 0,
      startAfter: options.startAfter?.getTime() ?? 0,
      state: 'created',
      retryCount: 0,
      createdAt: this.#now().getTime(),
    };
    if (options.transaction) {
      const pending = this.#openTransactions.get(options.transaction);
      if (!pending)
        throw new JobQueueError('the in-memory job queue only joins transactions it opened');
      pending.push(job);
      return job.id;
    }
    this.#jobs.set(job.id, job);
    void this.#tick();
    return job.id;
  }

  async work<T extends JobData>(queue: QueueDefinition<T>, handler: JobHandler<T>) {
    if (this.#workers.has(queue.name))
      throw new JobQueueError(`queue ${queue.name} already has a worker`);
    this.#workers.set(queue.name, { queue, handler: handler as JobHandler, busy: false });
    void this.#tick();
    return async () => {
      this.#workers.delete(queue.name);
    };
  }

  async schedule<T extends JobData>(
    queue: QueueDefinition<T>,
    cron: string,
    data: T,
    options: ScheduleOptions,
  ) {
    const admitted = admitPayload(queue, data);
    const parsed = parseCron(cron);
    this.#schedules.set(`${queue.name}/${options.key ?? ''}`, {
      queue,
      cron: parsed,
      data: admitted,
      tz: options.tz,
      next: nextRun(parsed, this.#now(), options.tz).getTime(),
    });
  }

  async unschedule(queue: QueueDefinition, key?: string) {
    this.#schedules.delete(`${queue.name}/${key ?? ''}`);
  }

  async cancel(queue: QueueDefinition, id: string) {
    const job = this.#jobs.get(id);
    if (!job || job.queue !== queue.name || !(queued(job) || job.state === 'active')) return;
    job.abort?.abort();
    job.state = 'cancelled';
  }

  async deadLetters(queue: QueueDefinition, filter: DeadLetterFilter = {}) {
    return [...this.#jobs.values()]
      .filter(
        (job) =>
          job.queue === deadLetterQueue(queue.name) &&
          queued(job) &&
          (filter.tenant === undefined || jobTenant(job.data) === filter.tenant),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, filter.limit ?? 100)
      .map((job) => ({
        id: job.id,
        queue: job.source ?? queue.name,
        data: job.data,
        ...(job.error === undefined ? {} : { error: job.error }),
        failedAt: new Date(job.createdAt),
      }));
  }

  async redrive(queue: QueueDefinition, ids: string[]) {
    let moved = 0;
    for (const id of ids) {
      const dead = this.#jobs.get(id);
      if (!dead || dead.queue !== deadLetterQueue(queue.name) || !queued(dead)) continue;
      this.#jobs.delete(id);
      const job: StoredJob = {
        id: randomUUID(),
        queue: queue.name,
        data: dead.data,
        priority: 0,
        startAfter: 0,
        state: 'created',
        retryCount: 0,
        createdAt: this.#now().getTime(),
      };
      this.#jobs.set(job.id, job);
      moved += 1;
    }
    void this.#tick();
    return moved;
  }

  async counts(queues: QueueDefinition[]) {
    const jobs = [...this.#jobs.values()];
    const count = (queue: string, match: (job: StoredJob) => boolean) =>
      jobs.filter((job) => job.queue === queue && match(job)).length;
    return queues.map((queue) => ({
      queue: queue.name,
      queued: count(queue.name, queued),
      active: count(queue.name, (job) => job.state === 'active'),
      failed: count(queue.name, (job) => job.state === 'failed'),
      deadLetters: count(deadLetterQueue(queue.name), queued),
    }));
  }

  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#workers.clear();
    for (const job of this.#jobs.values()) job.abort?.abort();
  }

  #refusesKey(queue: QueueDefinition, key: string) {
    const same = [...this.#jobs.values()].filter((j) => j.queue === queue.name && j.key === key);
    if (queue.policy === 'short' || queue.policy === 'stately') return same.some(queued);
    if (queue.policy === 'exclusive')
      return same.some((job) => queued(job) || job.state === 'active');
    return false;
  }

  #next(queue: QueueDefinition) {
    const now = this.#now().getTime();
    const jobs = [...this.#jobs.values()].filter((job) => job.queue === queue.name);
    const activeKeys = new Set(
      jobs.filter((job) => job.state === 'active' && job.key).map((job) => job.key),
    );
    const oneActivePerKey = queue.policy !== 'standard' && queue.policy !== 'short';
    return jobs
      .filter(
        (job) =>
          queued(job) &&
          job.startAfter <= now &&
          !(oneActivePerKey && job.key !== undefined && activeKeys.has(job.key)),
      )
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
  }

  async #fireSchedules() {
    const now = this.#now();
    for (const schedule of this.#schedules.values()) {
      if (schedule.next > now.getTime()) continue;
      schedule.next = nextRun(schedule.cron, now, schedule.tz).getTime();
      await this.send(schedule.queue, schedule.data);
    }
  }

  async #run(worker: Worker, job: StoredJob) {
    const abort = new AbortController();
    worker.busy = true;
    job.state = 'active';
    job.abort = abort;
    try {
      const data = admitPayload(worker.queue, job.data);
      await worker.handler({
        id: job.id,
        queue: job.queue,
        data,
        retryCount: job.retryCount,
        signal: abort.signal,
      });
      if (job.state === 'active') job.state = 'completed';
    } catch (error) {
      if (job.state !== 'active') return;
      this.#fail(worker.queue, job, error instanceof Error ? error.message : String(error));
    } finally {
      delete job.abort;
      worker.busy = false;
      void this.#tick();
    }
  }

  #fail(queue: QueueDefinition, job: StoredJob, error: string) {
    job.error = error;
    if (job.retryCount < queue.retryLimit) {
      job.retryCount += 1;
      job.state = 'retry';
      job.startAfter = this.#now().getTime() + retryDelayMs(queue, job.retryCount);
      return;
    }
    job.state = 'failed';
    if (!queue.deadLetter) return;
    const dead: StoredJob = {
      id: randomUUID(),
      queue: deadLetterQueue(queue.name),
      data: job.data,
      priority: 0,
      startAfter: 0,
      state: 'created',
      retryCount: 0,
      createdAt: this.#now().getTime(),
      error,
      source: queue.name,
    };
    this.#jobs.set(dead.id, dead);
  }

  async #tick() {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      await this.#fireSchedules();
      for (const worker of this.#workers.values()) {
        if (worker.busy) continue;
        const job = this.#next(worker.queue);
        if (job) void this.#run(worker, job);
      }
    } finally {
      this.#ticking = false;
    }
  }
}
