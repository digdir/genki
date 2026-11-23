import type { Pool } from 'pg';

export interface StoredClassification {
  residency?: 'norway' | 'eu' | 'global';
  capabilities?: ('stream' | 'tools' | 'json-schema' | 'reasoning')[];
  enabled?: boolean;
}

export class PostgresModelClassifications {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<Record<string, StoredClassification>> {
    const rows = await this.pool.query<{ id: string; classification: StoredClassification }>(
      'select id, classification from model_classifications',
    );
    return Object.fromEntries(rows.rows.map((r) => [r.id, r.classification]));
  }

  async save(id: string, classification: StoredClassification): Promise<void> {
    await this.pool.query(
      `insert into model_classifications (id, classification, updated_at) values ($1, $2, now())
       on conflict (id) do update set classification = excluded.classification, updated_at = now()`,
      [id, JSON.stringify(classification)],
    );
  }
}

export interface StoredListing {
  connection: string;
  source: string;
  deployments: { deployment: string; firstSeenAt: string; lastSeenAt: string }[];
  target?: string;
  listedAt?: string;
  failedAt?: string;
  errorKind?: string;
}

interface ListingRow {
  connection: string;
  source: string;
  deployments: StoredListing['deployments'];
  target: string | null;
  listed_at: Date | null;
  failed_at: Date | null;
  error_kind: string | null;
}

const listingOf = (row: ListingRow): StoredListing => ({
  connection: row.connection,
  source: row.source,
  deployments: row.deployments,
  ...(row.target ? { target: row.target } : {}),
  ...(row.listed_at ? { listedAt: row.listed_at.toISOString() } : {}),
  ...(row.failed_at ? { failedAt: row.failed_at.toISOString() } : {}),
  ...(row.error_kind ? { errorKind: row.error_kind } : {}),
});

export class PostgresDiscoveredModels<L extends StoredListing = StoredListing> {
  constructor(private readonly pool: Pool) {}

  async load(): Promise<L[]> {
    const rows = await this.pool.query<ListingRow>(
      `select connection, source, deployments, target, listed_at, failed_at, error_kind
       from discovered_models order by connection, source`,
    );
    return rows.rows.map((r) => listingOf(r) as L);
  }

  async update(connection: string, source: string, change: (current: L | undefined) => L) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into discovered_models (connection, source) values ($1, $2)
         on conflict (connection, source) do nothing`,
        [connection, source],
      );
      const found = await client.query<ListingRow>(
        `select connection, source, deployments, target, listed_at, failed_at, error_kind
         from discovered_models where connection = $1 and source = $2 for update`,
        [connection, source],
      );
      const row = found.rows[0];
      const current = row && (row.listed_at || row.failed_at) ? (listingOf(row) as L) : undefined;
      const next = change(current);
      await client.query(
        `update discovered_models set deployments = $3, listed_at = $4, failed_at = $5,
           error_kind = $6, target = $7, updated_at = now()
         where connection = $1 and source = $2`,
        [
          connection,
          source,
          JSON.stringify(next.deployments),
          next.listedAt ?? null,
          next.failedAt ?? null,
          next.errorKind ?? null,
          next.target ?? null,
        ],
      );
      await client.query('commit');
      return next;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(name: string, at: Date, everyMs: number): Promise<boolean> {
    const claimed = await this.pool.query(
      `insert into model_discovery_claims (name, claimed_at) values ($1, $2)
       on conflict (name) do update set claimed_at = excluded.claimed_at
         where model_discovery_claims.claimed_at <= excluded.claimed_at - make_interval(secs => $3)`,
      [name, at, everyMs / 1000],
    );
    return claimed.rowCount === 1;
  }
}
