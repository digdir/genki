import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';

const TENANT = 'platform';
const SCOPE = 'identities';

export class PostgresIdentities {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async remember(issuer: string, subject: string, personId: string): Promise<void> {
    const key = await this.keys.get(TENANT, SCOPE, true);
    if (!key) throw new Error('no content key');
    await this.pool.query(
      `insert into identities (issuer, subject, person) values ($1, $2, $3)
       on conflict (issuer, subject) do update set person = excluded.person, updated_at = now()`,
      [issuer, subject, seal(key, Buffer.from(personId), `identity:${issuer}\u0000${subject}`)],
    );
  }

  async personId(issuer: string, subject: string): Promise<string | undefined> {
    const found = await this.pool.query<{ person: Buffer }>(
      'select person from identities where issuer = $1 and subject = $2',
      [issuer, subject],
    );
    const row = found.rows[0];
    const key = row && (await this.keys.get(TENANT, SCOPE, false));
    if (!row || !key) return undefined;
    try {
      return open(key, row.person, `identity:${issuer}\u0000${subject}`).toString();
    } catch {
      return undefined;
    }
  }

  async forget(issuer: string, subject: string): Promise<void> {
    await this.pool.query('delete from identities where issuer = $1 and subject = $2', [
      issuer,
      subject,
    ]);
  }
}
