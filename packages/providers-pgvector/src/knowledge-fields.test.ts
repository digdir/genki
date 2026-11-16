import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  copyOwner,
  GenerationBusy,
  type DatasetConfig,
  type DocumentRecords,
  type IndexDocument,
  type ListedDocument,
  type RunPlan,
  type StoredDocument,
} from '@genai/port-knowledge';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  attachGeneration,
  migrateKnowledgeServer,
  openKnowledgePools,
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
  const generation = `g-fields-${++generations}`;
  await prepareGeneration(owner, dataset(id), generation);
  await attachGeneration(owner, dataset(id), generation);
  return generation;
};

/** A KUDOS listing entry as the pipeline stores it in `src_documents.record`. */
const listed = (id: string, ownerOrgnr: number): ListedDocument => ({
  id,
  record: {
    uuid: id,
    title: `Årsrapport ${id}`,
    owners: [{ org_number: ownerOrgnr, alternative_names: [{ name: 'Etaten', type: 'display' }] }],
  },
  metadata: { uuid: id },
  files: [{ name: `${id}.pdf`, sha256: `${id}-1` }],
});

const plan = (docs: ListedDocument[]): RunPlan => ({
  writes: docs.map((l) => ({ kind: 'new' as const, listed: l, metadataHash: `m-${l.id}` })),
  process: docs.map((l) => l.id),
  counts: { new: docs.length, changed: 0, deleted: 0, unchanged: 0 },
});

/** The document as the pipeline wrote it before org numbers were stored. */
const doc = (id: string): IndexDocument => ({
  id,
  title: `Årsrapport ${id}`,
  fields: { type: ['Årsrapport'], orgs_long: ['Etaten'], total_chunks: 2 },
  chunks: [0, 1].map((position) => ({
    id: `${id}#${position}`,
    position,
    text: `Tekst ${position}`,
    vector: [0.1, 0.2, 0.3 + position],
  })),
  phrases: [],
});

/** A fill that adds the owner's org numbers after `orgs_long`, as a fresh write would order them. */
const withOwners = (stored: StoredDocument) => {
  const owners = ((stored.record.owners ?? []) as { org_number?: number }[]).flatMap((o) =>
    o.org_number ? [String(o.org_number)] : [],
  );
  const { type, orgs_long, ...rest } = stored.fields;
  return { type, orgs_long, ...(owners.length ? { owner_orgnr: owners } : {}), ...rest };
};

const noSend = async () => undefined;

const ingest = async (name: string, generationsOf: string[], docs: ListedDocument[]) => {
  await records.apply(
    { dataset: name, pipeline: 'kudos', generation: generationsOf[0] ?? '', plan: plan(docs) },
    noSend,
  );
  for (const l of docs) {
    const { rows } = await admin.query<{ number: string }>(
      `select number::text from src_documents where dataset = $1 and id = $2`,
      [name, l.id],
    );
    const record = await records.find(rows[0]?.number ?? '0');
    if (!record) throw new Error(`no record ${l.id}`);
    for (const g of generationsOf) await records.replace(record, g, { document: doc(l.id) });
  }
};

const docRow = async (generation: string, id: string) =>
  (
    await admin.query<{ fields: Record<string, unknown>; fields_text: string }>(
      `select fields, fields_text from kn_docs where generation = $1 and id = $2`,
      [generation, id],
    )
  ).rows[0];

const chunkRows = async (generation: string, id: string) =>
  (
    await admin.query<{ id: string; vec: string; text: string }>(
      `select id, vec::text, text from kn_chunks where generation = $1 and doc_id = $2 order by id`,
      [generation, id],
    )
  ).rows;

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

