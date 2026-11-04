import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  tombstoneHash,
  type DatasetConfig,
  type DocumentRecords,
  type IndexDocument,
  type ListedDocument,
  type RunPlan,
} from '@genai/port-knowledge';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  attachGeneration,
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  prepareGeneration,
  setUpKnowledgeServer,
  type PgvectorDatasetOptions,
} from './index.js';
import { knowledgeRecordsOf } from './knowledge-records.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let worker: ReturnType<typeof openKnowledgePools>;
let owner: pg.Pool;
let records: DocumentRecords;

const dataset = (id: string): DatasetConfig<PgvectorDatasetOptions> => ({
  id,
  filters: {},
  options: {},
  embedding: { model: 'fake/embed', dimensions: 3 },
});

let generations = 0;
const freshGeneration = async (id: string) => {
  const generation = `g-records-${++generations}`;
  await prepareGeneration(owner, dataset(id), generation);
  await attachGeneration(owner, dataset(id), generation);
  return generation;
};

const listed = (id: string, sha256 = `${id}-1`): ListedDocument => ({
  id,
  record: { path: `/docs/${id}.md`, lastmod: '2026-11-03' },
  metadata: { path: `/docs/${id}.md` },
  files: [{ name: `${id}.md`, sha256 }],
});

const plan = (writes: RunPlan['writes'], process: string[] = []): RunPlan => ({
  writes,
  process,
  counts: { new: 0, changed: 0, deleted: 0, unchanged: 0 },
});

const newDocs = (...ids: string[]) =>
  plan(
    ids.map((id) => ({ kind: 'new' as const, listed: listed(id), metadataHash: `m-${id}` })),
    ids,
  );

const doc = (id: string, text = `Tekst om ${id}`): IndexDocument => ({
  id,
  title: `Tittel ${id}`,
  fields: {},
  chunks: [0, 1].map((position) => ({
    id: `${id}#${position}`,
    position,
    text: `${text} ${position}`,
    vector: [0.1, 0.2, 0.3 + position],
  })),
  phrases: [],
});

const noSend = async () => undefined;

const changes = async (name: string) =>
  (
    await admin.query<{ id: string; change: string }>(
      `select id, change::text from src_documents where dataset = $1 order by change`,
      [name],
    )
  ).rows.map((r) => [r.id, Number(r.change)]);

const dataVersion = async (generation: string) =>
  Number(
    (
      await admin.query<{ v: string }>(
        `select data_version::text as v from kn_generations where generation = $1`,
        [generation],
      )
    ).rows[0]?.v,
  );

