import { createHash } from 'node:crypto';

/** The hash a tombstone holds instead of a document id; issue 178 makes it an HMAC keyed per dataset without changing callers. */
export const tombstoneHash = (_dataset: string, id: string): string =>
  createHash('sha256').update(id).digest('hex');
