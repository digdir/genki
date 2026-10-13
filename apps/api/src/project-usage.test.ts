import { describe, expect, it } from 'vitest';
import { batchItemKind, type BatchItem } from './batch-runs.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { projectTasks } from './project-usage.js';
import { projectKind, projectRunKind } from './projects.js';

const tenant = '991825827';

const item = (run: string, index: number, task: string, attempts = 1): BatchItem => ({
  run,
  index,
  document: { id: `d${index}`, title: `Dokument ${index}` },
  status: 'succeeded',
  attempts,
  pass: attempts,
  task,
  sources: [],
  models: [],
  tokens: { input: 100, output: 20 },
  costMicroNok: 8000,
});

const save = (store: InMemoryConfigEntryStore, kind: string, id: string, spec: unknown) =>
  appendVersion(store, {
    kind,
    scope: tenant,
    id,
    spec,
    deleted: false,
    by: 'test',
    reason: 'test',
  });

describe('tasks that belong to a project', () => {
  it('attributes every attempt of a project run to its project, and nothing from other runs', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, projectKind, 'arsrapporter', { name: 'Årsrapporter 2024' });
    await save(store, projectRunKind, 'run-1', {
      project: 'arsrapporter',
      run: 'run-1',
      service: 'oppsummering',
      trigger: 'subscription',
      month: '2026-10',
      startedAt: '2026-10-06T08:00:00Z',
    });
    await save(store, batchItemKind, 'run-1/00000', item('run-1', 0, 'a'));
    await save(store, batchItemKind, 'run-1/00001', item('run-1', 1, 'b'));
    await save(store, batchItemKind, 'run-1/00001', item('run-1', 1, 'c', 2));
    await save(store, batchItemKind, 'run-2/00000', item('run-2', 0, 'x'));

    const found = await projectTasks(store, tenant);

    expect(found.map((f) => f.task).sort()).toEqual(['a', 'b', 'c']);
    expect(found.every((f) => f.project === 'arsrapporter' && f.name === 'Årsrapporter 2024')).toBe(
      true,
    );
    expect(await projectTasks(store, '889640782')).toEqual([]);
  });
});
