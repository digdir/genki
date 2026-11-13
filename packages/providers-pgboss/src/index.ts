import {
  admitPayload,
  deadLetterQueue,
  JobQueueError,
  type DeadJob,
  type DeadLetterFilter,
  type Job,
  type JobData,
  type JobHandler,
  type JobQueue,
  type JobReads,
  type JobTransaction,
  type QueueCounts,
  type WorkOptions,
  type QueueDefinition,
  type ReadOptions,
  type RunJobs,
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
         -- A job shared by several organisations shows each only its own part: never who else waits.
         select j.id, j.source_name,
                case when p_tenant is null then j.data
                     when j.data ->> 'tenant' = p_tenant then j.data - 'tenants'
                     else jsonb_build_object('tenant', p_tenant, 'file', j.data -> 'file') end,
                case when p_tenant is null or j.data ->> 'tenant' = p_tenant
                     then coalesce(j.source_output ->> 'message', j.output ->> 'message') end,
                j.created_on
           from ${schema}.job j
          where j.name = p_queue and j.state in ('created', 'retry')
            and (p_tenant is null or j.data ->> 'tenant' = p_tenant
                 or p_tenant = any(string_to_array(j.data ->> 'tenants', ',')))
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
  /** May send jobs and nothing more: genai_runtime on the platform server, for the queues the API sends to. */
  senders?: string[];
  schema?: string;
}

