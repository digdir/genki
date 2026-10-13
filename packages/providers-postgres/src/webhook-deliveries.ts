import type { WebhookDelivery, WebhookDeliveryStore } from '@genai/identity';
import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

interface DeliveryRow {
  id: string;
  tenant: string;
  client: string;
  event: WebhookDelivery['event'];
  at: Date;
  ok: boolean;
  status: number | null;
  error: string | null;
}

const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  tenant: row.tenant,
  client: row.client,
  event: row.event,
  at: row.at.toISOString(),
  ok: row.ok,
  ...(row.status === null ? {} : { status: row.status }),
  ...(row.error === null ? {} : { error: row.error }),
});

export class PostgresWebhookDeliveries implements WebhookDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async record(delivery: WebhookDelivery): Promise<void> {
    await withTenant(this.pool, delivery.tenant, (client) =>
      client.query(
        `insert into webhook_deliveries (id, tenant, client, event, at, ok, status, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          delivery.id,
          delivery.tenant,
          delivery.client,
          delivery.event,
          delivery.at,
          delivery.ok,
          delivery.status ?? null,
          delivery.error ?? null,
        ],
      ),
    );
  }

  async recent(tenant: string, client: string, limit: number): Promise<WebhookDelivery[]> {
    return withTenant(this.pool, tenant, async (db) =>
      (
        await db.query<DeliveryRow>(
          `select * from webhook_deliveries where tenant = $1 and client = $2
           order by at desc, id limit $3`,
          [tenant, client, limit],
        )
      ).rows.map(toDelivery),
    );
  }
}
