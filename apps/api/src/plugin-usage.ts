import type { CatalogItem } from './catalog-registry.js';
import type { DefinitionStore } from '@genai/definitions';
import { tenantServiceUses } from './block-usage.js';

export interface PluginUsageSource {
  store: Pick<DefinitionStore, 'list' | 'get'>;
  tenants(): Promise<string[]> | string[];
  modelEndpoint(model: string): string | undefined;
  datasetEndpoint(dataset: string): string | undefined;
  endpoint(kind: 'model-endpoint' | 'knowledge-endpoint', id: string): CatalogItem | undefined;
}

export const pluginUsage = async (source: PluginUsageSource): Promise<Map<string, string[]>> => {
  const users = new Map<string, Set<string>>();
  const add = (plugin: string, service: string) =>
    users.set(plugin, (users.get(plugin) ?? new Set<string>()).add(service));
  for (const tenant of await source.tenants()) {
    for (const use of await tenantServiceUses(source.store, tenant)) {
      const service = `${tenant}/${use.service}`;
      for (const ref of use.references) {
        if (ref.kind === 'model') {
          const endpoint = source.modelEndpoint(ref.id);
          const protocol = endpoint && source.endpoint('model-endpoint', endpoint)?.spec.protocol;
          if (typeof protocol === 'string') add(`model.${protocol}`, service);
        }
        if (ref.kind === 'dataset') {
          const endpoint = source.datasetEndpoint(ref.id);
          const engine = endpoint && source.endpoint('knowledge-endpoint', endpoint)?.spec.engine;
          if (typeof engine === 'string') add(`knowledge.${engine}`, service);
        }
      }
    }
  }
  return new Map([...users].map(([plugin, services]) => [plugin, [...services].sort()]));
};
