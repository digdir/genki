import {
  copyOwner,
  GenerationBusy,
  KnowledgeError,
  tombstoneHash,
  type DocumentRecords,
  type IndexRecord,
  type ListedFile,
  type OwnedRecord,
  type RecordWrite,
} from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import { generationWritable, tryGenerationWrite } from './heavy-work.js';
import { deleteDocument, replaceDocument } from './knowledge-writer.js';
import { transaction } from './schema.js';

interface RecordRow {
  number: string;
  dataset: string;
  id: string;
  record: Record<string, unknown>;
  state: IndexRecord['state'];
  change: string;
  gone: number;
  files?: { name: string; sha256: string | null }[];
}

const toRecord = (row: RecordRow): IndexRecord => ({
  number: row.number,
  dataset: row.dataset,
  id: row.id,
  record: row.record,
  state: row.state,
  change: Number(row.change),
  gone: row.gone,
  ...(row.files
    ? { files: row.files.map((f) => ({ name: f.name, ...(f.sha256 ? { sha256: f.sha256 } : {}) })) }
    : {}),
});

const recordColumns = `number::text, dataset, id, record, state, change::text, gone`;

/** Takes the dataset's next change number, inside the caller's transaction; numbers have no gaps. */
const nextChange = async (client: PoolClient, dataset: string) => {
  const { rows } = await client.query<{ change: string }>(
    `insert into src_changes (dataset, last_change) values ($1, 1)
       on conflict (dataset) do update set last_change = src_changes.last_change + 1
       returning last_change::text as change`,
    [dataset],
  );
  return Number(rows[0]?.change);
};

/**
 * Moves a generation's data version: one below the lowest change it has not applied, or the
 * dataset's last change when none is pending (ADR 0042, "Ingestion runs").
 */
const moveDataVersion = (client: PoolClient, generation: string) =>
  client.query(
    `update kn_generations g set data_version = coalesce(
       (select min(d.change) - 1 from src_documents d
          left join kn_applied a on a.generation = g.generation and a.id = d.id
         where d.dataset = g.dataset and d.change > g.data_version
           and (a.change is null or a.change < d.change)),
       (select last_change from src_changes c where c.dataset = g.dataset),
       0)
     where g.generation = $1`,
    [generation],
  );

/**
 * Locks the generation, so index jobs of one generation move its data version one at a time, after
 * its advisory lock shared: without that lock VACUUM holds the generation, and the job gives way.
 */
const lockGeneration = async (client: PoolClient, generation: string, dataset: string) => {
  if (!(await tryGenerationWrite(client, generation))) throw new GenerationBusy(generation);
  const { rows } = await client.query<{
    dataset: string;
    recipe: Record<string, unknown>;
    state: string;
  }>(`select dataset, recipe, state from kn_generations where generation = $1 for update`, [
    generation,
  ]);
  const found = rows[0];
  if (!found || found.dataset !== dataset)
    throw new KnowledgeError(
      'bad_request',
      `generation ${generation} is not a generation of ${dataset}`,
    );
  // A generation not attached yet is filled through its own tables, which the writer may fill.
  const via = found.state === 'standalone' ? ('partition' as const) : ('parent' as const);
  return { recipe: found.recipe, via };
};

const writeFiles = async (
  client: PoolClient,
  dataset: string,
  id: string,
  files: ListedFile[],
  change: number,
) => {
  await client.query(`delete from src_files where dataset = $1 and document = $2`, [dataset, id]);
  await client.query(
    `insert into src_files (dataset, document, file, sha256, converts, change)
     select $1, $2, x.name, x.sha256, coalesce(x.converts, false), $3
       from jsonb_to_recordset($4::jsonb) as x(name text, sha256 text, converts boolean)
     on conflict do nothing`,
    [dataset, id, change, JSON.stringify(files)],
  );
};

const writeRecord = async (
  client: PoolClient,
  input: { dataset: string; pipeline: string },
  write: RecordWrite,
) => {
  const { dataset, pipeline } = input;
  if (write.kind === 'seen' || write.kind === 'missing') return;
  if (write.kind === 'delete') {
    await client.query(
      `update src_documents set state = 'deleted', reason = null, change = $3
        where dataset = $1 and id = $2`,
      [dataset, write.id, await nextChange(client, dataset)],
    );
    return;
  }
  const change = await nextChange(client, dataset);
  const { listed } = write;
  await client.query(
    `insert into src_documents (dataset, id, owners, record, metadata_hash, state, change, earlier_ids)
     values ($1, $2, array[$3], $4, $5, null, $6, $7)
     on conflict (dataset, id) do update set
       owners = array[$3], record = excluded.record, metadata_hash = excluded.metadata_hash,
       state = null, reason = null, last_seen = now(), missing = 0, gone = 0, gone_run = null,
       change = excluded.change, earlier_ids = excluded.earlier_ids`,
    [
      dataset,
      listed.id,
      pipeline,
      JSON.stringify(listed.record),
      write.metadataHash,
      change,
      listed.earlierIds ?? [],
    ],
  );
  await writeFiles(client, dataset, listed.id, listed.files, change);
  // A document listed again is no longer withdrawn.
  await client.query(`delete from src_tombstones where dataset = $1 and id_hash = $2`, [
    dataset,
    tombstoneHash(dataset, listed.id),
  ]);
};

