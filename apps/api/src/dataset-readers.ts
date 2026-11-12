import { adoptionKind, blockKey } from '@genai/composition';
import type { DefinitionStore } from '@genai/definitions';
import type { ConfigEntryStore } from './config-store.js';

export interface DatasetReader {
  kind: 'service' | 'adoption';
  tenant: string;
  id: string;
  name: string;
}

export interface DatasetReaderDeps {
  definitions: Pick<DefinitionStore, 'capabilities'>;
  configEntries: Pick<ConfigEntryStore, 'latest'>;
  resolve(idOrAlias: string): string | undefined;
}

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
  return [...readers.values()].sort((a, b) =>
    `${a.kind}:${a.tenant}/${a.id}`.localeCompare(`${b.kind}:${b.tenant}/${b.id}`),
  );
};
