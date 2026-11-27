import { describe, expect, it } from 'vitest';
import { appendVersion, InMemoryConfigEntryStore, VersionConflict } from './config-store.js';

const entry = (reason: string) => ({
  kind: 'state',
  scope: '991825827',
  id: 'abonnement',
  spec: { reason },
  deleted: false,
  by: 'platform:test',
  reason,
  ifVersion: 0,
});

describe('appending a version', () => {
  it('two writers racing for the same version get one save and one version conflict', async () => {
    const store = new InMemoryConfigEntryStore();

    const results = await Promise.allSettled([
      appendVersion(store, entry('første')),
      appendVersion(store, entry('andre')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(VersionConflict);
    expect(await store.history('state', '991825827', 'abonnement')).toHaveLength(1);
  });
});
