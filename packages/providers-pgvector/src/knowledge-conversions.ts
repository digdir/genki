import {
  conversionKey,
  isPartsDerivation,
  partsDerivations,
  settingsHash,
  type AcceptedConverter,
  type ConversionUnit,
  type ConversionWaiter,
  type RecordTransaction,
  type StoredConversion,
  type StoredConversions,
} from '@genai/port-knowledge';
import type { Pool } from 'pg';
import { transaction } from './schema.js';

/**
 * Waits and the conversion that ends them lock the convert key's row, in their transactions, so a
 * conversion that finishes never misses a record that just started waiting. A row lock, not an
 * advisory lock: a first run makes tens of thousands of records wait in one transaction, and
 * advisory locks fill PostgreSQL's shared lock table, where row locks take no room.
 */
const lock = async (client: RecordTransaction, key: string) => {
  await client.query(`insert into src_conversion_keys (key) values ($1) on conflict do nothing`, [
    key,
  ]);
  await client.query(`select 1 from src_conversion_keys where key = $1 for update`, [key]);
};

const acceptedJson = (accepted: readonly AcceptedConverter[]) =>
  JSON.stringify(
    accepted.map((a, rank) => ({
      rank,
      converter: a.converter,
      derivation: a.derivation.name,
      derivation_version: a.derivation.version,
      kept: a.kept,
    })),
  );

interface ConversionRow {
  id: string | null;
  sha256: string;
  converter: string;
  version: string;
  settings: Record<string, unknown>;
  derivation: string;
  derivation_version: number;
  pages: string[];
  output_path: string | null;
  failure: string | null;
}

const toConversion = (row: ConversionRow): StoredConversion => ({
  sha256: row.sha256,
  converter: row.converter,
  version: row.version,
  settings: row.settings,
  derivation: { name: row.derivation, version: row.derivation_version },
  pages: row.pages,
  ...(row.output_path ? { outputPath: row.output_path } : {}),
  ...(row.failure ? { failure: row.failure } : {}),
});

interface UnitRow {
  unit: number;
  kind: ConversionUnit['kind'];
  label: string | null;
  width: number | null;
  height: number | null;
  text_start: number | null;
  text_end: number | null;
  unit_to: number;
  seq_from: number;
  seq_to: number;
  parts: ConversionUnit['parts'];
}

const toUnit = (row: UnitRow): ConversionUnit => ({
  unit: row.unit,
  kind: row.kind,
  label: row.label,
  width: row.width,
  height: row.height,
  textStart: row.text_start,
  textEnd: row.text_end,
  unitTo: row.unit_to,
  seqFrom: row.seq_from,
  seqTo: row.seq_to,
  parts: row.parts,
});

/** PostgreSQL refuses U+0000 in text and jsonb, and converters read it out of some PDFs (issue 532). */
const withoutNul = <T>(value: T): T => {
  if (typeof value === 'string') return value.replaceAll('\u0000', '') as T;
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, withoutNul(inner)]),
    ) as T;
  return value;
};

/** Units a statement: a long report's parts stay well under a statement's size. */
const unitBatch = 200;

const partsNames = partsDerivations.map((d) => d.name);

