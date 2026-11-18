import { adoptionKind, blockKey } from '@genai/composition';
import type { DefinitionStore } from '@genai/definitions';
import type { ActorNames } from './actor-names.js';
import type { ConfigEntryStore } from './config-store.js';

export interface DatasetReader {
  kind: 'service' | 'adoption';
  tenant: string;
  id: string;
  name: string;
  addedAt?: string;
  addedBy?: string;
  addedByName?: string;
}

export interface DatasetReaderDeps {
  definitions: Pick<DefinitionStore, 'capabilities'> & Partial<Pick<DefinitionStore, 'versions'>>;
  configEntries: Pick<ConfigEntryStore, 'latest'> & Partial<Pick<ConfigEntryStore, 'history'>>;
  resolve(idOrAlias: string): string | undefined;
  names?: Pick<ActorNames, 'namesOf'>;
}

const mentions = (value: unknown, matches: (text: string) => boolean): boolean => {
  if (typeof value === 'string') return matches(value);
  if (Array.isArray(value)) return value.some((v) => mentions(v, matches));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => mentions(v, matches));
  return false;
};

/** The first of the newest unbroken run of entries that still hold the dataset. */
const firstOfRun = <T>(newestLast: T[], holds: (entry: T) => boolean) => {
  let first: T | undefined;
  for (let i = newestLast.length - 1; i >= 0; i--) {
    const entry = newestLast[i] as T;
    if (!holds(entry)) break;
    first = entry;
  }
  return first;
};

const added = async (
  deps: DatasetReaderDeps,
  reader: DatasetReader,
  dataset: string,
): Promise<{ at: string; by: string } | undefined> => {
  if (reader.kind === 'service') {
    const versions = (await deps.definitions.versions?.('Service', reader.tenant, reader.id)) ?? [];
    const matches = (text: string) => (deps.resolve(text) ?? text) === dataset;
    const first = firstOfRun(versions, (v) => mentions(v.definition, matches));
    return first ? { at: first.publishedAt, by: first.publishedBy } : undefined;
  }
  const history =
    (await deps.configEntries.history?.(adoptionKind, reader.tenant, reader.id)) ?? [];
  const first = firstOfRun(history, (e) => !e.deleted);
  return first ? { at: first.at, by: first.by } : undefined;
};

export const datasetReaders = async (
  deps: DatasetReaderDeps,
  dataset: string,
): Promise<DatasetReader[]> => {
  const readers = new Map<string, DatasetReader>();
  for (const compiled of await deps.definitions.capabilities()) {
    const { tenant, id } = compiled.service;
    const key = `service:${tenant}/${id}`;
    if (readers.has(key)) continue;
    const config = compiled.capability.config as {
      knowledge?: { datasets?: { dataset?: string }[] };
    };
    const reads = (config.knowledge?.datasets ?? []).some(
      (d) => d.dataset !== undefined && (deps.resolve(d.dataset) ?? d.dataset) === dataset,
    );
    if (reads) readers.set(key, { kind: 'service', tenant, id, name: compiled.serviceName ?? id });
  }
  for (const entry of await deps.configEntries.latest({ kind: adoptionKind })) {
    if (entry.deleted || entry.id !== blockKey('dataset', dataset)) continue;
    readers.set(`adoption:${entry.scope}`, {
      kind: 'adoption',
      tenant: entry.scope,
      id: entry.id,
      name: dataset,
    });
  }
  const sorted = [...readers.values()].sort((a, b) =>
    `${a.kind}:${a.tenant}/${a.id}`.localeCompare(`${b.kind}:${b.tenant}/${b.id}`),
  );
  const when = await Promise.all(sorted.map((r) => added(deps, r, dataset)));
  const names =
    (await deps.names?.namesOf(when.flatMap((w) => (w ? [w.by] : [])))) ??
    new Map<string, string>();
  return sorted.map((reader, i) => {
    const w = when[i];
    if (!w) return reader;
    const name = names.get(w.by);
    return { ...reader, addedAt: w.at, addedBy: w.by, ...(name ? { addedByName: name } : {}) };
  });
};

export const datasetReaderCounts = async (
  deps: DatasetReaderDeps,
  tenant: string,
): Promise<Map<string, number>> => {
  const readers = new Map<string, Set<string>>();
  const add = (dataset: string, reader: string) =>
    readers.set(dataset, (readers.get(dataset) ?? new Set()).add(reader));
  for (const compiled of await deps.definitions.capabilities()) {
    if (compiled.service.tenant !== tenant) continue;
    const config = compiled.capability.config as {
      knowledge?: { datasets?: { dataset?: string }[] };
    };
    for (const d of config.knowledge?.datasets ?? [])
      if (d.dataset !== undefined)
        add(deps.resolve(d.dataset) ?? d.dataset, `service:${compiled.service.id}`);
  }
  const prefix = blockKey('dataset', '');
  for (const entry of await deps.configEntries.latest({ kind: adoptionKind, scope: tenant }))
    if (!entry.deleted && entry.scope === tenant && entry.id.startsWith(prefix))
      add(entry.id.slice(prefix.length), 'adoption');
  return new Map([...readers].map(([dataset, found]) => [dataset, found.size]));
};
