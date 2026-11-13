import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  knowledgeListingOf,
  onePage,
  pipelineSpec,
  type DocumentConverter,
  type PipelineSpec,
} from '@genai/ingest';
import {
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeServerQueues,
  type Job,
  type JobData,
  type QueueDefinition,
  type QueueWork,
} from '@genai/jobs';
import {
  InMemoryNativeOutputContainer,
  nativeOutputEntry,
  nativeOutputStore,
} from '@genai/port-blob';
import type { EmbeddingPort } from '@genai/port-embedding';
import { conversionKey, type DatasetConfig, type StoredConversions } from '@genai/port-knowledge';
import { createLocalConverter, UnsupportedDocumentError } from '@genai/providers-documents';
import {
  attachGeneration,
  knowledgeConversionsOf,
  knowledgeRecordsOf,
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  prepareGeneration,
  setUpKnowledgeServer,
} from '@genai/providers-pgvector';
import { installJobQueue, PgBossJobQueue, PgBossRunJobs } from '@genai/providers-pgboss';
import {
  createPool,
  createPostgresStores,
  ingestSender,
  LocalKeyWrapper,
  PostgresJobRunRecords,
  workerRole,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowledgeWork } from './knowledge-handlers.js';
import { conversionRunJobs } from './knowledge-jobs.js';

const ORG = '991825827';
const OTHER_ORG = '974760673';
const signal = new AbortController().signal;
const encoder = new TextEncoder();

