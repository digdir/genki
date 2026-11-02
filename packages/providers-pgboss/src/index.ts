import {
  admitPayload,
  deadLetterQueue,
  JobQueueError,
  type DeadJob,
  type DeadLetterFilter,
  type JobData,
  type JobHandler,
  type JobQueue,
  type JobReads,
  type JobTransaction,
  type QueueCounts,
  type QueueDefinition,
  type ReadOptions,
  type ScheduleOptions,
  type SendOptions,
} from '@genai/jobs';
import type { Pool } from 'pg';
import { PgBoss, type Db, type Queue } from 'pg-boss';

export const jobSchema = 'pgboss';

const day = 24 * 60 * 60;

export const jobDeletion = { deleteAfterSeconds: 7 * day, retentionSeconds: 14 * day };

const identifier = /^[a-z_][a-z0-9_]*$/;

const adapter = (runner: JobTransaction): Db => ({
  executeSql: async (text, values) => (await runner.query(text, values)) as { rows: never[] },
});

interface QueueShape {
  fixed: Pick<Queue, 'policy' | 'deadLetter' | 'heartbeatSeconds'>;
  updatable: Pick<
    Queue,
    | 'expireInSeconds'
    | 'retryLimit'
    | 'retryDelay'
    | 'retryBackoff'
    | 'retentionSeconds'
    | 'deleteAfterSeconds'
  >;
}

const queueShape = (queue: QueueDefinition): QueueShape => ({
  fixed: {
    policy: queue.policy,
    ...(queue.deadLetter ? { deadLetter: deadLetterQueue(queue.name) } : {}),
    heartbeatSeconds: queue.heartbeatSeconds,
  },
  updatable: {
    ...jobDeletion,
    expireInSeconds: queue.expireInSeconds,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds ?? 0,
    retryBackoff: queue.retryBackoff ?? false,
  },
});

const deadLetterShape: QueueShape = {
  fixed: { policy: 'standard' },
  updatable: jobDeletion,
};

const ensureQueue = async (boss: PgBoss, name: string, shape: QueueShape) => {
  const existing = await boss.getQueue(name);
  if (!existing) return boss.createQueue(name, { ...shape.fixed, ...shape.updatable });
  const changed = (['policy', 'deadLetter', 'heartbeatSeconds'] as const).filter(
    (field) => (existing[field] ?? null) !== (shape.fixed[field] ?? null),
  );
  if (changed.length)
    throw new JobQueueError(
      `queue ${name} cannot change ${changed.join(', ')} in place; create a queue under a new name`,
    );
  await boss.updateQueue(name, shape.updatable);
};

const platformAccessCheck = `
  if coalesce(current_setting('app.platform_access', true), '') = '' then
    raise exception 'reading jobs needs an explicit platform access purpose'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(current_setting('app.tenant', true), '') <> '' then
    raise exception 'reading jobs is not allowed inside a tenant transaction'
      using errcode = 'insufficient_privilege';
  end if;`;

const readFunctions = (schema: string) => [
  `create or replace function ${schema}.genai_queue_counts(p_names text[])
     returns table (name text, queued bigint, active bigint, failed bigint)
     language plpgsql stable security definer set search_path = ${schema}, pg_catalog
     as $$ begin ${platformAccessCheck}
       return query
         select j.name,
                count(*) filter (where j.state in ('created', 'retry')),
                count(*) filter (where j.state = 'active'),
                count(*) filter (where j.state = 'failed')
           from ${schema}.job j where j.name = any(p_names) group by j.name;
     end $$`,
  `create or replace function ${schema}.genai_dead_letters(p_queue text, p_tenant text, p_limit int)
     returns table (id uuid, source text, data jsonb, error text, failed_at timestamptz)
     language plpgsql stable security definer set search_path = ${schema}, pg_catalog
     as $$ begin ${platformAccessCheck}
       return query
         select j.id, j.source_name, j.data,
                coalesce(j.source_output ->> 'message', j.output ->> 'message'), j.created_on
           from ${schema}.job j
          where j.name = p_queue and j.state in ('created', 'retry')
            and (p_tenant is null or j.data ->> 'tenant' = p_tenant)
          order by j.created_on desc, j.id
          limit p_limit;
     end $$`,
];

