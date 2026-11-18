import { knowledgeFieldsQueue, type fieldFills, type Job } from '@genai/jobs';
import { fillInKudosFields, prepareKudosDoc, toIndexDocument } from '@genai/ingest';
import type { DatasetConfig, DocumentRecords, ListedDocument } from '@genai/port-knowledge';
import {
  attachGeneration,
  knowledgeRecordsOf,
  migrateKnowledgeServer,
  openKnowledgePools,
  prepareGeneration,
  setUpKnowledgeServer,
} from '@genai/providers-pgvector';
import { createPool } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldsWork } from './knowledge-fields.js';

type FieldFillName = (typeof fieldFills)[number];

let container: StartedPostgreSqlContainer;
let admin: ReturnType<typeof createPool>;
let knowledgeServer: ReturnType<typeof openKnowledgePools>;
let records: DocumentRecords;
const owner = () => knowledgeServer.pools.owner as ReturnType<typeof createPool>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = createPool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  knowledgeServer = openKnowledgePools(
    {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  await migrateKnowledgeServer(owner());
  records = knowledgeRecordsOf(
    knowledgeServer.pools.writer as Parameters<typeof knowledgeRecordsOf>[0],
  );
}, 120_000);

afterAll(async () => {
  await knowledgeServer?.close();
  await admin?.end();
  await stopPostgres(container);
});

const dataset = (id: string): DatasetConfig => ({
  id,
  filters: { owner_orgnr: 'multiselect', orgs_short: 'multiselect' },
  options: {},
  embedding: { model: 'fake/embed', dimensions: 3 },
});

/** A KUDOS listing entry, as the pipeline keeps it in `src_documents.record`. */
const kudosEntry = (
  uuid: string,
  ownerOrgnr: number,
  ownerName: string,
  abbreviation?: string,
) => ({
  uuid,
  title: `Årsrapport ${ownerName} 2025`,
  type: 'Årsrapport',
  publish_date: '2026-03-15',
  owners: [
    {
      org_number: ownerOrgnr,
      alternative_names: [
        { name: ownerName, type: 'display' },
        ...(abbreviation ? [{ name: abbreviation, type: 'abbreviation' }] : []),
      ],
    },
  ],
  recipients: [
    {
      org_number: 972417807,
      alternative_names: [{ name: 'Finansdepartementet', type: 'display' }],
    },
  ],
  publishers: [],
  files: [
    {
      uuid: `${uuid}-f`,
      url: `https://kudos.dfo.no/${uuid}.pdf`,
      sha256: `${uuid}-sha`,
      pages: 12,
    },
  ],
});

/**
 * The fields the ingest stores for an entry: today's, or as they were before org numbers and
 * abbreviations, and with or without the publisher and the report key, which came after them.
 */
const fieldsOf = (
  entry: ReturnType<typeof kudosEntry>,
  { before = false, publisher = true, report = true } = {},
) => {
  const fields = toIndexDocument(
    `kudos:${entry.uuid}`,
    prepareKudosDoc(fillInKudosFields(entry), 2),
    [],
    [],
  ).fields;
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([k]) =>
        !(before && (k === 'orgs_short' || k.endsWith('_orgnr'))) &&
        !(!report && k === 'report') &&
        !(!publisher && k === 'publisher_names'),
    ),
  );
};

