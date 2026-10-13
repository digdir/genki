import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAdmin } from './admin.js';
import {
  createDefinitionSourcesModule,
  driftReport,
  readGitDefinitions,
  seedDefinitions,
} from './definition-sources.js';
import type { ModuleDeps, MountDeps } from './platform-modules.js';
import { digdir, files, klarsprak, plugins, settingDefinitions } from './testkit.js';

const gitConfig = (definitions: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), 'definition-sources-'));
  const dir = join(root, 'services');
  const promptsDir = join(root, 'prompts');
  mkdirSync(dir);
  mkdirSync(promptsDir);
  for (const [path, text] of Object.entries(files))
    writeFileSync(join(root, path), text as string, 'utf8');
  for (const [name, definition] of Object.entries(definitions))
    writeFileSync(join(dir, name), stringify(definition), 'utf8');
  return {
    dir,
    promptsDir,
    write: (name: string, text: string) => writeFileSync(join(dir, name), text),
  };
};

const setup = () => {
  const store = new InMemoryDefinitionStore(plugins);
  const admin = createAdmin({ store, plugins, settings: new SettingsRegistry(settingDefinitions) });
  return { store, admin };
};

describe('definitions from git', () => {
  it('seeding publishes through the admin task as platform:seed and is audited in the tenant log', async () => {
    const { store, admin } = setup();
    const source = gitConfig({ 'klarsprak.yaml': klarsprak() });

    const outcomes = await seedDefinitions(admin, store, readGitDefinitions([source]).definitions);

    expect(outcomes).toMatchObject([{ state: 'published', version: 1 }]);
    expect(await store.get('Service', digdir, 'klarsprak')).toMatchObject({
      publishedBy: 'platform:seed',
      reason: 'local configuration',
      files,
    });
    expect(await admin.audit(digdir)).toMatchObject([
      {
        action: 'platform.service.publish',
        actor: 'platform:seed',
        outcome: 'applied',
        target: 'Service:klarsprak@1',
      },
    ]);
  });

  it('a configured platform tenant owns the definitions seeded for Digdir', async () => {
    const { store, admin } = setup();
    const source = gitConfig({ 'klarsprak.yaml': klarsprak() });

    const read = readGitDefinitions([source], '213192752').definitions;
    const outcomes = await seedDefinitions(admin, store, read);

    expect(read).toMatchObject([{ tenant: '213192752', id: 'klarsprak' }]);
    expect(outcomes).toMatchObject([{ state: 'published', version: 1 }]);
    expect(await store.get('Service', '213192752', 'klarsprak')).toBeDefined();
    expect(await store.get('Service', digdir, 'klarsprak')).toBeUndefined();
  });

  it('seeding leaves a definition that is already published alone', async () => {
    const { store, admin } = setup();
    await store.publish(klarsprak(), 'employee:test:kari', 'endret i portalen', files);
    const source = gitConfig({ 'klarsprak.yaml': klarsprak() });

    const outcomes = await seedDefinitions(admin, store, readGitDefinitions([source]).definitions);

    expect(outcomes).toMatchObject([{ state: 'present' }]);
    expect(await store.versions('Service', digdir, 'klarsprak')).toHaveLength(1);
    expect(await admin.audit(digdir)).toEqual([]);
  });

  it('the drift report tells in-sync, drifted, not published and missing from git apart', async () => {
    const { store, admin } = setup();
    const source = gitConfig({
      'klarsprak.yaml': klarsprak(),
      'endret.yaml': klarsprak({ id: 'endret' }),
      'gammel.yaml': klarsprak({ id: 'gammel' }),
    });
    await seedDefinitions(admin, store, readGitDefinitions([source]).definitions);
    const changed = klarsprak({ id: 'endret' });
    changed.spec.purpose = 'Endret i portalen';
    await store.publish(changed, 'employee:test:kari', 'ny formulering', files);
    source.write('gammel.yaml', '');
    source.write('ny.yaml', stringify(klarsprak({ id: 'ny' })));
    source.write('ødelagt.yaml', 'metadata: [');

    const report = await driftReport(store, plugins, readGitDefinitions([source]));

    expect(report.summary).toEqual({
      'in-sync': 1,
      drifted: 1,
      'not-published': 1,
      'missing-from-git': 1,
    });
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'klarsprak', state: 'in-sync' }),
        expect.objectContaining({
          id: 'endret',
          state: 'drifted',
          differences: ['definition.spec.purpose'],
          published: expect.objectContaining({ version: 2, by: 'employee:test:kari' }),
        }),
        expect.objectContaining({ id: 'ny', state: 'not-published' }),
        expect.objectContaining({ id: 'gammel', state: 'missing-from-git' }),
      ]),
    );
    expect(report.unreadable.map((u) => u.file)).toEqual([
      join(source.dir, 'gammel.yaml'),
      join(source.dir, 'ødelagt.yaml'),
    ]);
  });

  it('the drift report route is for operators only', async () => {
    const { store } = setup();
    const source = gitConfig({ 'klarsprak.yaml': klarsprak() });
    const people: Record<string, Principal> = {
      drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
      kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
    };
    const app = new Hono();
    createDefinitionSourcesModule([source])({
      definitions: store,
      plugins,
    } as unknown as ModuleDeps).mount(app, {
      authenticate: async (request: Request) =>
        people[request.headers.get('authorization')?.slice(7) ?? ''],
    } as unknown as MountDeps);
    const get = (who: string) =>
      app.request('/operator/definitions/drift', { headers: { authorization: `Bearer ${who}` } });

    const operator = await get('drift');

    expect(operator.status).toBe(200);
    expect(await operator.json()).toMatchObject({ summary: { 'not-published': 1 } });
    expect((await get('kari')).status).toBe(403);
    expect((await get('ingen')).status).toBe(401);
  });
});