export const installJobQueue = async (
  owner: Pool,
  queues: QueueDefinition[],
  options: InstallOptions,
) => {
  const schema = options.schema ?? jobSchema;
  const readers = options.readers ?? [];
  const senders = options.senders ?? [];
  if (![options.worker, ...readers, ...senders, schema].every((name) => identifier.test(name)))
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
    // What pg-boss 12's send touches, and nothing more: it reads the schema version and the queue,
    // calls job_now(), inserts into the job table and returns the new job's id.
    ...senders.flatMap((sender) => [
      `grant usage on schema ${schema} to ${sender}`,
      `grant select on ${schema}.version, ${schema}.queue to ${sender}`,
      `grant execute on function ${schema}.job_now() to ${sender}`,
      `grant insert on ${schema}.job, ${schema}.job_common to ${sender}`,
      `grant select (id, start_after) on ${schema}.job, ${schema}.job_common to ${sender}`,
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
  readonly #pool: Pool;
  readonly #schema: string;

  private constructor(
    boss: PgBoss,
    reads: PgBossJobReads,
    pollingIntervalSeconds: number,
    pool: Pool,
    schema: string,
  ) {
    this.#boss = boss;
    this.#reads = reads;
    this.#pollingIntervalSeconds = pollingIntervalSeconds;
    this.#pool = pool;
    this.#schema = schema;
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
      // A queue that only sends, as the API's does, keeps no row in pg-boss's instance registry.
      registerInstance: options.works,
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
      pool,
      schema,
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

  async work<T extends JobData>(
    queue: QueueDefinition<T>,
    handler: JobHandler<T>,
    options: WorkOptions = {},
  ) {
    const id = await this.#boss.work<JobData>(
      queue.name,
      {
        batchSize: 1,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
        // Each of these pollers takes one job, so the process works this many at once.
        localConcurrency: options.concurrency ?? 1,
      },
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

  async sendAgain<T extends JobData>(
    queue: QueueDefinition<T>,
    job: Job<T>,
    options: { key?: string; startAfter: Date },
  ) {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      const db = adapter(client);
      // Completed first, so the queue's key is free for the job sent again in the same transaction.
      await this.#boss.complete(queue.name, job.id, null, { db });
      const sent = await this.#boss.send(queue.name, admitPayload(queue, job.data), {
        ...(options.key === undefined ? {} : { singletonKey: options.key }),
        startAfter: options.startAfter,
        db,
      });
      if (sent === null) throw new JobQueueError(`job ${job.id} could not be sent again`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async serveAlso(
    queue: QueueDefinition,
    key: string,
    tenant: string,
    options: { transaction?: JobTransaction } = {},
  ) {
    await (options.transaction ?? this.#pool).query(
      `update ${this.#schema}.job
          set data = jsonb_set(data, '{tenants}', to_jsonb(
                concat_ws(',', nullif(data ->> 'tenants', ''), $3::text)))
        where name = $1 and singleton_key = $2 and state in ('created', 'retry', 'active')
          and data ->> 'tenant' <> $3
          and not ($3 = any(coalesce(string_to_array(data ->> 'tenants', ','), '{}')))
          -- Job data keeps keys of at most 128 characters; a longer list is left as it is.
          and length(concat_ws(',', nullif(data ->> 'tenants', ''), $3::text)) <= 128`,
      [queue.name, key, tenant],
    );
  }

  async retime(queues: QueueDefinition[], startAfter: Date) {
    const { rowCount } = await this.#pool.query(
      `update ${this.#schema}.job set start_after = $2
        where name = any($1) and state in ('created', 'retry')`,
      [queues.map((q) => q.name), startAfter],
    );
    return rowCount ?? 0;
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
  const { worker, readers, senders, ...start } = options;
  await installJobQueue(pools.owner, queues, {
    worker,
    ...(readers === undefined ? {} : { readers }),
    ...(senders === undefined ? {} : { senders }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  });
  return PgBossJobQueue.start(pools.runtime, start);
};

/** A run's jobs on one server, for the worker's role. */
export class PgBossRunJobs implements RunJobs {
  constructor(
    private readonly pool: Pool,
    private readonly jobs: JobQueue,
    private readonly queues: QueueDefinition[],
    private readonly schema: string = jobSchema,
  ) {}

  #names(options: { except?: string[] } = {}) {
    return this.queues.map((q) => q.name).filter((name) => !options.except?.includes(name));
  }

  #deadNames() {
    return this.queues.filter((q) => q.deadLetter).map((q) => deadLetterQueue(q.name));
  }

  #queue(name: string) {
    const queue = this.queues.find((q) => q.name === name);
    if (!queue) throw new JobQueueError(`no queue ${name}`);
    return queue;
  }

  async open(run: string): Promise<number> {
    const { rows } = await this.pool.query<{ open: string }>(
      `select count(*) as open from ${this.schema}.job
        where name = any($1) and state in ('created', 'retry', 'active') and data ->> 'run' = $2`,
      [this.#names(), run],
    );
    return Number(rows[0]?.open ?? 0);
  }

  async openKeys(queue: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const { rows } = await this.pool.query<{ open: string }>(
      `select count(*) as open from ${this.schema}.job
        where name = $1 and state in ('created', 'retry', 'active') and singleton_key = any($2::text[])`,
      [queue, keys],
    );
    return Number(rows[0]?.open ?? 0);
  }

  async deadFiles(
    queue: string,
    files: { sha256: string; since: Date }[],
    run: string,
  ): Promise<number> {
    if (files.length === 0) return 0;
    const { rows } = await this.pool.query<{ dead: string }>(
      `select count(*) as dead
         from ${this.schema}.job d
         join jsonb_to_recordset($2::jsonb) as f(sha256 text, since timestamptz)
           on d.data ->> 'file' = f.sha256 and d.created_on >= f.since
        where d.name = $1 and d.state in ('created', 'retry') and d.data ->> 'run' <> $3
          and not exists (
            select 1 from ${this.schema}.job o
             where o.name = $4 and o.state in ('created', 'retry', 'active')
               and o.data ->> 'file' = f.sha256)`,
      [deadLetterQueue(queue), JSON.stringify(files), run, queue],
    );
    return Number(rows[0]?.dead ?? 0);
  }

  async cancelKeys(queue: string, keys: string[], transaction?: JobTransaction): Promise<number> {
    if (keys.length === 0) return 0;
    // As pg-boss's own cancel does, inside the transaction that holds the keys' locks.
    const { rows } = await (transaction ?? this.pool).query(
      `update ${this.schema}.job set state = 'cancelled', completed_on = now()
        where name = $1 and singleton_key = any($2::text[]) and state in ('created', 'retry')
        returning id`,
      [queue, keys],
    );
    return rows.length;
  }

  async handOver(
    queue: string,
    key: string,
    from: string,
    to: { run: string; tenant: string; dataset: string; record: string },
    transaction?: JobTransaction,
  ): Promise<void> {
    await (transaction ?? this.pool).query(
      `update ${this.schema}.job
          set data = data || jsonb_build_object('run', $4::text, 'tenant', $5::text,
                                                'dataset', $6::text, 'record', $7::text)
        where name = $1 and singleton_key = $2 and data ->> 'run' = $3
          and state in ('created', 'retry', 'active')`,
      [queue, key, from, to.run, to.tenant, to.dataset, to.record],
    );
  }

  async deadLetters(run: string): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ name: string; dead: string }>(
      `select name, count(*) as dead from ${this.schema}.job
        where name = any($1) and state in ('created', 'retry') and data ->> 'run' = $2
        group by name order by name`,
      [this.#deadNames(), run],
    );
    return Object.fromEntries(
      rows.map((row) => [row.name.slice(0, -'.dead'.length), Number(row.dead)]),
    );
  }

  async cancel(run: string, options: { except?: string[]; keep?: string[] } = {}): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      `select id, name from ${this.schema}.job
        where name = any($1) and state in ('created', 'retry') and data ->> 'run' = $2
          and not (coalesce(singleton_key, '') = any($3::text[]))`,
      [this.#names(options), run, options.keep ?? []],
    );
    for (const row of rows) await this.jobs.cancel(this.#queue(row.name), row.id);
    return rows.length;
  }

  async redrive(run: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      `select id, name from ${this.schema}.job
        where name = any($1) and state in ('created', 'retry') and data ->> 'run' = $2`,
      [this.#deadNames(), run],
    );
    let sent = 0;
    for (const queue of this.queues) {
      const ids = rows
        .filter((row) => row.name === deadLetterQueue(queue.name))
        .map((row) => row.id);
      sent += await this.jobs.redrive(queue, ids);
    }
    return sent;
  }

  async runs(): Promise<string[]> {
    const { rows } = await this.pool.query<{ run: string }>(
      `select distinct data ->> 'run' as run from ${this.schema}.job
        where name = any($1) and state in ('created', 'retry', 'active') and data ? 'run'`,
      [this.#names()],
    );
    return rows.map((row) => row.run);
  }
}
