import type { ConfigEntryStore } from '@genai/composition';
import type { DefinitionStore } from '@genai/definitions';
import type { ConnectionRegistry } from '@genai/providers-mcp-client';
import type { CatalogRegistry } from './catalog-registry.js';
import { connectorMappingKind, connectorSecretName } from './connectors.js';

export interface SecretUse {
  kind: string;
  id: string;
}

const refers = (value: unknown, refs: Set<string>, name: string, key = ''): boolean => {
  if (typeof value === 'string') return refs.has(value) || (/secret/i.test(key) && value === name);
  if (Array.isArray(value)) return value.some((v) => refers(v, refs, name, key));
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => refers(v, refs, name, k));
  return false;
};

export const secretUses =
  (sources: {
    configEntries: ConfigEntryStore;
    catalog: Pick<CatalogRegistry, 'list'>;
    connections: Pick<ConnectionRegistry, 'list'>;
    definitions: Pick<DefinitionStore, 'list' | 'get'>;
  }) =>
  async (tenant: string, name: string): Promise<SecretUse[]> => {
    const refs = new Set([
      `secret://tenant/${tenant}/${name}`,
      `secret://tenant-${tenant}/${name}`,
    ]);
    const uses = new Map<string, SecretUse>();
    const add = (kind: string, id: string) => uses.set(`${kind}/${id}`, { kind, id });
    for (const entry of await sources.configEntries.latest({ scope: tenant })) {
      if (entry.deleted) continue;
      const proposal = (entry.spec as { proposal?: unknown } | undefined)?.proposal;
      if (
        refers(entry.spec, refs, name) ||
        (entry.kind === connectorMappingKind &&
          typeof proposal === 'string' &&
          connectorSecretName(proposal) === name)
      )
        add(
          entry.kind,
          entry.id.startsWith(`${tenant}/`) ? entry.id.slice(tenant.length + 1) : entry.id,
        );
    }
    for (const item of sources.catalog.list({ scope: tenant }))
      if (refers(item.spec, refs, name)) add(item.kind, item.id);
    for (const state of await sources.connections.list(tenant))
      if (refers(state.connection, refs, name)) add('tool-connection', state.connection.id);
    for (const { kind, id } of await sources.definitions.list(tenant)) {
      const latest = await sources.definitions.get(kind, tenant, id);
      if (latest && refers(latest.definition, refs, name)) add(kind, id);
    }
    return [...uses.values()].sort((a, b) =>
      `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`),
    );
  };
