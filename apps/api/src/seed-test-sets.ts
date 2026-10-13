import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPlatformTenant, ownedByPlatformTenant } from '@genai/composition';
import { parseTestSetYaml, type TestSet, type TestSetStore } from '@genai/eval';
import { platformActor, type Admin } from './admin.js';
import { seedReason, type GitDefinition, type UnreadableFile } from './definition-sources.js';

export interface GitTestSet {
  file: string;
  set: TestSet;
}

export type TestSetSeedOutcome =
  | { file: string; testSet: string; state: 'created'; version: number; task: string }
  | { file: string; testSet: string; state: 'present' }
  | { file: string; testSet: string; state: 'skipped'; errors: unknown[]; task?: string };

export const readTestSets = (dirs: string[], platformTenant: string = defaultPlatformTenant) => {
  const sets: GitTestSet[] = [];
  const unreadable: UnreadableFile[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()) {
      const file = join(dir, name);
      try {
        sets.push({
          file,
          set: ownedByPlatformTenant(parseTestSetYaml(readFileSync(file, 'utf8')), platformTenant),
        });
      } catch (error) {
        unreadable.push({ file, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { sets, unreadable };
};

const listedTestSets = (definition: GitDefinition) => {
  const spec = definition.definition.spec as { evaluation?: { testSets?: unknown } } | undefined;
  const listed = spec?.evaluation?.testSets;
  return Array.isArray(listed) ? listed.map(String) : [];
};

export const testSetsOfServices = (sets: GitTestSet[], services: GitDefinition[]) => {
  const owned = new Set<string>();
  for (const service of services.filter((d) => d.kind === 'Service')) {
    owned.add(`service:${service.tenant}/${service.id}`);
    for (const id of listedTestSets(service)) owned.add(`set:${service.tenant}/${id}`);
  }
  return sets.filter(
    ({ set }) =>
      owned.has(`set:${set.metadata.tenant}/${set.metadata.id}`) ||
      (set.spec.service !== undefined &&
        owned.has(`service:${set.metadata.tenant}/${set.spec.service}`)),
  );
};

export const seedTestSets = async (
  admin: Admin,
  store: TestSetStore,
  sets: GitTestSet[],
): Promise<TestSetSeedOutcome[]> => {
  const outcomes: TestSetSeedOutcome[] = [];
  for (const { file, set } of sets) {
    const { tenant, id, name } = set.metadata;
    if (await store.get(tenant, id)) {
      outcomes.push({ file, testSet: id, state: 'present' });
      continue;
    }
    const result = await admin.perform<TestSet>(
      platformActor('seed', tenant),
      'platform.testset.save',
      { tenant, op: 'create', id, body: { name, ...set.spec }, reason: seedReason },
    );
    outcomes.push(
      result.ok
        ? {
            file,
            testSet: id,
            state: 'created',
            version: result.value.metadata.version,
            task: result.task,
          }
        : { file, testSet: id, state: 'skipped', errors: result.errors, task: result.task },
    );
  }
  return outcomes;
};
