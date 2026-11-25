import type {
  BinderStep,
  ClaimWrite,
  DnsCheck,
  HostnameClaim,
  HostnameClaimState,
  HostnameClaimStore,
} from '@genai/kernel';
import type { Pool, PoolClient } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

interface ClaimRow {
  id: string;
  tenant: string;
  client: string;
  service: string;
  hostname: string;
  environment: string | null;
  redirect_to: string | null;
  apex: boolean;
  assigned: boolean;
  zone: string | null;
  record_name: string | null;
  token: string;
  state: HostnameClaimState;
  step: BinderStep;
  failure: string | null;
  message: string | null;
  certificate_id: string | null;
  dns_check: DnsCheck | null;
  missing_since: Date | null;
  state_since: Date;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  version: number;
}

const toClaim = (row: ClaimRow): HostnameClaim => ({
  id: row.id,
  tenant: row.tenant,
  client: row.client,
  service: row.service,
  hostname: row.hostname,
  ...(row.environment === null ? {} : { environment: row.environment }),
  ...(row.redirect_to === null ? {} : { redirectTo: row.redirect_to }),
  apex: row.apex,
  assigned: row.assigned,
  ...(row.zone === null ? {} : { zone: row.zone }),
  ...(row.record_name === null ? {} : { recordName: row.record_name }),
  token: row.token,
  state: row.state,
  step: row.step,
  ...(row.failure === null ? {} : { failure: row.failure }),
  ...(row.message === null ? {} : { message: row.message }),
  ...(row.certificate_id === null ? {} : { certificateId: row.certificate_id }),
  ...(row.dns_check === null ? {} : { check: row.dns_check }),
  ...(row.missing_since === null ? {} : { missingSince: row.missing_since.toISOString() }),
  stateSince: row.state_since.toISOString(),
  createdAt: row.created_at.toISOString(),
  createdBy: row.created_by,
  updatedAt: row.updated_at.toISOString(),
  version: row.version,
});

const values = (c: HostnameClaim) => [
  c.id,
  c.tenant,
  c.client,
  c.service,
  c.hostname,
  c.environment ?? null,
  c.redirectTo ?? null,
  c.apex,
  c.assigned,
  c.zone ?? null,
  c.recordName ?? null,
  c.token,
  c.state,
  c.step,
  c.failure ?? null,
  c.message ?? null,
  c.certificateId ?? null,
  c.check ? JSON.stringify(c.check) : null,
  c.missingSince ?? null,
  c.stateSince,
  c.createdAt,
  c.createdBy,
  c.updatedAt,
  c.version,
];

const uniqueViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === '23505' &&
  (error as { constraint?: unknown }).constraint === 'hostname_claims_held';

const savepoint = async <T>(client: PoolClient, run: () => Promise<T>): Promise<T | 'taken'> => {
  await client.query('savepoint claim_write');
  try {
    const result = await run();
    await client.query('release savepoint claim_write');
    return result;
  } catch (error) {
    await client.query('rollback to savepoint claim_write');
    if (uniqueViolation(error)) return 'taken';
    throw error;
  }
};

export class PostgresHostnameClaims implements HostnameClaimStore {
  constructor(private readonly pool: Pool) {}

  async create(claim: HostnameClaim): Promise<'ok' | 'taken'> {
    return withTenant(this.pool, claim.tenant, (client) =>
      savepoint(client, async () => {
        await client.query(
          `insert into hostname_claims (id, tenant, client, service, hostname, environment,
             redirect_to, apex, assigned, zone, record_name, token, state, step, failure, message,
             certificate_id, dns_check, missing_since, state_since, created_at, created_by,
             updated_at, version)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23, $24)`,
          values(claim),
        );
        return 'ok' as const;
      }),
    );
  }

  async get(tenant: string, id: string) {
    const { rows } = await withTenant(this.pool, tenant, (client) =>
      client.query<ClaimRow>('select * from hostname_claims where tenant = $1 and id = $2', [
        tenant,
        id,
      ]),
    );
    return rows[0] && toClaim(rows[0]);
  }

  async list(tenant: string) {
    const { rows } = await withTenant(this.pool, tenant, (client) =>
      client.query<ClaimRow>(
        'select * from hostname_claims where tenant = $1 order by created_at, id',
        [tenant],
      ),
    );
    return rows.map(toClaim);
  }

  async find(id: string) {
    const { rows } = await withPlatformAccess(this.pool, 'hostname binder', (client) =>
      client.query<ClaimRow>('select * from find_hostname_claim($1)', [id]),
    );
    return rows[0] && toClaim(rows[0]);
  }

  async inStates(states: readonly HostnameClaimState[], limit: number) {
    const { rows } = await withPlatformAccess(this.pool, 'hostname claims', (client) =>
      client.query<ClaimRow>('select * from hostname_claims_in($1, $2)', [[...states], limit]),
    );
    return rows.map(toClaim);
  }

  async holder(hostname: string) {
    const { rows } = await withPlatformAccess(this.pool, 'hosted hostname', (client) =>
      client.query<ClaimRow>('select * from hostname_claim_holder($1)', [hostname]),
    );
    return rows[0] && toClaim(rows[0]);
  }

  async update(next: HostnameClaim): Promise<ClaimWrite> {
    return withTenant(this.pool, next.tenant, (client) =>
      savepoint(client, async () => {
        const result = await client.query(
          `update hostname_claims set client = $3, service = $4, hostname = $5, environment = $6,
             redirect_to = $7, apex = $8, assigned = $9, zone = $10, record_name = $11,
             token = $12, state = $13, step = $14, failure = $15, message = $16,
             certificate_id = $17, dns_check = $18, missing_since = $19, state_since = $20,
             created_at = $21, created_by = $22, updated_at = $23, version = $24
           where id = $1 and tenant = $2 and version = $24 - 1`,
          values(next),
        );
        return (result.rowCount ?? 0) > 0 ? ('ok' as const) : ('stale' as const);
      }),
    );
  }
}
