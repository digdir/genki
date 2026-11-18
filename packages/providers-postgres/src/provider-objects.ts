import type {
  LedgerKey,
  LedgerObject,
  ProviderObjectRecord,
  ProviderObjectState,
  ProviderObjectStore,
} from '@genai/kernel';
import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

interface ObjectRow {
  tenant: string;
  connection: string;
  object_id: string;
  run: string;
  descriptor: string;
  deployment: string;
  step: string;
  field: string;
  delete_by: Date;
  deletable: boolean;
  state: ProviderObjectState;
  created_at: Date;
  settled_at: Date | null;
  incident: string | null;
}

const toRecord = (row: ObjectRow): ProviderObjectRecord => ({
  tenant: row.tenant,
  connection: row.connection,
  objectId: row.object_id,
  run: row.run,
  descriptor: row.descriptor,
  deployment: row.deployment,
  step: row.step,
  field: row.field,
  deleteBy: row.delete_by.toISOString(),
  deletable: row.deletable,
  state: row.state,
  createdAt: row.created_at.toISOString(),
  ...(row.settled_at ? { settledAt: row.settled_at.toISOString() } : {}),
  ...(row.incident ? { incident: row.incident } : {}),
});

export class PostgresProviderObjects implements ProviderObjectStore {
  constructor(private readonly pool: Pool) {}

  async created(object: LedgerObject) {
    await withTenant(this.pool, object.tenant, (client) =>
      client.query(
        `insert into provider_objects
           (tenant, connection, object_id, run, descriptor, deployment, step, field, delete_by, deletable, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (tenant, connection, object_id) do nothing`,
        [
          object.tenant,
          object.connection,
          object.objectId,
          object.run,
          object.descriptor,
          object.deployment,
          object.step,
          object.field,
          object.deleteBy,
          object.deletable,
          object.deletable ? 'open' : 'retained',
        ],
      ),
    );
  }

  async deleted(key: LedgerKey) {
    await this.settle(key, 'deleted', null, new Date());
  }

  async incident(key: LedgerKey, reason: string, at: Date) {
    await this.settle(key, 'incident', reason, at);
  }

  private async settle(
    key: LedgerKey,
    state: ProviderObjectState,
    reason: string | null,
    at: Date,
  ) {
    await withTenant(this.pool, key.tenant, (client) =>
      client.query(
        `update provider_objects set state = $4, settled_at = $5, incident = $6
         where tenant = $1 and connection = $2 and object_id = $3 and state = 'open'`,
        [key.tenant, key.connection, key.objectId, state, at.toISOString(), reason],
      ),
    );
  }

  async due(before: Date, limit: number) {
    const { rows } = await withPlatformAccess(this.pool, 'sweep provider objects', (client) =>
      client.query<ObjectRow>(`select * from due_provider_objects($1, $2)`, [
        before.toISOString(),
        limit,
      ]),
    );
    return rows.map(toRecord);
  }

  async list(tenant: string, state?: ProviderObjectState) {
    const { rows } = await withTenant(this.pool, tenant, (client) =>
      client.query<ObjectRow>(
        `select * from provider_objects where tenant = $1 and ($2::text is null or state = $2)
         order by created_at, object_id`,
        [tenant, state ?? null],
      ),
    );
    return rows.map(toRecord);
  }
}