/** Stored conversions on the knowledge server, as the worker's writer role reaches them (ADR 0042). */
export const knowledgeConversionsOf = (writer: Pool): StoredConversions => ({
  find: async (sha256, accepted) => {
    const { rows } = await writer.query<ConversionRow>(
      `select c.id::text, c.sha256, c.converter, c.version, c.settings, c.derivation,
              c.derivation_version, c.pages, c.output_path, c.failure
         from src_conversions c
         join jsonb_to_recordset($2::jsonb)
           as a(rank integer, converter text, derivation text, derivation_version integer)
           on a.converter = c.converter and a.derivation = c.derivation
          and a.derivation_version = c.derivation_version
        where c.sha256 = $1
        -- Pages before refusals, then the accepted order, then the newest.
        order by c.failure is not null, a.rank, c.created_at desc
        limit 1`,
      [sha256, acceptedJson(accepted)],
    );
    const row = rows[0];
    if (!row) return undefined;
    const found = toConversion(row);
    if (!row.id || row.failure || !isPartsDerivation(found.derivation)) return found;
    const units = await writer.query<UnitRow>(
      `select unit, kind, label, width, height, text_start, text_end, unit_to, seq_from, seq_to, parts
         from src_conversion_units where conversion = $1::bigint order by unit`,
      [row.id],
    );
    return { ...found, units: units.rows.map(toUnit) };
  },

  missing: async (client, record, accepted) => {
    const { rows } = await client.query(
      `select f.file as name, f.sha256
         from src_files f
         join src_documents d on d.dataset = f.dataset and d.id = f.document
        where d.number = $1::bigint and f.converts and f.sha256 is not null
          and not exists (
            select 1 from src_conversions c
              join jsonb_to_recordset($2::jsonb)
                as a(rank integer, converter text, derivation text, derivation_version integer)
                on a.converter = c.converter and a.derivation = c.derivation
               and a.derivation_version = c.derivation_version
             -- A file its convert job could not fetch is fetched again (issue 597).
             where c.sha256 = f.sha256 and c.failure is distinct from 'unreachable')
        order by f.file`,
      [record, acceptedJson(accepted)],
    );
    return rows as { name: string; sha256: string }[];
  },

  wait: async (target, waiter, send, given) => {
    const key = conversionKey(target);
    const run = async (client: RecordTransaction) => {
      await lock(client, key);
      const { rows } = await client.query(
        `select 1 from src_conversions
          where sha256 = $1 and converter = $2 and version = $3 and settings_hash = $4
            and failure is distinct from 'unreachable'
            -- Waits are for pages until a pipeline asks for parts (issue 635).
            and derivation <> all($5::text[])
          limit 1`,
        [
          target.sha256,
          target.converter,
          target.version,
          settingsHash(target.settings),
          partsNames,
        ],
      );
      if (rows.length > 0) return false;
      await client.query(
        `insert into src_conversion_waits (key, dataset, record, generation, run, tenant)
         values ($1, $2, $3::bigint, $4, $5, $6)
         on conflict (key, dataset, record)
           do update set generation = excluded.generation, run = excluded.run, tenant = excluded.tenant`,
        [key, waiter.dataset, waiter.record, waiter.generation, waiter.run, waiter.tenant],
      );
      await send(client);
      return true;
    };
    return given ? run(given) : transaction(writer, run);
  },

  store: (conversion, send) =>
    transaction(writer, async (client) => {
      const key = conversionKey(conversion);
      await lock(client, key);
      const { rows: stored } = await client.query<{ id: string }>(
        `insert into src_conversions (sha256, converter, version, settings_hash, settings,
           derivation, derivation_version, pages, output_path, failure)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], $9, $10)
         on conflict (sha256, converter, version, settings_hash, derivation, derivation_version)
           do update set pages = excluded.pages, output_path = excluded.output_path,
                         failure = excluded.failure,
                         -- A row stored before the migration gets its number when stored again.
                         id = coalesce(src_conversions.id, nextval('src_conversions_id_seq'))
         returning id::text`,
        [
          conversion.sha256,
          conversion.converter,
          conversion.version,
          settingsHash(conversion.settings),
          JSON.stringify(conversion.settings),
          conversion.derivation.name,
          conversion.derivation.version,
          // PostgreSQL refuses U+0000 in text, and converters read it out of some PDFs (issue 532).
          conversion.pages.map((page) => page.replaceAll('\u0000', '')),
          conversion.outputPath ?? null,
          conversion.failure ?? null,
        ],
      );
      const id = stored[0]?.id;
      await client.query(`delete from src_conversion_units where conversion = $1::bigint`, [id]);
      const units = withoutNul(conversion.units ?? []);
      for (let at = 0; at < units.length; at += unitBatch)
        await client.query(
          `insert into src_conversion_units (conversion, unit, kind, label, width, height,
             text_start, text_end, unit_to, seq_from, seq_to, parts)
           select $1::bigint, u.unit, u.kind, u.label, u."width", u."height", u."textStart",
                  u."textEnd", u."unitTo", u."seqFrom", u."seqTo", u.parts
             from jsonb_to_recordset($2::jsonb) as u(unit integer, kind text, label text,
               "width" real, "height" real, "textStart" integer, "textEnd" integer,
               "unitTo" integer, "seqFrom" integer, "seqTo" integer, parts jsonb)`,
          [id, JSON.stringify(units.slice(at, at + unitBatch))],
        );
      // Parts end no wait: the waits are for pages until a pipeline asks for parts (issue 635).
      if (isPartsDerivation(conversion.derivation)) return { sent: [], busy: [] };
      const { rows } = await client.query<{
        dataset: string;
        record: string;
        generation: string;
        run: string;
        tenant: string;
      }>(
        `delete from src_conversion_waits where key = $1
         returning dataset, record::text, generation, run, tenant`,
        [key],
      );
      const sent: ConversionWaiter[] = [];
      const busy: ConversionWaiter[] = [];
      for (const waiter of rows) {
        // A record with another file still converting gets its index job from that conversion.
        const { rows: other } = await client.query(
          `select 1 from src_conversion_waits where dataset = $1 and record = $2::bigint limit 1`,
          [waiter.dataset, waiter.record],
        );
        if (other.length > 0) continue;
        if ((await send(waiter, client)) !== null) {
          sent.push(waiter);
          continue;
        }
        // Its index job is still queued or running, and may have read the record before this
        // conversion: the record keeps waiting, and the convert job is tried again.
        await client.query(
          `insert into src_conversion_waits (key, dataset, record, generation, run, tenant)
           values ($1, $2, $3::bigint, $4, $5, $6) on conflict do nothing`,
          [key, waiter.dataset, waiter.record, waiter.generation, waiter.run, waiter.tenant],
        );
        busy.push(waiter);
      }
      return { sent, busy };
    }),

  clear: async (client, dataset, record) => {
    // The keys' locks first, in key order, as a conversion takes them before it ends the same waits.
    const { rows } = await client.query(
      `select distinct key from src_conversion_waits
        where dataset = $1 and record = $2::bigint order by key`,
      [dataset, record],
    );
    for (const { key } of rows as { key: string }[]) await lock(client, key);
    await client.query(
      `delete from src_conversion_waits where dataset = $1 and record = $2::bigint`,
      [dataset, record],
    );
  },

  waiting: async (target) => {
    const { rows } = await writer.query<{
      run: string;
      tenant: string;
      dataset: string;
      record: string;
    }>(
      `select run, tenant, dataset, record::text from src_conversion_waits
        where key = $1 order by run, dataset, record`,
      [conversionKey(target)],
    );
    return rows;
  },

  waitKeys: async (run) => {
    const { rows } = await writer.query<{ key: string }>(
      `select distinct key from src_conversion_waits where run = $1 order by key`,
      [run],
    );
    return rows.map((r) => r.key);
  },

  release: (run, act) =>
    transaction(writer, async (client) => {
      const { rows: keys } = await client.query<{ key: string }>(
        `select distinct key from src_conversion_waits where run = $1 order by key`,
        [run],
      );
      // In key order, so two runs cancelled together never wait on each other's locks.
      for (const { key } of keys) await lock(client, key);
      await client.query(`delete from src_conversion_waits where run = $1`, [run]);
      const { rows: still } = await client.query<{ key: string } & ConversionWaiter>(
        `select distinct on (key) key, dataset, record::text, generation, run, tenant
           from src_conversion_waits where key = any($1::text[]) order by key, run, record`,
        [keys.map((k) => k.key)],
      );
      const kept = new Set(still.map((r) => r.key));
      await act(
        client,
        keys.map((k) => k.key).filter((k) => !kept.has(k)),
        still,
      );
    }),

  waitsSince: async (run) => {
    const { rows } = await writer.query<{ sha256: string; since: Date }>(
      `select split_part(key, ':', 1) as sha256, min(created_at) as since
         from src_conversion_waits where run = $1 group by 1 order by 1`,
      [run],
    );
    return rows;
  },

  storedAmong: async (key, sha256s) => {
    const { rows } = await writer.query<{ sha256: string }>(
      `select sha256 from src_conversions
        where converter = $1 and version = $2 and settings_hash = $3 and derivation = $4
          and derivation_version = $5 and sha256 = any($6::text[])`,
      [
        key.converter,
        key.version,
        key.settingsHash,
        key.derivation.name,
        key.derivation.version,
        sha256s,
      ],
    );
    return new Set(rows.map((r) => r.sha256));
  },

  waitedKeys: async () => {
    const { rows } = await writer.query<{ key: string }>(
      `select distinct key from src_conversion_waits order by key`,
    );
    return rows.map((r) => r.key);
  },

  replaceable: async (dataset, pipeline, accepted, after, limit) => {
    const { rows } = await writer.query<{ record: string; name: string; sha256: string }>(
      `with files as (
         select d.number, f.file as name, f.sha256
           from src_documents d
           join src_files f on f.dataset = d.dataset and f.document = d.id
          where d.dataset = $1 and d.number > $2::bigint and $5 = any(d.owners)
            and (d.state = 'stored' or (d.state = 'skipped' and d.reason = 'no_text'))
            and f.converts and f.sha256 is not null
            and exists (
              select 1 from src_conversions c
                join jsonb_to_recordset($3::jsonb) as a(converter text, kept boolean)
                  on a.converter = c.converter
               where c.sha256 = f.sha256 and c.failure is null and not a.kept)
            and not exists (
              select 1 from src_conversions c
                join jsonb_to_recordset($3::jsonb) as a(converter text, kept boolean)
                  on a.converter = c.converter
               where c.sha256 = f.sha256 and a.kept)
       ),
       records as (select distinct number from files order by number limit $4)
       select f.number::text as record, f.name, f.sha256
         from files f join records r using (number)
        order by f.number, f.name`,
      [dataset, after, acceptedJson(accepted), limit, pipeline],
    );
    const byRecord = new Map<string, { name: string; sha256: string }[]>();
    for (const row of rows)
      byRecord.set(row.record, [
        ...(byRecord.get(row.record) ?? []),
        { name: row.name, sha256: row.sha256 },
      ]);
    return [...byRecord].map(([record, files]) => ({ record, files }));
  },

  holding: async (dataset, pipeline, sha256) => {
    const { rows } = await writer.query<{ record: string }>(
      `select distinct d.number::text as record
         from src_documents d
         join src_files f on f.dataset = d.dataset and f.document = d.id
        where d.dataset = $1 and $2 = any(d.owners) and f.sha256 = $3
          and (d.state = 'stored' or (d.state = 'skipped' and d.reason = 'no_text'))
          -- A record still waiting on a conversion is indexed when its last one is stored.
          and not exists (select 1 from src_conversion_waits w
                           where w.dataset = d.dataset and w.record = d.number)`,
      [dataset, pipeline, sha256],
    );
    return rows.map((r) => r.record);
  },
});