/** A PDF with a text layer: one array of lines per page, an empty array for a page with none. */
const pdfBytes = (pages: string[][]) => {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) + 1;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const pagesId = 2 + pages.length * 2 + 1;
  for (const lines of pages) {
    const ops = lines.length
      ? `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`
      : '0 0 m 200 200 l S';
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  const all = [`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, ...objects];
  let out = '%PDF-1.4\n';
  const offsets = all.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
};

/** A two-page report, unique per test, since stored conversions are shared across datasets. */
const reportOf = (tag: string) =>
  pdfBytes([
    ['Arsrapport 2025', `Direktoratet leverte alle mal i fjor (${tag}).`],
    ['Budsjettet okte med ti prosent og gikk til fellesloesninger.'],
  ]);
const scan = pdfBytes([[], []]);

let platformContainer: StartedPostgreSqlContainer;
let knowledgeContainer: StartedPostgreSqlContainer;
let platform: Awaited<ReturnType<typeof createPostgresStores>>;
let workerStores: Awaited<ReturnType<typeof createPostgresStores>>;
type Pool = ReturnType<typeof createPool>;
let admin: Pool;
let knowledgeServer: ReturnType<typeof openKnowledgePools>;
let knowledgeQueue: PgBossJobQueue;
let runRecords: PostgresJobRunRecords;
let conversions: StoredConversions;
let queues: QueueDefinition[];
let folderRoot: string;

const owner = () => knowledgeServer.pools.owner as Pool;
const writer = () => knowledgeServer.pools.writer as Pool;
const convertQueue = () => queues.find((q) => q.name === 'knowledge.convert') as QueueDefinition;

beforeAll(async () => {
  [platformContainer, knowledgeContainer] = await Promise.all([
    new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start(),
    new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start(),
  ]);
  const wrapper = new LocalKeyWrapper(randomBytes(32));
  platform = await createPostgresStores(
    { connectionString: platformContainer.getConnectionUri() },
    wrapper,
  );
  workerStores = await createPostgresStores(
    { connectionString: platformContainer.getConnectionUri() },
    wrapper,
    { role: workerRole },
  );
  admin = createPool({ connectionString: knowledgeContainer.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  knowledgeServer = openKnowledgePools(
    {
      host: knowledgeContainer.getHost(),
      port: knowledgeContainer.getPort(),
      database: knowledgeContainer.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  await migrateKnowledgeServer(owner());
  // Without retries, so a failed conversion is a dead letter at once.
  queues = knowledgeServerQueues(60_000).map((q) => ({ ...q, retryLimit: 0 }));
  await installJobQueue(owner(), queues, { worker: 'genai_knowledge_writer' });
  knowledgeQueue = await PgBossJobQueue.start(writer(), { works: true });
  runRecords = new PostgresJobRunRecords(
    workerStores.runtimePool,
    ingestSender({ send: async () => null }),
  );
  conversions = knowledgeConversionsOf(writer());
  folderRoot = await mkdtemp(join(tmpdir(), 'knowledge-conversions-'));
}, 240_000);

afterAll(async () => {
  await knowledgeQueue?.stop();
  await knowledgeServer?.close();
  await admin?.end();
  for (const db of [platform, workerStores]) {
    await db?.close();
    await db?.runtimePool.end();
    await db?.pool.end();
  }
  await stopPostgres(platformContainer);
  await stopPostgres(knowledgeContainer);
});

let datasets = 0;

interface ScenarioOptions {
  tenant?: string;
  /** The converter convert jobs run; the text layer when left out. */
  converter?: DocumentConverter;
  nativeOutputs?: Parameters<typeof knowledgeWork>[0]['nativeOutputs'];
  lockdown?: boolean;
}

/** A folder dataset on the knowledge database whose worker stores conversions. */
const scenario = async (options: ScenarioOptions = {}) => {
  datasets += 1;
  const tenant = options.tenant ?? ORG;
  const dataset: DatasetConfig = {
    id: `${tenant}/konv-${datasets}`,
    filters: {},
    options: {},
    generation: `g-conversions-${datasets}`,
    embedding: { model: 'fake/embed', dimensions: 3 },
  };
  await prepareGeneration(owner(), dataset, dataset.generation as string);
  await attachGeneration(owner(), dataset, dataset.generation as string);
  const folder = `konv-${datasets}`;
  await mkdir(join(folderRoot, folder));
  const spec = pipelineSpec.parse({
    name: 'Docs',
    source: { kind: 'folder', path: folder, include: ['**/*.pdf', '**/*.md'] },
    chunking: { minimumLength: 1 },
  });
  const textLayer = createLocalConverter();
  const converted: string[] = [];
  const converter: DocumentConverter = options.converter ?? {
    extensions: textLayer.extensions ?? [],
    convert: async (file) => {
      converted.push(file.name);
      return textLayer.convert(file);
    },
  };
  const sent: { queue: string; data: Record<string, string> }[] = [];
  const work = knowledgeWork({
    records: knowledgeRecordsOf(writer()),
    conversions,
    converter,
    ...(options.nativeOutputs ? { nativeOutputs: options.nativeOutputs } : {}),
    knowledge: {
      send: async (queue, data, sendOptions) => {
        const id = await knowledgeQueue.send(queue, data, sendOptions);
        if (id) sent.push({ queue: queue.name, data: data as Record<string, string> });
        return id;
      },
      sendAgain: async () => undefined,
      serveAlso: (queue, key, t, o) => knowledgeQueue.serveAlso(queue, key, t, o),
    },
    heavy: { threshold: () => 100_000, window: () => '01:00-06:00' },
    runs: runRecords,
    pipeline: async () => spec,
    dataset: (id) => (id === dataset.id ? dataset : undefined),
    listingOf: (pipeline: PipelineSpec, scope, s, c) =>
      knowledgeListingOf(pipeline, { folderRoot, converter: c ?? converter }, scope, s),
    embedder: () =>
      ({
        info: () => ({ id: 'fake/embed', dimensions: 3 }),
        embed: async (texts: string[]) => ({ vectors: texts.map(() => [0.5, 0.5, 0.5]) }),
      }) as unknown as EmbeddingPort,
    admission: {
      records: runRecords,
      platformTenant: ORG,
      lockdown: options.lockdown ?? false,
    },
  });
  const file = (name: string, bytes: Uint8Array | string) =>
    writeFile(join(folderRoot, folder, name), bytes);
  const move = (from: string, to: string) =>
    rename(join(folderRoot, folder, from), join(folderRoot, folder, to));
  const remove = (name: string) => rm(join(folderRoot, folder, name));
  return {
    dataset,
    tenant,
    generation: dataset.generation as string,
    work,
    sent,
    converted,
    file,
    move,
    remove,
  };
};

type Scenario = Awaited<ReturnType<typeof scenario>>;

const startRun = async (s: Scenario, admittedAt = new Date()) => {
  const id = crypto.randomUUID();
  await platform.pool.query(
    `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
       status, started_by, started_at, runs_as_jobs, admitted_at)
     values ($1, $2, $3, 'docs', 1, 'index-writer', 'running', 'test', $4, true, $5)`,
    [id, s.tenant, s.dataset.id, new Date().toISOString(), admittedAt.toISOString()],
  );
  return id;
};

const job = <T extends JobData>(queue: string, data: T): Job<T> => ({
  id: crypto.randomUUID(),
  queue,
  data,
  retryCount: 0,
  signal,
});

const handler = (work: QueueWork[], queue: string) => {
  const found = work.find((w) => w.queue.name === queue);
  if (!found) throw new Error(`no handler for ${queue}`);
  return found.handler;
};

/** Which scenario's worker handles a run's jobs: an index job goes to its own dataset's. */
const runOwners = new Map<string, Scenario>();

/** A run's ingest job only: the convert and index jobs it sent. */
const ingest = async (s: Scenario, admittedAt?: Date) => {
  const run = await startRun(s, admittedAt);
  runOwners.set(run, s);
  const before = s.sent.length;
  await handler(
    s.work.platform,
    knowledgeIngestQueue.name,
  )(job(knowledgeIngestQueue.name, { run, tenant: s.tenant }));
  return { run, sent: s.sent.slice(before) };
};

/** Ends a run as the reconciler would once its jobs have ended. */
const endRun = async (run: string) => {
  const record = await runRecords.find(run);
  if (record)
    await runRecords.end(
      record,
      { status: 'succeeded', report: { failedDocuments: 0 } },
      new Date().toISOString(),
      { expiredError: 'expired' },
    );
};

/** Works the jobs a scenario sent, convert and index, until none is left. */
const drain = async (...scenarios: Scenario[]) => {
  const done = new Set<object>();
  for (;;) {
    const next = scenarios.flatMap((s) =>
      s.sent.filter((j) => !done.has(j)).map((j) => ({ s, j })),
    );
    if (next.length === 0) return;
    for (const { s, j } of next) {
      done.add(j);
      const owner = (j.data.run && runOwners.get(j.data.run)) || s;
      await handler(owner.work.knowledge, j.queue)(job(j.queue, j.data));
    }
  }
};

/** Pending convert jobs as pg-boss holds them. */
const convertJobs = async () =>
  (
    await admin.query<{ state: string; data: Record<string, string>; singleton_key: string }>(
      `select state, data, singleton_key from pgboss.job where name = 'knowledge.convert'
        and state in ('created', 'retry', 'active') order by created_on`,
    )
  ).rows;

const clearConvertJobs = () =>
  admin.query(`delete from pgboss.job where name like 'knowledge.convert%'`);

const chunks = async (generation: string) =>
  (
    await admin.query<{
      doc_id: string;
      file: string | null;
      file_sha256: string | null;
      page_from: number | null;
      page_to: number | null;
      text: string;
    }>(
      `select doc_id, file, file_sha256, page_from, page_to, text
         from ${partitionOf('kn_chunks', generation)} order by position`,
    )
  ).rows;

const stored = async (sha256?: string) =>
  (
    await admin.query<{
      sha256: string;
      converter: string;
      version: string;
      settings: Record<string, unknown>;
      derivation: string;
      derivation_version: number;
      pages: string[];
      output_path: string | null;
    }>(
      `select sha256, converter, version, settings, derivation, derivation_version, pages, output_path
         from src_conversions ${sha256 ? 'where sha256 = $1' : ''} order by created_at`,
      sha256 ? [sha256] : [],
    )
  ).rows;

const sha = async (bytes: Uint8Array) =>
  (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');

/** The dead letters of the convert queue an organisation's console would read. */
const deadLettersFor = async (tenant: string) => {
  const client = await writer().connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.platform_access', 'console jobs', true)`);
    const dead = await knowledgeQueue.deadLetters(convertQueue(), { tenant, transaction: client });
    await client.query('commit');
    return dead;
  } finally {
    client.release();
  }
};

