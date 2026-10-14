import type { Principal } from '@genai/contracts';
import { LEGACY_KEY_ISSUER } from '@genai/identity';
import { describe, expect, it } from 'vitest';
import { keyReachesDataset } from './tenant-gate.js';

const key = (scopes: string[]): Principal => ({
  kind: 'agency-system',
  issuer: LEGACY_KEY_ISSUER,
  subject: 'key-1',
  tenant: '991825827',
  scopes,
});

describe('keyReachesDataset', () => {
  it('lets an ingest key reach only the datasets it is granted', () => {
    const ingest = key(['legacy:ingest', 'grant:dataset:ds-a']);
    expect(keyReachesDataset(ingest, ['991825827/ds-a', 'ds-a'])).toBe(true);
    expect(keyReachesDataset(ingest, ['991825827/ds-b', 'ds-b'])).toBe(false);
  });

  it('lets an admin key and a person reach every dataset in their organisation', () => {
    expect(keyReachesDataset(key(['legacy:admin']), ['ds-b'])).toBe(true);
    expect(
      keyReachesDataset(
        { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
        ['ds-b'],
      ),
    ).toBe(true);
  });
});
