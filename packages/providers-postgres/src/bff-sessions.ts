import type { Pool, PoolClient } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';
import { withLease } from './leases.js';
import { withPlatformAccess, withTenant } from './tenancy.js';

const SCOPE = 'bff-sessions';

export interface BffSessionRow {
  hostname: string;
  client: string;
  expiresAt: number;
  payload: string;
  logoutKeys?: readonly string[];
}

interface Stored {
  hostname: string;
  client: string;
  sealed: Buffer;
  expires_at: Date;
}

const rowAad = (tenant: string, idHash: string, hostname: string, client: string) =>
  `bff-session:${tenant}/${idHash}/${hostname}/${client}`;

/** Sessions of the BFF (ADR 0061): the person's tokens sealed with the tenant's content key. */
export class PostgresBffSessions {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async create(tenant: string, idHash: string, row: BffSessionRow): Promise<void> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    const sealed = seal(
      key,
      Buffer.from(row.payload),
      rowAad(tenant, idHash, row.hostname, row.client),
    );
    await withTenant(this.pool, tenant, async (client) => {
      await client.query('delete from bff_sessions where tenant = $1 and expires_at <= now()', [
        tenant,
      ]);
      await client.query(
        `insert into bff_sessions (tenant, id_hash, hostname, client, sealed, expires_at, logout_keys)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenant,
          idHash,
          row.hostname,
          row.client,
          sealed,
          new Date(row.expiresAt),
          [...(row.logoutKeys ?? [])],
        ],
      );
    });
  }

  async claim(tenant: string, idHash: string, row: BffSessionRow): Promise<boolean> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    const sealed = seal(
      key,
      Buffer.from(row.payload),
      rowAad(tenant, idHash, row.hostname, row.client),
    );
    return withTenant(this.pool, tenant, async (client) => {
      await client.query('delete from bff_sessions where tenant = $1 and expires_at <= now()', [
        tenant,
      ]);
      const inserted = await client.query(
        `insert into bff_sessions (tenant, id_hash, hostname, client, sealed, expires_at, logout_keys)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (tenant, id_hash) do nothing`,
        [
          tenant,
          idHash,
          row.hostname,
          row.client,
          sealed,
          new Date(row.expiresAt),
          [...(row.logoutKeys ?? [])],
        ],
      );
      return (inserted.rowCount ?? 0) > 0;
    });
  }

  /** Back-channel logout: the sessions of a person's login, in whichever tenant they are. */
  async endByLogoutKeys(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return withPlatformAccess(this.pool, 'bff back-channel logout', async (client) => {
      const { rows } = await client.query<{ ended: number }>(
        'select end_bff_sessions_by_logout_keys($1) as ended',
        [[...keys]],
      );
      return rows[0]?.ended ?? 0;
    });
  }

  async get(tenant: string, idHash: string): Promise<BffSessionRow | undefined> {
    const found = await withTenant(this.pool, tenant, (client) =>
      this.#read(client, tenant, idHash),
    );
    return found && this.#open(tenant, idHash, found);
  }

  /** Changes a session under a lease, so two replicas never refresh the same tokens at once. */
  async update(
    tenant: string,
    idHash: string,
    change: (row: BffSessionRow) => Promise<BffSessionRow | undefined>,
  ): Promise<BffSessionRow | undefined> {
    return withLease(this.pool, tenant, `bff-session:${idHash}`, async () => {
      const current = await this.get(tenant, idHash);
      if (!current) return undefined;
      const next = await change(current);
      if (!next) {
        await this.delete(tenant, idHash);
        return undefined;
      }
      const key = await this.keys.get(tenant, SCOPE, false);
      if (!key) return undefined;
      const sealed = seal(
        key,
        Buffer.from(next.payload),
        rowAad(tenant, idHash, current.hostname, current.client),
      );
      await withTenant(this.pool, tenant, (client) =>
        client.query(
          `update bff_sessions set sealed = $3, expires_at = least(expires_at, $4), updated_at = now()
           where tenant = $1 and id_hash = $2`,
          [tenant, idHash, sealed, new Date(next.expiresAt)],
        ),
      );
      return { ...next, hostname: current.hostname, client: current.client };
    });
  }

  async delete(tenant: string, idHash: string): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      const deleted = await client.query(
        'delete from bff_sessions where tenant = $1 and id_hash = $2',
        [tenant, idHash],
      );
      return (deleted.rowCount ?? 0) > 0;
    });
  }

  async seal(tenant: string, purpose: string, plaintext: string): Promise<string> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    return seal(key, Buffer.from(plaintext), `bff:${tenant}:${purpose}`).toString('base64url');
  }

  async open(tenant: string, purpose: string, sealed: string): Promise<string | undefined> {
    const key = await this.keys.get(tenant, SCOPE, false);
    if (!key) return undefined;
    try {
      return open(key, Buffer.from(sealed, 'base64url'), `bff:${tenant}:${purpose}`).toString();
    } catch {
      return undefined;
    }
  }

  async #read(client: PoolClient, tenant: string, idHash: string) {
    const found = await client.query<Stored>(
      `select hostname, client, sealed, expires_at from bff_sessions
       where tenant = $1 and id_hash = $2 and expires_at > now()`,
      [tenant, idHash],
    );
    return found.rows[0];
  }

  async #open(tenant: string, idHash: string, row: Stored): Promise<BffSessionRow | undefined> {
    const key = await this.keys.get(tenant, SCOPE, false);
    if (!key) return undefined;
    try {
      return {
        hostname: row.hostname,
        client: row.client,
        expiresAt: row.expires_at.getTime(),
        payload: open(key, row.sealed, rowAad(tenant, idHash, row.hostname, row.client)).toString(),
      };
    } catch {
      return undefined;
    }
  }
}
