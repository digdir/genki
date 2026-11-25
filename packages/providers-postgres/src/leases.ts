import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

export interface LeaseOptions {
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
}

export class LeaseBusyError extends Error {}

const take = (pool: Pool, tenant: string, name: string, holder: string, ttlMs: number) =>
  withTenant(pool, tenant, async (client) => {
    const taken = await client.query(
      `insert into request_leases (tenant, name, holder, until)
       values ($1, $2, $3, now() + make_interval(secs => $4))
       on conflict (tenant, name) do update set holder = excluded.holder, until = excluded.until
         where request_leases.until <= now()
       returning holder`,
      [tenant, name, holder, ttlMs / 1000],
    );
    return taken.rowCount === 1;
  });

const extend = (pool: Pool, tenant: string, name: string, holder: string, ttlMs: number) =>
  withTenant(pool, tenant, (client) =>
    client.query(
      `update request_leases set until = now() + make_interval(secs => $4)
       where tenant = $1 and name = $2 and holder = $3`,
      [tenant, name, holder, ttlMs / 1000],
    ),
  );

const release = (pool: Pool, tenant: string, name: string, holder: string) =>
  withTenant(pool, tenant, (client) =>
    client.query('delete from request_leases where tenant = $1 and name = $2 and holder = $3', [
      tenant,
      name,
      holder,
    ]),
  );

/** Runs `work` while this process alone holds the named lease, holding no connection meanwhile. */
export const withLease = async <T>(
  pool: Pool,
  tenant: string,
  name: string,
  work: () => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> => {
  const ttlMs = options.ttlMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + (options.waitMs ?? 60_000);
  const holder = randomUUID();
  while (!(await take(pool, tenant, name, holder, ttlMs))) {
    if (Date.now() > deadline) throw new LeaseBusyError(`${name} is busy`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const renewal = setInterval(
    () => void extend(pool, tenant, name, holder, ttlMs).catch(() => undefined),
    ttlMs / 3,
  );
  renewal.unref();
  try {
    return await work();
  } finally {
    clearInterval(renewal);
    await release(pool, tenant, name, holder).catch(() => undefined);
  }
};
