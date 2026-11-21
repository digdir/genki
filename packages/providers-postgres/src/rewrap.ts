import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { LocalKeyWrapper } from './crypto.js';
import { withPlatformAccess } from './tenancy.js';

export interface RewrapFailure {
  tenant: string;
  scopeSha256: string;
  reason: string;
}

export interface RewrapProgress {
  active: number;
  dryRun: boolean;
  pending: number;
  checked: number;
  rewrapped: number;
  failed: number;
}

export interface RewrapResult extends RewrapProgress {
  failures: RewrapFailure[];
}

const purpose = 'content-key-rewrap';
const maxFailuresListed = 50;

const notInActiveForm = `not (length(wrapped) = $1 and substring(wrapped from 1 for $2) = $3)`;
export const rewrapContentKeys = async (
  pool: Pool,
  wrapper: LocalKeyWrapper,
  options: {
    dryRun?: boolean;
    batchSize?: number;
    onProgress?: (progress: RewrapProgress) => void;
  } = {},
): Promise<RewrapResult> => {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error('the batch size must be a whole number of at least 1');
  const { length, prefix } = wrapper.wrappedForm;
  const form = [length, prefix.length, prefix];

  const pending = await withPlatformAccess(pool, purpose, async (client) => {
    const found = await client.query<{ count: string }>(
      `select count(*) from content_keys where ${notInActiveForm}`,
      form,
    );
    return Number(found.rows[0]?.count ?? 0);
  });
  const progress: RewrapProgress = {
    active: wrapper.active,
    dryRun,
    pending,
    checked: 0,
    rewrapped: 0,
    failed: 0,
  };
  const failures: RewrapFailure[] = [];
  const report = () => options.onProgress?.({ ...progress });
  report();

  let after = { tenant: '', scope: '' };
  for (;;) {
    const rows = await withPlatformAccess(pool, purpose, async (client) => {
      const batch = await client.query<{ tenant: string; scope: string; wrapped: Buffer }>(
        `select tenant, scope, wrapped from content_keys
          where ${notInActiveForm} and (tenant, scope) > ($4, $5)
          order by tenant, scope limit $6 for update`,
        [...form, after.tenant, after.scope, batchSize],
      );
      for (const row of batch.rows) {
        progress.checked += 1;
        let rewrapped: Buffer;
        try {
          rewrapped = await wrapper.wrap(await wrapper.unwrap(row.wrapped));
        } catch (error) {
          progress.failed += 1;
          if (failures.length < maxFailuresListed)
            failures.push({
              tenant: row.tenant,
              scopeSha256: createHash('sha256').update(row.scope).digest('hex'),
              reason: error instanceof Error ? error.message : 'unknown',
            });
          continue;
        }
        if (dryRun) continue;
        const updated = await client.query(
          `update content_keys set wrapped = $4
            where tenant = $1 and scope = $2 and wrapped = $3`,
          [row.tenant, row.scope, row.wrapped, rewrapped],
        );
        progress.rewrapped += updated.rowCount ?? 0;
      }
      return batch.rows;
    });
    const last = rows.at(-1);
    if (!last) break;
    after = { tenant: last.tenant, scope: last.scope };
    report();
    if (rows.length < batchSize) break;
  }
  return { ...progress, failures };
};