let generations = 0;
const store = async (
  name: string,
  docs: {
    entry: ReturnType<typeof kudosEntry>;
    before: boolean;
    publisher?: boolean;
    report?: boolean;
  }[],
) => {
  const generation = `g-fields-job-${++generations}`;
  await prepareGeneration(owner(), dataset(name), generation);
  await attachGeneration(owner(), dataset(name), generation);
  const listed = docs.map(({ entry }): ListedDocument => ({
    id: `kudos:${entry.uuid}`,
    record: entry,
    metadata: { uuid: entry.uuid },
    files: [{ name: `${entry.uuid}.pdf`, sha256: `${entry.uuid}-sha` }],
  }));
  await records.apply(
    {
      dataset: name,
      pipeline: 'kudos',
      generation,
      plan: {
        writes: listed.map((l) => ({ kind: 'new' as const, listed: l, metadataHash: `m-${l.id}` })),
        process: listed.map((l) => l.id),
        counts: { new: listed.length, changed: 0, deleted: 0, unchanged: 0 },
      },
    },
    async () => undefined,
  );
  for (const { entry, before, publisher, report } of docs) {
    const { rows } = await admin.query<{ number: string }>(
      `select number::text from src_documents where dataset = $1 and id = $2`,
      [name, `kudos:${entry.uuid}`],
    );
    const record = await records.find(rows[0]?.number ?? '0');
    if (!record) throw new Error('no record');
    await records.replace(record, generation, {
      document: {
        id: record.id,
        title: entry.title,
        fields: fieldsOf(entry, {
          before,
          ...(publisher === undefined ? {} : { publisher }),
          ...(report === undefined ? {} : { report }),
        }),
        chunks: [{ id: `${record.id}#0`, position: 0, text: 'Tekst', vector: [0.1, 0.2, 0.3] }],
        phrases: [],
      },
    });
  }
  return generation;
};

const job = (data: Job<{ tenant: string; dataset: string; fill: FieldFillName }>['data']) =>
  ({
    id: crypto.randomUUID(),
    queue: knowledgeFieldsQueue.name,
    data,
    retryCount: 0,
    signal: new AbortController().signal,
  }) as Job<never>;

const row = async (generation: string, id: string) =>
  (
    await admin.query<{ fields: Record<string, unknown>; fields_text: string; url: string | null }>(
      `select fields, fields_text, url from kn_docs where generation = $1 and id = $2`,
      [generation, id],
    )
  ).rows[0];