const runJobs = () =>
  conversionRunJobs(new PgBossRunJobs(writer(), knowledgeQueue, queues), conversions);

describe('stored conversions', () => {
  it('a conversion is stored per page under its converter, version, settings and derivation', async () => {
    await clearConvertJobs();
    const report = reportOf('t1');
    const s = await scenario();
    await s.file('rapport.pdf', report);
    await ingest(s);
    await drain(s);

    expect(await stored(await sha(report))).toEqual([
      {
        sha256: await sha(report),
        converter: 'text-layer',
        version: '1',
        settings: {},
        derivation: 'text-layer',
        derivation_version: 1,
        pages: [
          'Arsrapport 2025\nDirektoratet leverte alle mal i fjor (t1).',
          'Budsjettet okte med ti prosent og gikk til fellesloesninger.',
        ],
        output_path: null,
      },
    ]);
  }, 60_000);

  it('without a Docling host, PDFs use the text layer', async () => {
    await clearConvertJobs();
    const s = await scenario();
    const pdf = pdfBytes([['Tildelingsbrev', 'Midler til skyplattformen.']]);
    await s.file('brev.pdf', pdf);
    await ingest(s);
    await drain(s);

    expect(s.converted).toEqual(['brev.pdf']);
    expect((await stored(await sha(pdf)))[0]?.converter).toBe('text-layer');
    expect((await chunks(s.generation)).map((c) => c.text).join(' ')).toContain(
      'Midler til skyplattformen.',
    );
  }, 60_000);

  it('every chunk carries its document, file and page', async () => {
    await clearConvertJobs();
    const report = reportOf('t3');
    const s = await scenario();
    await s.file('rapport.pdf', report);
    await ingest(s);
    await drain(s);

    const rows = await chunks(s.generation);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.doc_id).toMatch(/^folder:/);
      expect(row).toMatchObject({ file: 'rapport.pdf', file_sha256: await sha(report) });
      expect(row.page_from).toBeGreaterThanOrEqual(1);
      expect(row.page_to).toBeGreaterThanOrEqual(row.page_from as number);
    }
    expect(rows.map((r) => r.page_to)).toContain(2);
  }, 60_000);

  it('a kept conversion is never converted again', async () => {
    await clearConvertJobs();
    const report = reportOf('t4');
    const s = await scenario();
    await s.file('rapport.pdf', report);
    const first = await ingest(s);
    await drain(s);
    await endRun(first.run);
    // The same file under a new name is a new document with the same sha256.
    await s.move('rapport.pdf', 'arsrapport-2025.pdf');
    const second = await ingest(s);
    await drain(s);

    expect(s.converted).toEqual(['rapport.pdf']);
    expect(second.sent.map((j) => j.queue)).toEqual(['knowledge.index']);
    expect((await chunks(s.generation)).map((c) => c.file)).toContain('arsrapport-2025.pdf');
  }, 60_000);

  it('the same file in two datasets is converted once', async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario({ tenant: OTHER_ORG });
    const pdf = pdfBytes([['Felles rapport om fellesloesninger.']]);
    await a.file('felles.pdf', pdf);
    await b.file('felles.pdf', pdf);
    await ingest(a);
    await ingest(b);
    await drain(a, b);

    expect([...a.converted, ...b.converted]).toEqual(['felles.pdf']);
    expect(await chunks(a.generation)).not.toEqual([]);
    expect(await chunks(b.generation)).not.toEqual([]);
  }, 60_000);

  it('a file is never converted twice at once', async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    const pdf = pdfBytes([['Samtidig konvertering.']]);
    await a.file('samtidig.pdf', pdf);
    await b.file('samtidig.pdf', pdf);
    const first = await ingest(a);
    const second = await ingest(b);

    expect(first.sent.map((j) => j.queue)).toEqual(['knowledge.convert']);
    expect(second.sent).toEqual([]);
    expect(await convertJobs()).toHaveLength(1);
  }, 60_000);

  it("a record waiting on another run's conversion keeps its run open, and a finished conversion sends index jobs for every waiting record", async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    const pdf = pdfBytes([['Venter pa konvertering.']]);
    await a.file('venter.pdf', pdf);
    await b.file('venter.pdf', pdf);
    const first = await ingest(a);
    const second = await ingest(b);
    const jobs = runJobs();

    // Run B sent no job of its own, but its record waits on run A's conversion.
    expect(second.sent).toEqual([]);
    expect(await jobs.open(second.run)).toBeGreaterThan(0);

    const [convert] = first.sent;
    await handler(
      a.work.knowledge,
      'knowledge.convert',
    )(job('knowledge.convert', convert?.data ?? {}));
    const indexed = [...a.sent, ...b.sent].filter((j) => j.queue === 'knowledge.index');
    expect(indexed.map((j) => j.data.run).sort()).toEqual([first.run, second.run].sort());
  }, 60_000);

  it('cancelling a run cancels its queued jobs and leaves a conversion another run waits on', async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    const pdf = pdfBytes([['Delt konvertering som overlever.']]);
    await a.file('a-navn.pdf', pdf);
    await b.file('b-navn.pdf', pdf);
    const first = await ingest(a);
    const second = await ingest(b);
    const jobs = runJobs();

    await jobs.cancel(first.run);
    const kept = await convertJobs();
    expect(kept).toHaveLength(1);
    // The conversion is handed to the run that still waits on it, so the cancelled run can end.
    expect(kept[0]?.data).toMatchObject({ run: second.run, dataset: b.dataset.id });
    expect(await jobs.open(second.run)).toBeGreaterThan(0);
    expect(await jobs.open(first.run)).toBe(0);

    // The handed-over job fetches the waiting run's own file and sends its index job.
    const before = b.sent.length;
    await handler(
      b.work.knowledge,
      'knowledge.convert',
    )(job('knowledge.convert', kept[0]?.data ?? {}));
    expect(b.converted).toEqual(['b-navn.pdf']);
    expect(b.sent.slice(before).map((j) => j.data.run)).toEqual([second.run]);
  }, 60_000);

  it('cancelling the last run waiting on a conversion cancels it', async () => {
    await clearConvertJobs();
    const a = await scenario();
    await a.file('alene.pdf', pdfBytes([['Ingen andre venter.']]));
    const first = await ingest(a);

    await runJobs().cancel(first.run);
    expect(await convertJobs()).toEqual([]);
  }, 60_000);

  it("a shared conversion's dead letter is shown to every organisation waiting on it", async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario({ tenant: OTHER_ORG });
    const pdf = pdfBytes([['Konvertering som feiler.']]);
    await a.file('feiler.pdf', pdf);
    await b.file('feiler.pdf', pdf);
    await ingest(a);
    await ingest(b);
    const stop = await knowledgeQueue.work(convertQueue(), async () => {
      throw new Error('the converter host went away');
    });
    try {
      await expect
        .poll(async () => (await deadLettersFor(OTHER_ORG)).length, {
          timeout: 30_000,
        })
        .toBe(1);
    } finally {
      await stop();
    }
    // Each organisation sees the file it waits on, and nothing of who else waits.
    const [theirs] = await deadLettersFor(OTHER_ORG);
    expect(theirs?.data).toEqual({ tenant: OTHER_ORG, file: await sha(pdf) });
    expect(JSON.stringify(theirs)).not.toContain(ORG);
    const [ours] = await deadLettersFor(ORG);
    expect(ours?.data).not.toHaveProperty('tenants');
    expect(await deadLettersFor('123456785')).toEqual([]);
  }, 60_000);

  it("another organisation never sees a shared conversion's error, and its sender's error names no file", async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario({ tenant: OTHER_ORG });
    const pdf = pdfBytes([['Lonnsoversikt som forsvinner.']]);
    await a.file('ansatte-lonn-2025.pdf', pdf);
    await b.file('ansatte-lonn-2025.pdf', pdf);
    await ingest(a);
    await ingest(b);
    // The sender's file is gone when its convert job fetches it: a real error, naming its path.
    await a.remove('ansatte-lonn-2025.pdf');
    const convert = handler(a.work.knowledge, 'knowledge.convert');
    const stop = await knowledgeQueue.work(convertQueue(), (j) => convert(j));
    try {
      await expect
        .poll(async () => (await deadLettersFor(OTHER_ORG)).length, { timeout: 30_000 })
        .toBe(1);
    } finally {
      await stop();
    }
    const [theirs] = await deadLettersFor(OTHER_ORG);
    expect(theirs?.error ?? null).toBeNull();
    const [ours] = await deadLettersFor(ORG);
    expect(ours?.error).toBeTruthy();
    expect(ours?.error).not.toContain('lonn');
    expect(ours?.error).not.toContain(a.dataset.id);
  }, 60_000);

  it('an error the converter does not name is retried and then dead-lettered, not stored', async () => {
    // A plain error and a bug: neither says the file is too large or of a type the converter does
    // not read.
    const failures: { name: string; bytes: Uint8Array; convert: DocumentConverter['convert'] }[] = [
      {
        name: 'feil.pdf',
        bytes: pdfBytes([['Omformeren gir opp.']]),
        convert: async () => {
          throw new Error('the converter gave up');
        },
      },
      {
        name: 'bug.pdf',
        bytes: pdfBytes([['En feil i koden.']]),
        convert: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'pages')");
        },
      },
    ];
    for (const { name, bytes, convert } of failures) {
      await clearConvertJobs();
      const s = await scenario({ converter: { extensions: ['.pdf'], convert } });
      await s.file(name, bytes);
      const { sent } = await ingest(s);
      const convertJob = handler(s.work.knowledge, 'knowledge.convert');
      // Thrown, so the queue tries the job again.
      await expect(convertJob(job('knowledge.convert', sent[0]?.data ?? {}))).rejects.toThrow();
      expect(await stored(await sha(bytes))).toEqual([]);
      // Once its retries are used up, the job is a dead letter its organisation sees.
      const stop = await knowledgeQueue.work(convertQueue(), (j) => convertJob(j));
      try {
        await expect
          .poll(async () => (await deadLettersFor(ORG)).length, { timeout: 30_000 })
          .toBe(1);
      } finally {
        await stop();
      }
      expect(await stored(await sha(bytes))).toEqual([]);
    }
  }, 120_000);

  /** Converts each file in one dataset, then lists it in another: stored once as its failure. */
  const storedOnceAsFailure = async (
    cases: { name: string; bytes: Uint8Array; converter: DocumentConverter; reason: string }[],
  ) => {
    for (const { name, bytes, converter, reason } of cases) {
      await clearConvertJobs();
      const converted: string[] = [];
      const counting: DocumentConverter = {
        extensions: ['.pdf'],
        convert: async (file) => {
          converted.push(file.name);
          return converter.convert(file);
        },
      };
      const a = await scenario({ converter: counting });
      const b = await scenario({ converter: counting });
      await a.file(name, bytes);
      await b.file(name, bytes);
      await ingest(a);
      await drain(a);
      const second = await ingest(b);
      await drain(b);

      expect(converted).toEqual([name]);
      expect(second.sent.map((j) => j.queue)).toEqual(['knowledge.index']);
      const { rows: kept } = await admin.query(
        `select failure from src_conversions where sha256 = $1`,
        [await sha(bytes)],
      );
      expect(kept).toEqual([{ failure: reason }]);
      for (const s of [a, b]) {
        const { rows } = await admin.query(
          `select state, reason from src_documents where dataset = $1`,
          [s.dataset.id],
        );
        expect(rows).toEqual([{ state: 'skipped', reason }]);
      }
    }
  };

  it('a file that is too large or of an unsupported type is stored as a failure and not converted again', async () => {
    await storedOnceAsFailure([
      {
        name: 'stor.pdf',
        bytes: pdfBytes([['En fil over grensen for bytes.']]),
        converter: createLocalConverter({ maxBytes: 10 }),
        reason: 'too_large',
      },
      {
        name: 'mange-sider.pdf',
        bytes: pdfBytes([['Side 1.'], ['Side 2.'], ['Side 3.']]),
        converter: createLocalConverter({ maxPages: 2 }),
        reason: 'too_large',
      },
      {
        name: 'ukjent.pdf',
        bytes: pdfBytes([['En type omformeren ikke leser.']]),
        converter: {
          extensions: ['.pdf'],
          convert: async (file) => {
            throw new UnsupportedDocumentError(file.name);
          },
        },
        reason: 'unsupported_type',
      },
    ]);
  }, 120_000);

  it('a PDF that pdf.js cannot open or that has a password is stored as conversion_failed and not converted again', async () => {
    await storedOnceAsFailure([
      {
        // The text layer's own error for it: pdf.js's InvalidPDFException.
        name: 'odelagt.pdf',
        bytes: encoder.encode('%PDF-1.4 dette er ikke en hel PDF'),
        converter: createLocalConverter(),
        reason: 'conversion_failed',
      },
      {
        name: 'passord.pdf',
        bytes: pdfBytes([['Last med passord.']]),
        converter: {
          extensions: ['.pdf'],
          // What pdf.js throws for a PDF that needs a password.
          convert: async () => {
            throw Object.assign(new Error('No password given'), { name: 'PasswordException' });
          },
        },
        reason: 'conversion_failed',
      },
    ]);
  }, 120_000);

  it('a converter that times out or loses its connection is tried again, not stored as a refusal', async () => {
    await clearConvertJobs();
    for (const failure of [
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }),
    ]) {
      const s = await scenario({
        converter: {
          extensions: ['.pdf'],
          convert: async () => {
            throw failure;
          },
        },
      });
      const pdf = pdfBytes([[`Tidsavbrudd ${failure.message}`]]);
      await s.file('treg.pdf', pdf);
      const { sent } = await ingest(s);
      await expect(
        handler(
          s.work.knowledge,
          'knowledge.convert',
        )(job('knowledge.convert', sent[0]?.data ?? {})),
      ).rejects.toThrow();
      expect(await stored(await sha(pdf))).toEqual([]);
    }
  }, 60_000);

  it('a convert job whose file changed since it was listed says so in its error', async () => {
    await clearConvertJobs();
    const s = await scenario();
    await s.file('endret.pdf', pdfBytes([['Forste utgave.']]));
    const { sent } = await ingest(s);
    await s.file('endret.pdf', pdfBytes([['Andre utgave, skrevet etter listingen.']]));

    await expect(
      handler(s.work.knowledge, 'knowledge.convert')(job('knowledge.convert', sent[0]?.data ?? {})),
    ).rejects.toThrow(/failed: FileChanged$/);
  }, 60_000);

  it('a record whose conversion dead-lettered is indexed once its file changes', async () => {
    await clearConvertJobs();
    const s = await scenario();
    await s.file('forsvinner.pdf', pdfBytes([['Forste versjon.']]));
    const first = await ingest(s);
    // Its file is unreadable when the convert job fetches it, so the job dead-letters.
    await s.remove('forsvinner.pdf');
    const convert = handler(s.work.knowledge, 'knowledge.convert');
    const stop = await knowledgeQueue.work(convertQueue(), (j) => convert(j));
    try {
      await expect.poll(() => convertJobs(), { timeout: 30_000 }).toEqual([]);
    } finally {
      await stop();
    }
    await endRun(first.run);
    await s.file('forsvinner.pdf', pdfBytes([['Andre versjon, som kan leses.']]));
    await ingest(s);
    await drain(s);

    expect((await chunks(s.generation)).map((c) => c.text).join(' ')).toContain(
      'Andre versjon, som kan leses.',
    );
  }, 60_000);

  it('a conversion that ended as a dead letter no longer holds its waiting runs open', async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    const pdf = pdfBytes([['Dod konvertering.']]);
    await a.file('dod.pdf', pdf);
    await b.file('dod.pdf', pdf);
    const first = await ingest(a);
    const second = await ingest(b);
    const jobs = runJobs();
    expect(await jobs.open(second.run)).toBeGreaterThan(0);

    const stop = await knowledgeQueue.work(convertQueue(), async () => {
      throw new Error('the PDF is broken');
    });
    try {
      await expect.poll(() => convertJobs(), { timeout: 30_000 }).toEqual([]);
    } finally {
      await stop();
    }
    expect(await jobs.open(second.run)).toBe(0);
    expect(await jobs.open(first.run)).toBe(0);
    // Both runs count the failed conversion among their failed documents.
    expect(await jobs.deadLetters(second.run)).toEqual({ 'knowledge.convert': 1 });
    expect(await jobs.deadLetters(first.run)).toEqual({ 'knowledge.convert': 1 });
  }, 60_000);

  it("a convert job whose sending run is gone fetches through a waiting run's record", async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    const pdf = pdfBytes([['Avsenderen er borte.']]);
    await a.file('borte.pdf', pdf);
    await b.file('borte.pdf', pdf);
    const first = await ingest(a);
    await ingest(b);
    await platform.pool.query(`delete from ingestion_executions where id = $1`, [first.run]);
    const [convert] = first.sent;
    await handler(
      b.work.knowledge,
      'knowledge.convert',
    )(job('knowledge.convert', convert?.data ?? {}));

    expect(b.converted).toEqual(['borte.pdf']);
    expect((await stored(await sha(pdf)))[0]?.pages).toEqual(['Avsenderen er borte.']);
  }, 60_000);

  it('a PDF with no text layer is stored as an empty conversion and not converted again', async () => {
    await clearConvertJobs();
    const a = await scenario();
    const b = await scenario();
    await a.file('skannet.pdf', scan);
    await b.file('skannet.pdf', scan);
    await ingest(a);
    await drain(a);
    const second = await ingest(b);
    await drain(b);

    expect((await stored(await sha(scan)))[0]?.pages).toEqual(['', '']);
    expect(a.converted).toEqual(['skannet.pdf']);
    expect(b.converted).toEqual([]);
    expect(second.sent.map((j) => j.queue)).toEqual(['knowledge.index']);
    const { rows } = await admin.query(
      `select state, reason from src_documents where dataset = $1`,
      [b.dataset.id],
    );
    expect(rows).toEqual([{ state: 'skipped', reason: 'no_text' }]);
  }, 60_000);

  it('HTML pages and plain text are read in the index job without a stored conversion', async () => {
    await clearConvertJobs();
    const s = await scenario();
    const note = '# Notat\n\nEt notat i ren tekst om fellesloesninger.';
    await s.file('notat.md', note);
    const { sent } = await ingest(s);
    await drain(s);

    expect(sent.map((j) => j.queue)).toEqual(['knowledge.index']);
    expect(s.converted).toEqual([]);
    expect(await stored(await sha(encoder.encode(note)))).toEqual([]);
    expect(await chunks(s.generation)).toMatchObject([{ file: 'notat.md', page_from: 1 }]);
  }, 60_000);

  it('in lockdown, a conversion runs while any run waiting on it is admitted', async () => {
    await clearConvertJobs();
    const a = await scenario({ lockdown: true });
    const b = await scenario({ lockdown: true });
    const pdf = pdfBytes([['Konvertering i lockdown.']]);
    await a.file('lockdown.pdf', pdf);
    await b.file('lockdown.pdf', pdf);
    // Run A sent the job, but its admission ran out; run B, admitted now, waits on it.
    const first = await ingest(a);
    await platform.pool.query(`update ingestion_executions set admitted_at = $2 where id = $1`, [
      first.run,
      new Date(Date.now() - 30 * 3_600_000).toISOString(),
    ]);
    await ingest(b);
    const [convert] = first.sent;
    await handler(
      a.work.knowledge,
      'knowledge.convert',
    )(job('knowledge.convert', convert?.data ?? {}));

    expect(a.converted).toEqual(['lockdown.pdf']);
  }, 60_000);

  it('in lockdown, a conversion no admitted run waits on converts nothing', async () => {
    await clearConvertJobs();
    const a = await scenario({ lockdown: true });
    await a.file('utlopt.pdf', pdfBytes([['Utlopt opptak.']]));
    const first = await ingest(a);
    await platform.pool.query(`update ingestion_executions set admitted_at = $2 where id = $1`, [
      first.run,
      new Date(Date.now() - 30 * 3_600_000).toISOString(),
    ]);
    const [convert] = first.sent;
    await handler(
      a.work.knowledge,
      'knowledge.convert',
    )(job('knowledge.convert', convert?.data ?? {}));

    expect(a.converted).toEqual([]);
  }, 60_000);

  it('a document with several files is indexed once all its files are stored', async () => {
    const target = (sha256: string) => ({
      sha256,
      converter: 'text-layer',
      version: '1',
      settings: {},
    });
    const waiter = {
      dataset: `${ORG}/flere-filer`,
      record: '424242',
      generation: 'g-flere',
      run: crypto.randomUUID(),
      tenant: ORG,
    };
    const [one, two] = ['1'.repeat(64), '2'.repeat(64)];
    await conversions.wait(target(one), waiter, async () => undefined);
    await conversions.wait(target(two), waiter, async () => undefined);
    const sent: string[] = [];
    const store = (sha256: string) =>
      conversions.store(
        { ...target(sha256), derivation: { name: 'text-layer', version: 1 }, pages: ['Side'] },
        async (w) => void sent.push(w.record),
      );

    await store(one);
    expect(sent).toEqual([]);
    await store(two);
    expect(sent).toEqual(['424242']);
  }, 30_000);

  it('a conversion that finishes while a record starts waiting still sends its index job', async () => {
    const target = { sha256: 'e'.repeat(64), converter: 'text-layer', version: '1', settings: {} };
    const waiter = {
      dataset: `${ORG}/las`,
      record: '515151',
      generation: 'g-las',
      run: crypto.randomUUID(),
      tenant: ORG,
    };
    const client = await writer().connect();
    try {
      await client.query('begin');
      await conversions.wait(target, waiter, async () => undefined, client);
      const sent: string[] = [];
      // Started while the wait is not committed: it must wait for it, then end it.
      const storing = conversions.store(
        { ...target, derivation: { name: 'text-layer', version: 1 }, pages: ['Side'] },
        async (w) => void sent.push(w.record),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(sent).toEqual([]);
      await client.query('commit');
      await storing;
      expect(sent).toEqual(['515151']);
    } finally {
      client.release();
    }
  }, 30_000);

  it("a conversion whose record's index job is still queued keeps the wait and is tried again", async () => {
    await clearConvertJobs();
    const target = { sha256: 'f'.repeat(64), converter: 'text-layer', version: '1', settings: {} };
    const waiter = {
      dataset: `${ORG}/opptatt`,
      record: '616161',
      generation: 'g-opptatt',
      run: crypto.randomUUID(),
      tenant: ORG,
    };
    const index = queues.find((q) => q.name === 'knowledge.index') as QueueDefinition;
    const busy = {
      run: waiter.run,
      tenant: ORG,
      generation: waiter.generation,
      record: waiter.record,
    };
    const key = `${waiter.generation}#${waiter.record}`;
    await knowledgeQueue.send(index, busy, { key });
    await conversions.wait(target, waiter, async () => undefined);

    const stored = await conversions.store(
      { ...target, derivation: { name: 'text-layer', version: 1 }, pages: ['Side'] },
      (w, transaction) => knowledgeQueue.send(index, busy, { key, transaction }),
    );

    expect(stored.busy.map((w) => w.record)).toEqual(['616161']);
    expect(await conversions.waitKeys(waiter.run)).toHaveLength(1);
    await admin.query(`delete from pgboss.job where singleton_key = $1`, [key]);
  }, 30_000);

  it("ending a record's waits never deadlocks with a conversion that ends them", async () => {
    const target = { sha256: '9'.repeat(64), converter: 'text-layer', version: '1', settings: {} };
    const waiter = {
      dataset: `${ORG}/vranglas`,
      record: '717171',
      generation: 'g-vranglas',
      run: crypto.randomUUID(),
      tenant: ORG,
    };
    await conversions.wait(target, waiter, async () => undefined);
    const client = await writer().connect();
    try {
      await client.query('begin');
      // A run clears the record's old waits, then a conversion of the key starts, then the run
      // makes the record wait again.
      await conversions.clear(client, waiter.dataset, waiter.record);
      const storing = conversions.store(
        { ...target, derivation: { name: 'text-layer', version: 1 }, pages: ['Side'] },
        async () => 'sent',
      );
      await new Promise((r) => setTimeout(r, 200));
      await conversions.wait(target, waiter, async () => undefined, client);
      await client.query('commit');
      await storing;
    } finally {
      client.release();
    }
  }, 30_000);

  it("an older run's dead conversion does not count against a run with a live one", async () => {
    await clearConvertJobs();
    const a = await scenario();
    await a.file('gammel-feil.pdf', pdfBytes([['Feilet en gang.']]));
    const first = await ingest(a);
    const stop = await knowledgeQueue.work(convertQueue(), async () => {
      throw new Error('the converter host went away');
    });
    try {
      await expect.poll(() => convertJobs(), { timeout: 30_000 }).toEqual([]);
    } finally {
      await stop();
    }
    await endRun(first.run);
    const b = await scenario();
    await b.file('gammel-feil.pdf', pdfBytes([['Feilet en gang.']]));
    const second = await ingest(b);

    expect(await convertJobs()).toHaveLength(1);
    expect(await runJobs().deadLetters(second.run)).toEqual({});
  }, 60_000);

  it('a convert job tried again after a busy index job does not convert again', async () => {
    await clearConvertJobs();
    const s = await scenario();
    await s.file('opptatt.pdf', pdfBytes([['Indeksjobben er opptatt.']]));
    const { run, sent } = await ingest(s);
    const record = (
      await admin.query<{ number: string }>(
        `select number::text from src_documents where dataset = $1`,
        [s.dataset.id],
      )
    ).rows[0]?.number as string;
    const index = queues.find((q) => q.name === 'knowledge.index') as QueueDefinition;
    const key = `${s.generation}#${record}`;
    await knowledgeQueue.send(
      index,
      { run, tenant: ORG, generation: s.generation, record },
      { key },
    );
    const convert = handler(s.work.knowledge, 'knowledge.convert');
    const [convertJob] = sent;

    await expect(convert(job('knowledge.convert', convertJob?.data ?? {}))).rejects.toThrow(
      /IndexJobBusy/,
    );
    await admin.query(`delete from pgboss.job where singleton_key = $1`, [key]);
    await convert(job('knowledge.convert', convertJob?.data ?? {}));

    expect(s.converted).toEqual(['opptatt.pdf']);
    expect(s.sent.filter((j) => j.queue === 'knowledge.index')).toHaveLength(1);
  }, 60_000);

  it('a first run makes 20,000 records wait in one transaction', async () => {
    const client = await writer().connect();
    try {
      await client.query('begin');
      for (let i = 0; i < 20_000; i++)
        await conversions.wait(
          {
            sha256: i.toString(16).padStart(64, '0'),
            converter: 'text-layer',
            version: '1',
            settings: {},
          },
          {
            dataset: `${ORG}/mange`,
            record: String(i + 1),
            generation: 'g-mange',
            run: 'r-mange',
            tenant: ORG,
          },
          async () => undefined,
          client,
        );
      await client.query('rollback');
    } finally {
      client.release();
    }
  }, 300_000);

  it('an index job without a stored conversion sends the convert job and waits', async () => {
    await clearConvertJobs();
    const s = await scenario();
    const pdf = pdfBytes([['Sendt for utrullingen.']]);
    await s.file('gammel.pdf', pdf);
    const { run } = await ingest(s);
    // An index job sent before stored conversions existed, while its file has none.
    await clearConvertJobs();
    await admin.query(`delete from src_conversion_waits`);
    const record = (
      await admin.query<{ number: string }>(
        `select number::text from src_documents where dataset = $1`,
        [s.dataset.id],
      )
    ).rows[0]?.number as string;
    const before = s.sent.length;
    await handler(
      s.work.knowledge,
      knowledgeIndexQueue.name,
    )(job(knowledgeIndexQueue.name, { run, tenant: ORG, generation: s.generation, record }));

    expect(s.sent.slice(before).map((j) => j.queue)).toEqual(['knowledge.convert']);
    expect(s.converted).toEqual([]);
    expect(await chunks(s.generation)).toEqual([]);
    expect(await runJobs().open(run)).toBeGreaterThan(0);
    const keys = await conversions.waitKeys(run);
    expect(keys).toEqual([
      conversionKey({
        sha256: await sha(pdf),
        converter: 'text-layer',
        version: '1',
        settings: {},
      }),
    ]);
  }, 60_000);

  it('a conversion with native output writes it to the native output store and keeps its path', async () => {
    await clearConvertJobs();
    const container = new InMemoryNativeOutputContainer();
    const output = encoder.encode('{"schema_name":"DoclingDocument"}');
    const s = await scenario({
      converter: {
        extensions: ['.pdf'],
        convert: async () => ({
          ...onePage('# Rapport\n\nTekst fra konverteringen.'),
          output,
        }),
      },
      nativeOutputs: nativeOutputStore(container),
    });
    const pdf = pdfBytes([['Med eget format.']]);
    await s.file('med-format.pdf', pdf);
    await ingest(s);
    await drain(s);

    const key = { sha256: await sha(pdf), converter: 'text-layer', version: '1', settings: {} };
    const path = nativeOutputEntry(key).path;
    expect((await stored(await sha(pdf)))[0]?.output_path).toBe(path);
    expect((await nativeOutputStore(container).get(key))?.output).toEqual(output);
    // The stored conversion's key hashes the settings as the Blob container names them.
    expect(conversionKey(key)).toBe(
      `${key.sha256}:text-layer:1:${nativeOutputEntry(key).settingsHash}`,
    );
  }, 60_000);
});
