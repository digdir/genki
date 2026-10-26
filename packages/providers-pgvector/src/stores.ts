import type { ConversionStore, EmbeddingCache, StoredConversion } from '@genai/ingest';
import type { Pool } from 'pg';
import { migrateKnowledge } from './schema.js';

const migratedOnce = (pool: Pool) => {
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= migrateKnowledge(pool).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
};

/** Conversions in `src_conversions` on the knowledge server, newest first per file and producer. */
export const pgvectorConversionStore = (pool: Pool): ConversionStore => {
  const migrated = migratedOnce(pool);
  return {
    latest: async (sha256, producer) => {
      await migrated();
      const { rows } = await pool.query<StoredConversion>(
        `select sha256, producer, version, settings, markdown, output from src_conversions
         where sha256 = $1 and producer = $2 order by saved_at desc limit 1`,
        [sha256, producer],
      );
      return rows[0];
    },
    save: async (conversion) => {
      await migrated();
      await pool.query(
        `insert into src_conversions (sha256, producer, version, settings, markdown, output)
         values ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
         on conflict (sha256, producer, version, settings_key) do update
           set markdown = excluded.markdown, output = excluded.output, saved_at = clock_timestamp()`,
        [
          conversion.sha256,
          conversion.producer,
          conversion.version,
          JSON.stringify(conversion.settings),
          conversion.markdown,
          JSON.stringify(conversion.output),
        ],
      );
    },
  };
};

/** Embeddings in `kn_embeddings` on the knowledge server, stored as halfvec like the index. */
export const pgvectorEmbeddingCache = (pool: Pool): EmbeddingCache => {
  const migrated = migratedOnce(pool);
  return {
    find: async (model, dimensions, hashes) => {
      await migrated();
      const { rows } = await pool.query<{ hash: string; vec: string }>(
        `select hash, vec::text as vec from kn_embeddings
         where model = $1 and dimensions = $2 and hash = any($3::text[])`,
        [model, dimensions, hashes],
      );
      return new Map(rows.map((r) => [r.hash, JSON.parse(r.vec) as number[]]));
    },
    save: async (model, dimensions, entries) => {
      if (entries.length === 0) return;
      await migrated();
      await pool.query(
        `insert into kn_embeddings (model, dimensions, hash, vec)
         select $1, $2, x.hash, x.vec::halfvec from jsonb_to_recordset($3::jsonb) as x(hash text, vec text)
         on conflict (model, dimensions, hash) do nothing`,
        [
          model,
          dimensions,
          JSON.stringify(entries.map((e) => ({ hash: e.hash, vec: JSON.stringify(e.vector) }))),
        ],
      );
    },
  };
};
