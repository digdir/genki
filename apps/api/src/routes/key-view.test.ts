import { describe, expect, it } from 'vitest';
import { keyView, type TenantApiKey } from './portal-routes.js';

const key = (extra: Partial<TenantApiKey> = {}): TenantApiKey => ({
  id: 'key-ka',
  name: 'Kunnskapsassistenten',
  digest: '0'.repeat(64),
  tenant: '991825827',
  scopes: ['query'],
  datasets: [],
  agents: [],
  ...extra,
});

describe('keyView', () => {
  it('shows when a key was made, when it was last used and how many calls it has had', () => {
    expect(
      keyView(
        key({
          createdAt: '2026-10-01T08:00:00.000Z',
          lastUsedAt: '2026-11-03T13:02:00.000Z',
          usageCount: 1234,
        }),
      ),
    ).toMatchObject({
      createdAt: '2026-10-01T08:00:00.000Z',
      lastUsedAt: '2026-11-03T13:02:00.000Z',
      usageCount: 1234,
    });
  });

  it('gives null, not zero, when the key store keeps no count', () => {
    expect(keyView(key())).toMatchObject({ createdAt: null, lastUsedAt: null, usageCount: null });
  });
});
