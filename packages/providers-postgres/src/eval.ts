import {
  currentFeedback,
  labelFile,
  type CandidateStatus,
  type CandidateStore,
  type EvalRunStore,
  type Feedback,
  type FeedbackRecord,
  type FeedbackStore,
  type JudgeLabel,
  type LabelStore,
  type RunFilter,
  type StoredRun,
  type TestCaseCandidate,
  type TestSet,
  type TestSetStore,
} from '@genai/eval';
import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';
import { withPlatformAccess, withTenant } from './tenancy.js';

const FEEDBACK_SCOPE = 'feedback';

export class PostgresTestSetStore implements TestSetStore {
  constructor(private readonly pool: Pool) {}

  async put(set: TestSet): Promise<void> {
    const { tenant, id, version } = set.metadata;
    const inserted = await withTenant(this.pool, tenant, (client) =>
      client.query(
        `insert into eval_test_sets (tenant, id, version, service, body) values ($1, $2, $3, $4, $5)
         on conflict (tenant, id, version) do nothing`,
        [tenant, id, version, set.spec.service ?? null, JSON.stringify(set)],
      ),
    );
    if ((inserted.rowCount ?? 0) === 0)
      throw new Error(`test set ${tenant}/${id} v${version} already exists`);
  }

  async get(tenant: string, id: string, version?: number): Promise<TestSet | undefined> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ body: TestSet }>(
        version === undefined
          ? 'select body from eval_test_sets where tenant = $1 and id = $2 order by version desc limit 1'
          : 'select body from eval_test_sets where tenant = $1 and id = $2 and version = $3',
        version === undefined ? [tenant, id] : [tenant, id, version],
      );
      return found.rows[0]?.body;
    });
  }

  async list(tenant: string, service?: string): Promise<TestSet[]> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ body: TestSet; service: string | null }>(
        `select * from (select distinct on (id) body, service, id from eval_test_sets
           where tenant = $1 order by id, version desc) latest
         where $2::text is null or service = $2 order by id collate "C"`,
        [tenant, service ?? null],
      );
      return found.rows.map((r) => r.body);
    });
  }
}

interface RunRow {
  tenant: string;
  task: string;
  service: string | null;
  subject: string | null;
  body: StoredRun['run'];
}

const toRun = (row: RunRow): StoredRun => ({
  run: row.body,
  tenant: row.tenant,
  task: row.task,
  ...(row.service === null ? {} : { service: row.service }),
  ...(row.subject === null ? {} : { subject: row.subject }),
});

export class PostgresEvalRunStore implements EvalRunStore {
  constructor(private readonly pool: Pool) {}

  async save(stored: StoredRun): Promise<void> {
    const { run } = stored;
    await withTenant(this.pool, stored.tenant, (client) =>
      client.query(
        `insert into eval_runs (id, tenant, task, service, subject, test_set, ended_at, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set task = excluded.task, service = excluded.service,
           subject = excluded.subject, test_set = excluded.test_set, ended_at = excluded.ended_at,
           body = excluded.body`,
        [
          run.id,
          stored.tenant,
          stored.task,
          stored.service ?? null,
          stored.subject ?? null,
          run.testSet.id,
          run.endedAt,
          JSON.stringify(run),
        ],
      ),
    );
  }

  async get(id: string): Promise<StoredRun | undefined> {
    const found = await withPlatformAccess(this.pool, 'eval-run-lookup', (client) =>
      client.query<RunRow>('select * from find_eval_run($1)', [id]),
    );
    const row = found.rows[0];
    return row && toRun(row);
  }

  async list(filter: RunFilter): Promise<StoredRun[]> {
    return withTenant(this.pool, filter.tenant, async (client) => {
      const found = await client.query<RunRow>(
        `select * from eval_runs where tenant = $1
           and ($2::text is null or service = $2)
           and ($3::text is null or subject = $3)
           and ($4::text is null or test_set = $4)
         order by ended_at desc`,
        [filter.tenant, filter.service ?? null, filter.subject ?? null, filter.testSet ?? null],
      );
      return found.rows.map(toRun);
    });
  }
}