describe('refreshing document fields', () => {
  it('backfills owner and recipient org numbers from the stored KUDOS record without embedding anything', async () => {
    const name = 'digdir/fields-a';
    const g = await freshGeneration(name);
    await ingest(name, [g], [listed('a', 991825827)]);
    const chunksBefore = await chunkRows(g, 'a');

    const result = await records.refreshFields(name, withOwners);

    expect(result).toEqual({ generations: 1, updated: 1, unchanged: 0, copied: 0 });
    expect((await docRow(g, 'a'))?.fields.owner_orgnr).toEqual(['991825827']);
    expect(await chunkRows(g, 'a')).toEqual(chunksBefore);
  });

  it('backfills every generation that holds the dataset', async () => {
    const name = 'digdir/fields-b';
    const first = await freshGeneration(name);
    const second = await freshGeneration(name);
    await ingest(name, [first, second], [listed('b', 974761076)]);

    await records.refreshFields(name, withOwners);

    expect((await docRow(first, 'b'))?.fields.owner_orgnr).toEqual(['974761076']);
    expect((await docRow(second, 'b'))?.fields.owner_orgnr).toEqual(['974761076']);
  });

  it('writes the same fields and fields_text as a fresh write of the same fields', async () => {
    const name = 'digdir/fields-c';
    const g = await freshGeneration(name);
    await ingest(name, [g], [listed('c', 986252932), listed('fresh', 986252932)]);
    const { rows } = await admin.query<{ number: string }>(
      `select number::text from src_documents where dataset = $1 and id = 'fresh'`,
      [name],
    );
    const fresh = await records.find(rows[0]?.number ?? '0');
    const fields = withOwners({
      id: 'fresh',
      record: fresh?.record ?? {},
      fields: doc('fresh').fields,
    });
    if (fresh) await records.replace(fresh, g, { document: { ...doc('fresh'), fields } });

    await records.refreshFields(name, withOwners);

    const backfilled = await docRow(g, 'c');
    const written = await docRow(g, 'fresh');
    expect(backfilled?.fields).toEqual(written?.fields);
    expect(backfilled?.fields_text).toBe(written?.fields_text);
  });

  it('records the backfill in the change sequence under the write lock', async () => {
    const name = 'digdir/fields-d';
    const g = await freshGeneration(name);
    await ingest(name, [g], [listed('d', 991825827)]);
    const change = async () =>
      Number(
        (
          await admin.query<{ change: string }>(
            `select change::text from src_documents where dataset = $1 and id = 'd'`,
            [name],
          )
        ).rows[0]?.change,
      );
    const before = await change();

    const vacuum = await admin.connect();
    await vacuum.query('begin');
    await vacuum.query(`select pg_advisory_xact_lock(1802398464, hashtext($1))`, [g]);
    const busy = await records.refreshFields(name, withOwners).catch((e: unknown) => e);
    await vacuum.query('rollback');
    vacuum.release();
    const whileBusy = await docRow(g, 'd');

    await records.refreshFields(name, withOwners);
    const after = await change();
    const applied = await admin.query<{ change: string }>(
      `select change::text from kn_applied where generation = $1 and id = 'd'`,
      [g],
    );
    const version = await admin.query<{ v: string; last: string }>(
      `select g.data_version::text as v, c.last_change::text as last
         from kn_generations g join src_changes c on c.dataset = g.dataset where g.generation = $1`,
      [g],
    );

    expect(busy).toBeInstanceOf(GenerationBusy);
    expect(whileBusy?.fields).not.toHaveProperty('owner_orgnr');
    expect(after).toBeGreaterThan(before);
    expect(Number(applied.rows[0]?.change)).toBe(after);
    expect(version.rows[0]?.v).toBe(version.rows[0]?.last);
  });

  it('leaves a copied record to the next pipeline run, and counts it', async () => {
    const name = 'digdir/fields-e';
    const g = await freshGeneration(name);
    await ingest(name, [g], [listed('e', 991825827)]);
    await admin.query(`update src_documents set owners = array[$2] where dataset = $1`, [
      name,
      copyOwner,
    ]);

    const result = await records.refreshFields(name, withOwners);

    expect(result.copied).toBe(1);
    expect(result.updated).toBe(0);
    expect((await docRow(g, 'e'))?.fields).not.toHaveProperty('owner_orgnr');
  });

  it('skips every unchanged document on the next pipeline run after the backfill', async () => {
    const name = 'digdir/fields-f';
    const g = await freshGeneration(name);
    await ingest(name, [g], [listed('f', 991825827), listed('g', 974761076)]);

    await records.refreshFields(name, withOwners);
    const again = await records.refreshFields(name, withOwners);
    const owned = await records.owned(name, 'kudos', g);

    // A run processes a record only when the generation's applied change is not its change.
    expect(owned.map((o) => o.applied === o.change)).toEqual([true, true]);
    expect(again).toEqual({ generations: 1, updated: 0, unchanged: 2, copied: 0 });
  });
});