/** The document records on the knowledge server, as the worker's writer role reaches them (ADR 0042). */
export const knowledgeRecordsOf = (writer: Pool): DocumentRecords => ({
  owned: async (dataset, pipeline, generation) => {
    const { rows } = await writer.query<{
      number: string;
      id: string;
      metadata_hash: string;
      state: OwnedRecord['state'];
      missing: number;
      change: string;
      applied: string | null;
      applied_at: Date | null;
      files: { name: string; sha256: string | null }[];
      copied: boolean;
    }>(
      `select d.number::text, d.id, d.metadata_hash, d.state, d.missing, d.change::text,
              a.change::text as applied, a.applied_at,
              coalesce((select jsonb_agg(jsonb_build_object('name', f.file, 'sha256', f.sha256) order by f.file)
                          from src_files f where f.dataset = d.dataset and f.document = d.id), '[]') as files,
              not ($2 = any(d.owners)) as copied
         from src_documents d
         left join kn_applied a on a.generation = $3 and a.id = d.id
        where d.dataset = $1
          and ($2 = any(d.owners) or ($2 <> $4 and $4 = any(d.owners)))
        order by d.change`,
      [dataset, pipeline, generation, copyOwner],
    );
    return rows.map((r) => ({
      number: r.number,
      id: r.id,
      metadataHash: r.metadata_hash,
      files: r.files.map((f) => ({
        name: f.name,
        ...(f.sha256 === null ? {} : { sha256: f.sha256 }),
      })),
      state: r.state,
      missing: r.missing,
      change: Number(r.change),
      ...(r.applied === null ? {} : { applied: Number(r.applied) }),
      ...(r.applied_at === null ? {} : { appliedAt: r.applied_at.toISOString() }),
      ...(r.copied ? { copied: true } : {}),
    }));
  },

  apply: (input, send) =>
    transaction(writer, async (client) => {
      const { dataset, plan } = input;
      for (const write of plan.writes) await writeRecord(client, input, write);
      const seen = plan.writes.flatMap((w) => (w.kind === 'seen' ? [w.id] : []));
      const missing = plan.writes.flatMap((w) => (w.kind === 'missing' ? [w.id] : []));
      if (seen.length > 0)
        await client.query(
          `update src_documents set last_seen = now(), missing = 0 where dataset = $1 and id = any($2::text[])`,
          [dataset, seen],
        );
      if (missing.length > 0)
        await client.query(
          `update src_documents set missing = missing + 1 where dataset = $1 and id = any($2::text[])`,
          [dataset, missing],
        );
      // Earlier ids of unchanged records, in one statement: not a change of the document, so its
      // data version and generations stay as they are.
      const earlier = plan.writes.flatMap((w) =>
        w.kind === 'seen' && w.earlierIds ? [{ id: w.id, ids: w.earlierIds }] : [],
      );
      if (earlier.length > 0)
        await client.query(
          `update src_documents d set earlier_ids = x.ids
             from jsonb_to_recordset($2::jsonb) as x(id text, ids text[])
            where d.dataset = $1 and d.id = x.id and d.earlier_ids is distinct from x.ids`,
          [dataset, JSON.stringify(earlier)],
        );
      if (plan.process.length === 0) return;
      const { rows } = await client.query<{ number: string }>(
        `select number::text from src_documents where dataset = $1 and id = any($2::text[]) order by number`,
        [dataset, plan.process],
      );
      for (const row of rows) await send(row.number, client);
    }),

  chunking: async <Chunking>(generation: string, pipeline: string, current: Chunking) => {
    // Two statements: a job that waited on another's update reads what that one kept, which a
    // read in the same statement, on its older snapshot, would not see.
    await writer.query(
      `update kn_generations
          set recipe = jsonb_set(recipe, '{chunking}',
                                 coalesce(recipe -> 'chunking', '{}') || jsonb_build_object($2::text, $3::jsonb))
        where generation = $1 and not coalesce((recipe -> 'chunking') ? $2, false)`,
      [generation, pipeline, JSON.stringify(current)],
    );
    const { rows } = await writer.query<{ chunking: Chunking }>(
      `select recipe -> 'chunking' -> $2 as chunking from kn_generations where generation = $1`,
      [generation, pipeline],
    );
    const kept = rows[0]?.chunking;
    if (kept === undefined || kept === null)
      throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
    return kept;
  },

  embedding: async (generation) => {
    const { rows } = await writer.query<{
      embedding: { model: string; dimensions: number } | null;
    }>(`select recipe -> 'embedding' as embedding from kn_generations where generation = $1`, [
      generation,
    ]);
    return rows[0]?.embedding ?? undefined;
  },

  held: async (record, generation) => {
    const { rows } = await writer.query(
      `select 1 from kn_applied where generation = $1 and id = $2 and change = $3`,
      [generation, record.id, record.change],
    );
    return rows.length > 0;
  },

  touch: async (record, generation) => {
    await writer.query(
      `update kn_applied set applied_at = now() where generation = $1 and id = $2 and change = $3`,
      [generation, record.id, record.change],
    );
  },

  writable: (generation) => generationWritable(writer, generation),

  find: async (number) => {
    const { rows } = await writer.query<RecordRow>(
      `select ${recordColumns},
              coalesce((select jsonb_agg(jsonb_build_object('name', f.file, 'sha256', f.sha256) order by f.file)
                          from src_files f where f.dataset = d.dataset and f.document = d.id), '[]') as files
         from src_documents d where number = $1::bigint`,
      [number],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  },

  replace: (record, generation, result) =>
    transaction(writer, async (client) => {
      const { recipe, via } = await lockGeneration(client, generation, record.dataset);
      const { rows: current } = await client.query<{ change: string }>(
        `select change::text from src_documents where number = $1::bigint for update`,
        [record.number],
      );
      if (Number(current[0]?.change) !== record.change) return false;
      const embedding = recipe.embedding as { dimensions?: number } | undefined;
      if ('document' in result)
        await replaceDocument(
          client,
          {
            dataset: record.dataset,
            generation,
            config: String(recipe.textSearchConfig ?? 'norwegian'),
            via,
            ...(embedding?.dimensions ? { dimensions: embedding.dimensions } : {}),
          },
          { ...result.document, id: record.id },
        );
      else await deleteDocument(client, { generation, via }, record.id);
      await client.query(
        `insert into kn_applied (generation, dataset, id, change) values ($1, $2, $3, $4)
           on conflict (generation, id) do update set change = excluded.change, applied_at = now()`,
        [generation, record.dataset, record.id, record.change],
      );
      await client.query(
        `update src_documents set state = $3, reason = $4 where number = $1::bigint and change = $2`,
        [
          record.number,
          record.change,
          'document' in result ? 'stored' : 'skipped',
          'skip' in result ? result.skip : null,
        ],
      );
      await moveDataVersion(client, generation);
      return true;
    }),

  remove: (record, generation) =>
    transaction(writer, async (client) => {
      const { via } = await lockGeneration(client, generation, record.dataset);
      await deleteDocument(client, { generation, via }, record.id);
      await client.query(`delete from kn_applied where generation = $1 and id = $2`, [
        generation,
        record.id,
      ]);
      const { rowCount } = await client.query(
        `delete from src_documents where number = $1::bigint and state = 'deleted'`,
        [record.number],
      );
      if (rowCount)
        await client.query(
          `insert into src_tombstones (dataset, id_hash, deleted_on) values ($1, $2, current_date)
             on conflict do nothing`,
          [record.dataset, tombstoneHash(record.dataset, record.id)],
        );
      await moveDataVersion(client, generation);
    }),

  fail: async (record, reason) => {
    await writer.query(
      `update src_documents set state = 'failed', reason = $3
        where number = $1::bigint and change = $2 and (state is null or state = 'failed')`,
      [record.number, record.change, reason],
    );
  },

  gone: (record, run) =>
    transaction(writer, async (client) => {
      const { rows } = await client.query<RecordRow>(
        `update src_documents set gone = gone + 1, gone_run = $2
          where number = $1::bigint and gone_run is distinct from $2
          returning ${recordColumns}`,
        [record.number, run],
      );
      const counted = rows[0];
      if (!counted) {
        const { rows: unchanged } = await client.query<RecordRow>(
          `select ${recordColumns} from src_documents where number = $1::bigint`,
          [record.number],
        );
        return unchanged[0] ? toRecord(unchanged[0]) : record;
      }
      if (counted.gone < 2) return toRecord(counted);
      const change = await nextChange(client, counted.dataset);
      const { rows: deleted } = await client.query<RecordRow>(
        `update src_documents set state = 'deleted', reason = 'gone', change = $2
          where number = $1::bigint returning ${recordColumns}`,
        [record.number, change],
      );
      return toRecord(deleted[0] ?? counted);
    }),
});
