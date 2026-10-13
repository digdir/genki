import {
  RegistrationError,
  validateConnection,
  type Connection,
  type ConnectionRegistry,
  type ConnectionState,
} from '@genai/providers-mcp-client';
import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

export class PostgresConnections implements ConnectionRegistry {
  constructor(private readonly pool: Pool) {}

  async register(input: unknown): Promise<Connection> {
    const connection = validateConnection(input);
    const state: ConnectionState = { connection, tools: [], pending: [] };
    const inserted = await withTenant(this.pool, connection.tenant, (client) =>
      client.query(
        `insert into tool_connections (tenant, id, state) values ($1, $2, $3)
         on conflict (tenant, id) do nothing`,
        [connection.tenant, connection.id, JSON.stringify(state)],
      ),
    );
    if ((inserted.rowCount ?? 0) === 0)
      throw new RegistrationError(`connection ${connection.id} exists`);
    return structuredClone(connection);
  }

  async get(tenant: string, id: string): Promise<ConnectionState | undefined> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ state: ConnectionState }>(
        'select state from tool_connections where tenant = $1 and id = $2',
        [tenant, id],
      );
      return found.rows[0]?.state;
    });
  }

  async list(tenant: string): Promise<ConnectionState[]> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ state: ConnectionState }>(
        'select state from tool_connections where tenant = $1 order by created_at, id',
        [tenant],
      );
      return found.rows.map((r) => r.state);
    });
  }

  async save(state: ConnectionState): Promise<void> {
    const { tenant, id } = state.connection;
    await withTenant(this.pool, tenant, (client) =>
      client.query(
        `insert into tool_connections (tenant, id, state) values ($1, $2, $3)
         on conflict (tenant, id) do update set state = excluded.state, updated_at = now()`,
        [tenant, id, JSON.stringify(state)],
      ),
    );
  }
}
