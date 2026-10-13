import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { KeyWrapper } from './crypto.js';

const CACHE_MS = 30_000;

export class ContentKeys {
  readonly #cache = new Map<string, { key: Buffer; until: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly wrapper: KeyWrapper,
  ) {}

  async get(tenant: string, scope: string, create: boolean): Promise<Buffer | undefined> {
    const id = `${tenant}\u0000${scope}`;
    const cached = this.#cache.get(id);
    if (cached && cached.until > Date.now()) return cached.key;

    if (create) {
      const wrapped = await this.wrapper.wrap(randomBytes(32));
      await this.pool.query(
        'insert into content_keys (tenant, scope, wrapped) values ($1, $2, $3) on conflict do nothing',
        [tenant, scope, wrapped],
      );
    }
    const found = await this.pool.query<{ wrapped: Buffer }>(
      'select wrapped from content_keys where tenant = $1 and scope = $2',
      [tenant, scope],
    );
    const row = found.rows[0];
    if (!row) return undefined;
    const key = await this.wrapper.unwrap(row.wrapped);
    this.#cache.set(id, { key, until: Date.now() + CACHE_MS });
    return key;
  }

  async erase(tenant: string, scope: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from content_keys where tenant = $1 and scope = $2', [
        tenant,
        scope,
      ]);
      await client.query(
        'insert into erased_scopes (tenant, scope) values ($1, $2) on conflict (tenant, scope) do update set erased_at = now()',
        [tenant, scope],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    this.#cache.delete(`${tenant}\u0000${scope}`);
  }
}