const readFunctionSignatures = (schema: string) => [
  `${schema}.genai_queue_counts(text[])`,
  `${schema}.genai_dead_letters(text, text, int)`,
];

export interface InstallOptions {
  /** Sends and works jobs, with DML on the job tables: genai_worker on the platform server. */
  worker: string;
  /** Read jobs only through the read functions and have no right on the tables: genai_runtime. */
  readers?: string[];
  schema?: string;
}

export const installJobQueue = async (
  owner: Pool,
  queues: QueueDefinition[],
  options: InstallOptions,
) => {
  const schema = options.schema ?? jobSchema;
  const readers = options.readers ?? [];
  if (![options.worker, ...readers, schema].every((name) => identifier.test(name)))
    throw new JobQueueError('invalid role or schema name');
  const boss = new PgBoss({
    db: adapter(owner),
    schema,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => undefined);
  await boss.start();
  try {
    for (const queue of queues) {
      if (queue.deadLetter) await ensureQueue(boss, deadLetterQueue(queue.name), deadLetterShape);
      await ensureQueue(boss, queue.name, queueShape(queue));
    }
  } finally {
    await boss.stop({ graceful: false, close: false });
  }
  const reads = readFunctionSignatures(schema);
  const grants = [
    ...readFunctions(schema),
    `revoke all on all functions in schema ${schema} from public`,
    `grant usage on schema ${schema} to ${options.worker}`,
    `grant select, insert, update, delete on all tables in schema ${schema} to ${options.worker}`,
    `grant usage, select on all sequences in schema ${schema} to ${options.worker}`,
    `grant execute on all functions in schema ${schema} to ${options.worker}`,
    ...readers.flatMap((reader) => [
      `revoke all on all tables in schema ${schema} from ${reader}`,
      `revoke all on all sequences in schema ${schema} from ${reader}`,
      `revoke all on all functions in schema ${schema} from ${reader}`,
      `grant usage on schema ${schema} to ${reader}`,
      `grant execute on function ${reads.join(', ')} to ${reader}`,
    ]),
  ];
  // Workers that start together would otherwise fail on each other's grants and functions.
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-jobs-install'))`);
    for (const sql of grants) await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

interface CountRow {
  name: string;
  queued: string;
  active: string;
  failed: string;
}

interface DeadLetterRow {
  id: string;
  source: string | null;
  data: JobData;
  error: string | null;
  failed_at: Date;
}

/** The console's reads, through the read functions alone, so a role without table rights can run them. */
export class PgBossJobReads implements JobReads {
  readonly #pool: Pool;
  readonly #schema: string;

  constructor(pool: Pool, schema: string = jobSchema) {
    if (!identifier.test(schema)) throw new JobQueueError('invalid schema name');
    this.#pool = pool;
    this.#schema = schema;
  }

  async deadLetters(queue: QueueDefinition, filter: DeadLetterFilter = {}): Promise<DeadJob[]> {
    const { rows } = await (filter.transaction ?? this.#pool).query(
      `select * from ${this.#schema}.genai_dead_letters($1, $2, $3)`,
      [deadLetterQueue(queue.name), filter.tenant ?? null, filter.limit ?? 100],
    );
    return (rows as DeadLetterRow[]).map((row) => ({
      id: row.id,
      queue: row.source ?? queue.name,
      data: row.data,
      ...(row.error === null ? {} : { error: row.error }),
      failedAt: row.failed_at,
    }));
  }

  async counts(queues: QueueDefinition[], options: ReadOptions = {}): Promise<QueueCounts[]> {
    const names = queues.flatMap((queue) => [queue.name, deadLetterQueue(queue.name)]);
    const { rows } = await (options.transaction ?? this.#pool).query(
      `select * from ${this.#schema}.genai_queue_counts($1)`,
      [names],
    );
    const byName = new Map((rows as CountRow[]).map((row) => [row.name, row]));
    const number = (value: string | undefined) => Number(value ?? 0);
    return queues.map((queue) => {
      const own = byName.get(queue.name);
      return {
        queue: queue.name,
        queued: number(own?.queued),
        active: number(own?.active),
        failed: number(own?.failed),
        deadLetters: number(byName.get(deadLetterQueue(queue.name))?.queued),
      };
    });
  }
}

export interface PgBossJobQueueOptions {
  works: boolean;
  schema?: string;
  pollingIntervalSeconds?: number;
  superviseIntervalSeconds?: number;
  cronIntervalSeconds?: number;
  onError?: (error: unknown) => void;
}

export class PgBossJobQueue implements JobQueue {
  readonly #boss: PgBoss;
  readonly #reads: PgBossJobReads;
  readonly #pollingIntervalSeconds: number;

  private constructor(boss: PgBoss, reads: PgBossJobReads, pollingIntervalSeconds: number) {
    this.#boss = boss;
    this.#reads = reads;
    this.#pollingIntervalSeconds = pollingIntervalSeconds;
  }

  static async start(pool: Pool, options: PgBossJobQueueOptions) {
    const schema = options.schema ?? jobSchema;
    const boss = new PgBoss({
      db: adapter(pool),
      schema,
      migrate: false,
      createSchema: false,
      supervise: options.works,
      schedule: options.works,
      reindex: false,
      ...(options.superviseIntervalSeconds === undefined
        ? {}
        : {
            superviseIntervalSeconds: options.superviseIntervalSeconds,
            maintenanceIntervalSeconds: options.superviseIntervalSeconds,
            monitorIntervalSeconds: options.superviseIntervalSeconds,
          }),
      ...(options.cronIntervalSeconds === undefined
        ? {}
        : {
            cronWorkerIntervalSeconds: options.cronIntervalSeconds,
            cronMonitorIntervalSeconds: options.cronIntervalSeconds,
          }),
    });
    boss.on(
      'error',
      options.onError ??
        ((error) =>
          process.emitWarning(error instanceof Error ? error.message : JSON.stringify(error))),
    );
    await boss.start();
    return new PgBossJobQueue(
      boss,
      new PgBossJobReads(pool, schema),
      options.pollingIntervalSeconds ?? 2,
    );
  }

  async send<T extends JobData>(queue: QueueDefinition<T>, data: T, options: SendOptions = {}) {
    return this.#boss.send(queue.name, admitPayload(queue, data), {
      ...(options.key === undefined ? {} : { singletonKey: options.key }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
      ...(options.transaction === undefined ? {} : { db: adapter(options.transaction) }),
    });
  }

  async work<T extends JobData>(queue: QueueDefinition<T>, handler: JobHandler<T>) {
    const id = await this.#boss.work<JobData>(
      queue.name,
      { batchSize: 1, pollingIntervalSeconds: this.#pollingIntervalSeconds },
      async ([job]) => {
        if (!job) return;
        await handler({
          id: job.id,
          queue: queue.name,
          data: admitPayload(queue, job.data),
          retryCount: job.retryCount,
          signal: job.signal,
        });
      },
    );
    return () => this.#boss.offWork(queue.name, { id });
  }

  async schedule<T extends JobData>(
    queue: QueueDefinition<T>,
    cron: string,
    data: T,
    options: ScheduleOptions,
  ) {
    await this.#boss.schedule(queue.name, cron, admitPayload(queue, data), {
      tz: options.tz,
      ...(options.key === undefined ? {} : { key: options.key }),
    });
  }

  async unschedule(queue: QueueDefinition, key?: string) {
    await this.#boss.unschedule(queue.name, key);
  }

  async cancel(queue: QueueDefinition, id: string) {
    await this.#boss.cancel(queue.name, id);
  }

  deadLetters(queue: QueueDefinition, filter?: DeadLetterFilter) {
    return this.#reads.deadLetters(queue, filter);
  }

  async redrive(queue: QueueDefinition, ids: string[]) {
    if (ids.length === 0) return 0;
    return this.#boss.redrive(deadLetterQueue(queue.name), { ids, destination: queue.name });
  }

  counts(queues: QueueDefinition[], options?: ReadOptions) {
    return this.#reads.counts(queues, options);
  }

  async stop() {
    await this.#boss.stop({ graceful: true, close: false, timeout: 10_000 });
  }
}

export const openJobQueue = async (
  pools: { owner: Pool; runtime: Pool },
  queues: QueueDefinition[],
  options: PgBossJobQueueOptions & Omit<InstallOptions, 'schema'>,
) => {
  const { worker, readers, ...start } = options;
  await installJobQueue(pools.owner, queues, {
    worker,
    ...(readers === undefined ? {} : { readers }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  return PgBossJobQueue.start(pools.runtime, start);
};
