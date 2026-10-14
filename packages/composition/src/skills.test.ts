import { describe, expect, it } from 'vitest';
import { skillResolver, skillShareKind } from './skills.js';

const owner = '991825827';
const viewer = '889640782';

const resolver = () =>
  skillResolver({
    definitions: {
      get: async (_kind: string, tenant: string, id: string, version?: number) =>
        tenant === owner && id === 'demo'
          ? ({ definition: { metadata: { id }, spec: {} }, version } as never)
          : undefined,
    } as never,
    configEntries: {
      latest: async () => [
        {
          kind: skillShareKind,
          scope: owner,
          id: 'demo',
          deleted: false,
          spec: { skill: 'demo', state: 'shared', version: 2 },
        },
      ],
    } as never,
  });

describe('skillResolver', () => {
  it('resolves another tenant pin only to the version Digdir approved', async () => {
    const { resolveSkill } = resolver();
    expect((await resolveSkill(viewer, 'demo', 2))?.owner).toBe(owner);
    expect(await resolveSkill(viewer, 'demo', 3)).toBeUndefined();
    expect(await resolveSkill(viewer, 'demo', 1)).toBeUndefined();
  });
});