const recordOf = async (name: string, id: string) => {
  const { rows } = await admin.query<{ number: string }>(
    `select number::text from src_documents where dataset = $1 and id = $2`,
    [name, id],
  );
  const found = await records.find(rows[0]?.number ?? '0');
  if (!found) throw new Error(`no record ${id}`);
  return found;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  worker = openKnowledgePools(
    {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  owner = worker.pools.owner as pg.Pool;
  await migrateKnowledgeServer(owner);
  records = knowledgeRecordsOf(worker.pools.writer as pg.Pool);
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await admin?.end();
  await stopPostgres(container);
});

describe('document records on the knowledge server', () => {
  it('each record change takes the next number in the change sequence', async () => {
    const name = 'digdir/sequence';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a', 'b') },
      noSend,
    );
    await records.apply(
      {
        dataset: name,
        pipeline: 'docs',
        generation,
        plan: plan([
          { kind: 'seen', id: 'a' },
          { kind: 'changed', listed: listed('b', 'b-2'), metadataHash: 'm-b' },
          { kind: 'new', listed: listed('c'), metadataHash: 'm-c' },
          { kind: 'delete', id: 'a' },
        ]),
      },
      noSend,
    );
    expect(await changes(name)).toEqual([
      ['b', 3],
      ['c', 4],
      ['a', 5],
    ]);
    const { rows } = await admin.query<{ last: string }>(
      `select last_change::text as last from src_changes where dataset = $1`,
      [name],
    );
    expect(rows[0]?.last).toBe('5');
  });

  it('an earlier id resolves to its document, for 377252', async () => {
    const name = 'digdir/earlier';
    const generation = await freshGeneration(name);
    const uuid = 'de77ffc7-1a57-456a-af49-167e699a4e6e';
    const kudos: ListedDocument = {
      id: `kudos:${uuid}`,
      record: { uuid },
      metadata: { uuid, title: 'Statusrapport' },
      files: [{ name: 'f1', sha256: 'aaa' }],
      earlierIds: ['377252'],
    };
    await records.apply(
      {
        dataset: name,
        pipeline: 'kudos',
        generation,
        plan: plan([{ kind: 'new', listed: kudos, metadataHash: 'm' }]),
      },
      noSend,
    );
    await records.replace(await recordOf(name, kudos.id), generation, {
      document: doc(kudos.id),
    });

    // A citation is resolved only inside a dataset the caller may read (ADR 0042).
    const client = await admin.connect();
    let rows: { cited: string; status: string; document: string }[];
    try {
      await client.query('begin');
      await client.query(`select set_config('app.datasets', $1, true)`, [JSON.stringify([name])]);
      ({ rows } = await client.query<{ cited: string; status: string; document: string }>(
        `select cited, status, document
           from kn_resolve_citation($1, $2, array['377252'], array[$3])`,
        [name, generation, tombstoneHash(name, '377252')],
      ));
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(rows).toEqual([{ cited: '377252', status: 'earlier', document: `kudos:${uuid}` }]);
  });

  it('sends the index job of every record to process in the transaction that writes it', async () => {
    const name = 'digdir/sends';
    const generation = await freshGeneration(name);
    const sent: string[] = [];
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a', 'b') },
      async (record, transaction) => {
        const { rows } = await transaction.query(`select id from src_documents where number = $1`, [
          record,
        ]);
        sent.push(String((rows[0] as { id: string }).id));
      },
    );
    expect(sent.sort()).toEqual(['a', 'b']);
    await expect(
      records.apply(
        { dataset: name, pipeline: 'docs', generation, plan: newDocs('x') },
        async () => {
          throw new Error('the queue refused');
        },
      ),
    ).rejects.toThrow('the queue refused');
    expect((await changes(name)).map(([id]) => id)).not.toContain('x');
  });

  it('the writer fills a standalone generation but cannot change its tables', async () => {
    const name = 'digdir/standalone';
    const generation = 'g-records-standalone';
    await prepareGeneration(owner, dataset(name), generation);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a', 'b') },
      noSend,
    );
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a') });
    await records.replace(await recordOf(name, 'b'), generation, { document: doc('b') });
    await records.remove(await recordOf(name, 'b'), generation);
    const { rows } = await admin.query<{ doc_id: string }>(
      `select distinct doc_id from ${partitionOf('kn_chunks', generation)} order by doc_id`,
    );
    expect(rows.map((r) => r.doc_id)).toEqual(['a']);
    const writer = worker.pools.writer as pg.Pool;
    for (const sql of [
      `alter table ${partitionOf('kn_chunks', generation)} add column extra text`,
      `drop table ${partitionOf('kn_docs', generation)}`,
      `create index on ${partitionOf('kn_chunks', generation)} (text)`,
    ])
      await expect(writer.query(sql)).rejects.toThrow(/must be owner|permission denied/);
    await attachGeneration(owner, dataset(name), generation);
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a', 'Ny') });
    const { rows: after } = await admin.query<{ text: string }>(
      `select text from kn_chunks where generation = $1 and doc_id = 'a' order by position`,
      [generation],
    );
    expect(after.map((r) => r.text)).toEqual(['Ny 0', 'Ny 1']);
  });

  it('a document is replaced in one transaction', async () => {
    const name = 'digdir/replace';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a') },
      noSend,
    );
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a', 'Gammel') });
    const fresh = doc('a', 'Ny');
    const [one, two] = fresh.chunks;
    if (!one || !two) throw new Error('two chunks');
    const broken = { ...fresh, chunks: [one, { ...two, id: one.id }] };
    await expect(
      records.replace(await recordOf(name, 'a'), generation, { document: broken }),
    ).rejects.toThrow();
    const { rows } = await admin.query<{ text: string }>(
      `select text from ${partitionOf('kn_chunks', generation)} where doc_id = 'a' order by position`,
    );
    expect(rows.map((r) => r.text)).toEqual(['Gammel 0', 'Gammel 1']);
  });

  it('the data version is the highest change below which every change is applied', async () => {
    const name = 'digdir/version';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a', 'b', 'c') },
      noSend,
    );
    await records.replace(await recordOf(name, 'b'), generation, { document: doc('b') });
    await records.replace(await recordOf(name, 'c'), generation, { document: doc('c') });
    expect(await dataVersion(generation)).toBe(0);
    await records.replace(await recordOf(name, 'a'), generation, { skip: 'no_text' });
    expect(await dataVersion(generation)).toBe(3);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: plan([{ kind: 'delete', id: 'b' }]) },
      noSend,
    );
    expect(await dataVersion(generation)).toBe(3);
    await records.remove(await recordOf(name, 'b'), generation);
    expect(await dataVersion(generation)).toBe(4);
  });

  it('a deleted document leaves only the hash of its id and the date', async () => {
    const name = 'digdir/tombstone';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a') },
      noSend,
    );
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a') });
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: plan([{ kind: 'delete', id: 'a' }]) },
      noSend,
    );
    await records.remove(await recordOf(name, 'a'), generation);
    const left = await admin.query(`select * from src_documents where dataset = $1`, [name]);
    expect(left.rows).toEqual([]);
    const docs = await admin.query(`select id from ${partitionOf('kn_docs', generation)}`);
    expect(docs.rows).toEqual([]);
    const { rows } = await admin.query(`select * from src_tombstones where dataset = $1`, [name]);
    expect(rows).toEqual([
      { dataset: name, id_hash: tombstoneHash(name, 'a'), deleted_on: expect.any(Date) },
    ]);
  });

  it('counts a 404 or 410 and marks the record deleted at the second', async () => {
    const name = 'digdir/gone';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'site', generation, plan: newDocs('p') },
      noSend,
    );
    const once = await records.gone(await recordOf(name, 'p'), 'run-1');
    expect(once).toMatchObject({ gone: 1, state: null, change: 1 });
    const twice = await records.gone(once, 'run-2');
    expect(twice).toMatchObject({ gone: 2, state: 'deleted', change: 2 });
  });

  it('a 404 delivered twice in one run counts once', async () => {
    const name = 'digdir/gone-once';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'site', generation, plan: newDocs('p') },
      noSend,
    );
    const once = await records.gone(await recordOf(name, 'p'), 'run-1');
    const again = await records.gone(once, 'run-1');
    expect(again).toMatchObject({ gone: 1, state: null });
    expect(await records.gone(again, 'run-2')).toMatchObject({ gone: 2, state: 'deleted' });
  });

  it('a stale index job changes nothing', async () => {
    const name = 'digdir/stale';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a') },
      noSend,
    );
    const old = await recordOf(name, 'a');
    await records.apply(
      {
        dataset: name,
        pipeline: 'docs',
        generation,
        plan: plan([{ kind: 'changed', listed: listed('a', 'a-2'), metadataHash: 'm-a' }]),
      },
      noSend,
    );
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a', 'Ny') });
    expect(await records.replace(old, generation, { document: doc('a', 'Gammel') })).toBe(false);
    const { rows } = await admin.query<{ text: string }>(
      `select text from ${partitionOf('kn_chunks', generation)} order by position`,
    );
    expect(rows.map((r) => r.text)).toEqual(['Ny 0', 'Ny 1']);
    expect(await dataVersion(generation)).toBe(2);
  });

  it('a document listed again is no longer withdrawn', async () => {
    const name = 'digdir/relisted';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a') },
      noSend,
    );
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: plan([{ kind: 'delete', id: 'a' }]) },
      noSend,
    );
    await records.remove(await recordOf(name, 'a'), generation);
    const tombstones = async () =>
      (await admin.query(`select 1 from src_tombstones where dataset = $1`, [name])).rows.length;
    expect(await tombstones()).toBe(1);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a') },
      noSend,
    );
    expect(await tombstones()).toBe(0);
  });

  it('a held record is checked without being written again', async () => {
    const name = 'digdir/checked';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'site', generation, plan: newDocs('p') },
      noSend,
    );
    const record = await recordOf(name, 'p');
    expect(await records.held(record, generation)).toBe(false);
    await records.replace(record, generation, { document: doc('p') });
    expect(await records.held(record, generation)).toBe(true);
    await admin.query(
      `update kn_applied set applied_at = now() - interval '8 days' where generation = $1`,
      [generation],
    );
    await records.touch(record, generation);
    const [owned] = await records.owned(name, 'site', generation);
    expect(Date.parse(owned?.appliedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(await dataVersion(generation)).toBe(1);
  });

  it('a changed chunking setting leaves the active generation unchanged', async () => {
    const name = 'digdir/chunking';
    const generation = await freshGeneration(name);
    const first = { minimumLength: 200, maximumLength: 4000 };
    expect(await records.chunking(generation, 'docs', first)).toEqual(first);
    expect(
      await records.chunking(generation, 'docs', { minimumLength: 200, maximumLength: 2000 }),
    ).toEqual(first);
  });

  it('lists the records a pipeline owns with the change its generation holds', async () => {
    const name = 'digdir/owned';
    const generation = await freshGeneration(name);
    await records.apply(
      { dataset: name, pipeline: 'docs', generation, plan: newDocs('a', 'b') },
      noSend,
    );
    await records.replace(await recordOf(name, 'a'), generation, { document: doc('a') });
    const owned = await records.owned(name, 'docs', generation);
    expect(owned.map((r) => [r.id, r.change, r.applied])).toEqual([
      ['a', 1, 1],
      ['b', 2, undefined],
    ]);
    expect(owned[0]?.files).toEqual([{ name: 'a.md', sha256: 'a-1' }]);
    expect(Date.parse(owned[0]?.appliedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(owned[1]?.appliedAt).toBeUndefined();
    expect(await records.owned(name, 'other', generation)).toEqual([]);
  });
});
