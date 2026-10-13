import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGitDefinitions } from './definition-sources.js';
import { readTestSets, seedTestSets, testSetsOfServices } from './seed-test-sets.js';
import { bootPlatform, digdir } from './testkit.js';

const repo = join(import.meta.dirname, '..', '..', '..');
const testSetDirs = [
  join(repo, 'packages', 'eval', 'testsets'),
  join(repo, 'packages', 'jobs', 'examples', 'testsets'),
];
const services = readGitDefinitions([
  { dir: join(import.meta.dirname, '..', 'config', 'local', 'services') },
]).definitions;

describe('seeding test sets that belong to seeded services', () => {
  it('reads every local test set file without errors', () => {
    const { sets, unreadable } = readTestSets(testSetDirs);

    expect(unreadable).toEqual([]);
    expect(sets.map((s) => s.set.metadata.id)).toContain('ka-kudos-draft');
  });

  it('picks the KA draft and the sets services list under evaluation, and leaves sets of no local service out', () => {
    const owned = testSetsOfServices(readTestSets(testSetDirs).sets, services).map(
      (s) => s.set.metadata.id,
    );

    expect(owned).toEqual(expect.arrayContaining(['ka-kudos-draft', 'nynorsk-referanse']));
    expect(owned).not.toContain('headless-rag-ue-42');
  });

  it('creates the KA draft through the admin task as platform:seed, so the KA quality tab lists it', async () => {
    const { platform, admin } = await bootPlatform();
    const ka = readTestSets(testSetDirs).sets.filter((s) => s.set.metadata.id === 'ka-kudos-draft');

    const outcomes = await seedTestSets(admin, platform.evalStores.testSets, ka);

    expect(outcomes).toMatchObject([{ testSet: 'ka-kudos-draft', state: 'created', version: 1 }]);
    expect(await platform.evalStores.testSets.list(digdir, 'kunnskapsassistenten')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ id: 'ka-kudos-draft' }) }),
    ]);
    expect(await admin.audit(digdir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.testset.save',
          actor: 'platform:seed',
          outcome: 'applied',
        }),
      ]),
    );
  });

  it('leaves a test set that already exists alone, so edits made in the portal survive a restart', async () => {
    const { platform, admin } = await bootPlatform();
    const ka = readTestSets(testSetDirs).sets.filter((s) => s.set.metadata.id === 'ka-kudos-draft');
    await seedTestSets(admin, platform.evalStores.testSets, ka);

    const again = await seedTestSets(admin, platform.evalStores.testSets, ka);

    expect(again).toMatchObject([{ testSet: 'ka-kudos-draft', state: 'present' }]);
    expect(
      (await platform.evalStores.testSets.get(digdir, 'ka-kudos-draft'))?.metadata.version,
    ).toBe(1);
  });
});
