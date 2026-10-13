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