describe('the fields job', () => {
  it('writes the same fields and fields_text as a fresh ingest of the document', async () => {
    const name = 'digdir/kudos-fields-a';
    const old = kudosEntry('a1', 991825827, 'Digitaliseringsdirektoratet');
    const fresh = { ...old, uuid: 'a2' };
    const generation = await store(name, [
      { entry: old, before: true, publisher: false },
      { entry: fresh, before: false },
    ]);

    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-links-and-abbreviations' }),
    );

    const backfilled = await row(generation, 'kudos:a1');
    const written = await row(generation, 'kudos:a2');
    expect(backfilled?.fields.owner_orgnr).toEqual(['991825827']);
    expect(backfilled?.fields.recipient_orgnr).toEqual(['972417807']);
    expect(backfilled?.fields).toEqual(written?.fields);
    expect(backfilled?.fields_text).toBe(written?.fields_text);
  });

  it("finds a KUDOS document by its owner's org number", async () => {
    const name = 'digdir/kudos-fields-b';
    const generation = await store(name, [
      { entry: kudosEntry('b1', 991825827, 'Digitaliseringsdirektoratet'), before: true },
      { entry: kudosEntry('b2', 972417904, 'Samferdselsdepartementet'), before: true },
    ]);
    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-org-numbers' }),
    );

    const client = await admin.connect();
    let found: string[];
    try {
      await client.query('begin');
      await client.query(`select set_config('app.datasets', $1, true)`, [JSON.stringify([name])]);
      const { rows } = await client.query<{ id: string }>(
        `select id from kn_documents($1, $2, null, $3::jsonb, 10, 0)`,
        [
          name,
          generation,
          JSON.stringify([{ field: 'owner_orgnr', op: 'in', values: ['991825827'] }]),
        ],
      );
      found = rows.map((r) => r.id);
    } finally {
      await client.query('rollback');
      client.release();
    }

    expect(found).toEqual(['kudos:b1']);
  });

  it("the fill writes a stored Kudos document's orgs_short and url without embedding anything", async () => {
    const name = 'digdir/kudos-fields-c';
    const generation = await store(name, [
      { entry: kudosEntry('c1', 991825827, 'Digitaliseringsdirektoratet', 'Digdir'), before: true },
    ]);
    const chunks = async () =>
      (
        await admin.query<{ id: string; vec: string; text: string }>(
          `select id, vec::text, text from kn_chunks where generation = $1 order by id`,
          [generation],
        )
      ).rows;
    const chunksBefore = await chunks();

    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-links-and-abbreviations' }),
    );

    const filled = await row(generation, 'kudos:c1');
    expect(filled?.fields.orgs_short).toEqual(['Digdir']);
    expect(filled?.url).toBe('https://kudos.dfo.no/dokument/c1');
    expect(await chunks()).toEqual(chunksBefore);
  });

  it("an orgs_short filter matches an organisation's abbreviation", async () => {
    const name = 'digdir/kudos-fields-d';
    const generation = await store(name, [
      { entry: kudosEntry('d1', 991825827, 'Digitaliseringsdirektoratet', 'Digdir'), before: true },
      { entry: kudosEntry('d2', 983744516, 'Folkehelseinstituttet', 'FHI'), before: true },
    ]);
    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-links-and-abbreviations' }),
    );

    const client = await admin.connect();
    let found: string[];
    try {
      await client.query('begin');
      await client.query(`select set_config('app.datasets', $1, true)`, [JSON.stringify([name])]);
      const { rows } = await client.query<{ id: string }>(
        `select id from kn_documents($1, $2, null, $3::jsonb, 10, 0)`,
        [name, generation, JSON.stringify([{ field: 'orgs_short', op: 'in', values: ['Digdir'] }])],
      );
      found = rows.map((r) => r.id);
    } finally {
      await client.query('rollback');
      client.release();
    }

    expect(found).toEqual(['kudos:d1']);
  });

  it('the links and abbreviations fill writes publisher_names on a stored Kudos document without embedding anything', async () => {
    const name = 'digdir/kudos-fields-e';
    const generation = await store(name, [
      {
        entry: kudosEntry('e1', 986252932, 'Direktoratet for forvaltning og økonomistyring'),
        before: true,
        publisher: false,
      },
    ]);
    const chunks = async () =>
      (
        await admin.query<{ id: string; vec: string; text: string }>(
          `select id, vec::text, text from kn_chunks where generation = $1 order by id`,
          [generation],
        )
      ).rows;
    const chunksBefore = await chunks();

    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-links-and-abbreviations' }),
    );

    expect((await row(generation, 'kudos:e1'))?.fields.publisher_names).toEqual([
      'Direktoratet for forvaltning og økonomistyring',
    ]);
    expect(await chunks()).toEqual(chunksBefore);
  });

  it("the report keys fill writes a stored Kudos document's report key without embedding anything", async () => {
    const name = 'digdir/kudos-fields-f';
    const generation = await store(name, [
      { entry: kudosEntry('f1', 983544622, 'Helsedirektoratet'), before: false, report: false },
    ]);
    const chunks = async () =>
      (
        await admin.query<{ id: string; vec: string; text: string }>(
          `select id, vec::text, text from kn_chunks where generation = $1 order by id`,
          [generation],
        )
      ).rows;
    const chunksBefore = await chunks();

    const before = await row(generation, 'kudos:f1');
    expect(before?.fields).not.toHaveProperty('report');

    await fieldsWork({ records }).handler(
      job({ tenant: 'platform', dataset: name, fill: 'kudos-report-keys' }),
    );

    const filled = await row(generation, 'kudos:f1');
    expect(filled?.fields.report).toEqual({
      key: 'årsrapport|983544622|p2026|årsrapport helsedirektoratet 2025',
      own: true,
      pages: 12,
    });
    expect(filled?.fields_text).toBe(before?.fields_text);
    expect(await chunks()).toEqual(chunksBefore);
  });
});