export class PostgresFeedbackStore implements FeedbackStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async save(record: FeedbackRecord): Promise<void> {
    const key = await this.keys.get(record.tenant, FEEDBACK_SCOPE, true);
    if (!key) throw new Error('no content key');
    const body = seal(key, Buffer.from(JSON.stringify(record)), `feedback:${record.task}`);
    await withTenant(this.pool, record.tenant, (client) =>
      client.query(
        'insert into eval_feedback (tenant, task, rating, at, body) values ($1, $2, $3, $4, $5)',
        [record.tenant, record.task, record.rating, record.at, body],
      ),
    );
  }

  async list(
    tenant: string,
    filter: { task?: string; rating?: Feedback['rating'] } = {},
  ): Promise<FeedbackRecord[]> {
    const rows = await withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ task: string; body: Buffer }>(
        `select task, body from eval_feedback where tenant = $1
           and ($2::text is null or task = $2)
         order by at desc, seq desc`,
        [tenant, filter.task ?? null],
      );
      return found.rows;
    });
    const key = await this.keys.get(tenant, FEEDBACK_SCOPE, false);
    if (!key) return [];
    const records = rows.flatMap((row) => {
      try {
        return [
          JSON.parse(open(key, row.body, `feedback:${row.task}`).toString()) as FeedbackRecord,
        ];
      } catch {
        return [];
      }
    });
    // The latest per task and credential counts, so filter by rating only after that.
    return currentFeedback(records).filter(
      (r) => filter.rating === undefined || r.rating === filter.rating,
    );
  }
}

export class PostgresCandidateStore implements CandidateStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async save(candidate: TestCaseCandidate): Promise<void> {
    const key = await this.keys.get(candidate.tenant, FEEDBACK_SCOPE, true);
    if (!key) throw new Error('no content key');
    const body = seal(key, Buffer.from(JSON.stringify(candidate)), `candidate:${candidate.id}`);
    await withTenant(this.pool, candidate.tenant, (client) =>
      client.query(
        `insert into eval_candidates (id, tenant, status, proposed_at, body) values ($1, $2, $3, $4, $5)
         on conflict (id) do update set status = excluded.status, body = excluded.body`,
        [candidate.id, candidate.tenant, candidate.status, candidate.proposedAt, body],
      ),
    );
  }

  async get(id: string): Promise<TestCaseCandidate | undefined> {
    const found = await withPlatformAccess(this.pool, 'eval-candidate-lookup', (client) =>
      client.query<{ id: string; tenant: string; body: Buffer }>(
        'select id, tenant, body from find_eval_candidate($1)',
        [id],
      ),
    );
    const row = found.rows[0];
    return row && (await this.#decode(row.tenant, [row]))[0];
  }

  async list(tenant: string, status?: CandidateStatus): Promise<TestCaseCandidate[]> {
    const rows = await withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ id: string; body: Buffer }>(
        `select id, body from eval_candidates where tenant = $1
           and ($2::text is null or status = $2) order by proposed_at desc`,
        [tenant, status ?? null],
      );
      return found.rows;
    });
    return this.#decode(tenant, rows);
  }

  async #decode(tenant: string, rows: { id: string; body: Buffer }[]) {
    const key = await this.keys.get(tenant, FEEDBACK_SCOPE, false);
    if (!key) return [];
    return rows.flatMap((row) => {
      try {
        return [
          JSON.parse(open(key, row.body, `candidate:${row.id}`).toString()) as TestCaseCandidate,
        ];
      } catch {
        return [];
      }
    });
  }
}

export class PostgresLabelStore implements LabelStore {
  constructor(private readonly pool: Pool) {}

  async add(labels: JudgeLabel[]): Promise<void> {
    const parsed = labelFile.parse(labels);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const label of parsed)
        await client.query('insert into judge_labels (judge, label) values ($1, $2)', [
          label.judge,
          JSON.stringify(label),
        ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(judge?: string): Promise<JudgeLabel[]> {
    const found = await this.pool.query<{ label: JudgeLabel }>(
      'select label from judge_labels where $1::text is null or judge = $1 order by seq',
      [judge ?? null],
    );
    return found.rows.map((r) => r.label);
  }
}
