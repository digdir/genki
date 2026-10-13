import { batchItemKind, type BatchItem } from './batch-runs.js';
import type { ConfigEntryStore } from './config-store.js';
import { projectKind, projectRunKind, type Project, type ProjectRun } from './projects.js';

export interface ProjectTask {
  task: string;
  project: string;
  name: string;
}

export const projectTasks = async (
  store: ConfigEntryStore,
  tenant: string,
): Promise<ProjectTask[]> => {
  const links = (await store.latest({ kind: projectRunKind, scope: tenant })).map(
    (e) => e.spec as ProjectRun,
  );
  if (links.length === 0) return [];
  const names = new Map(
    (await store.latest({ kind: projectKind, scope: tenant })).map((e) => [
      e.id,
      (e.spec as Project).name,
    ]),
  );
  const projectOfRun = new Map(links.map((l) => [l.run, l.project]));
  const out = new Map<string, ProjectTask>();
  const add = (item: BatchItem) => {
    const project = projectOfRun.get(item.run);
    if (!project || !item.task || out.has(item.task)) return;
    out.set(item.task, { task: item.task, project, name: names.get(project) ?? project });
  };
  for (const entry of await store.latest({ kind: batchItemKind, scope: tenant })) {
    const item = entry.spec as BatchItem;
    if (!projectOfRun.has(item.run)) continue;
    add(item);
    if (item.attempts > 1)
      for (const earlier of await store.history(batchItemKind, tenant, entry.id))
        add(earlier.spec as BatchItem);
  }
  return [...out.values()];
};
