import {
  serviceReferences,
  stepBlocks,
  versionedReference,
  type BlockReference,
} from '@genai/composition';
import type { DefinitionStore, ServiceDefinition } from '@genai/definitions';
import type { PlatformModuleFactory } from './platform-modules.js';

export { serviceReferences, stepBlocks };
export type { BlockReference, ReferenceKind } from '@genai/composition';

export type Usage = Map<string, Set<string>>;

export interface UsageSource {
  store: Pick<DefinitionStore, 'capabilities' | 'list' | 'get'>;
  tenants(): Promise<string[]> | string[];
}

const flowSteps = (definition: unknown) =>
  (definition as { spec?: { steps?: unknown[] } } | undefined)?.spec?.steps ?? [];

export const blockUsage = async (source: UsageSource): Promise<Usage> => {
  const usage: Usage = new Map();
  const use = (ref: string, service: string) => {
    const set = usage.get(ref) ?? new Set<string>();
    set.add(service);
    usage.set(ref, set);
  };
  for (const compiled of await source.store.capabilities()) {
    const service = `${compiled.service.tenant}/${compiled.service.id}`;
    use(`${compiled.capability.strategy.id}@${compiled.capability.strategy.version}`, service);
    const config = compiled.capability.config as { tools?: string[]; strategy?: { flow?: string } };
    for (const tool of config.tools ?? []) use(tool, service);
    if (config.strategy?.flow) use(config.strategy.flow, service);
  }
  for (const tenant of await source.tenants()) {
    for (const entry of await source.store.list(tenant)) {
      if (entry.kind !== 'StepFlow') continue;
      const flow = await source.store.get('StepFlow', tenant, entry.id);
      for (const block of stepBlocks(flowSteps(flow?.definition)))
        use(block, `${tenant}/${entry.id} (stegflyt)`);
    }
  }
  return usage;
};

export interface ServiceUse {
  service: string;
  name: string;
  version: number;
  references: BlockReference[];
}

export const tenantServiceUses = async (
  store: Pick<DefinitionStore, 'list' | 'get'>,
  tenant: string,
): Promise<ServiceUse[]> => {
  const uses: ServiceUse[] = [];
  for (const entry of await store.list(tenant)) {
    if (entry.kind !== 'Service') continue;
    const latest = await store.get('Service', tenant, entry.id);
    if (!latest) continue;
    const definition = latest.definition as ServiceDefinition;
    const references = serviceReferences(definition);
    for (const flow of references.filter((r) => r.kind === 'step_flow')) {
      const found = await store.get('StepFlow', tenant, flow.id, flow.version);
      for (const block of stepBlocks(flowSteps(found?.definition)))
        references.push(versionedReference('step_flow', block));
    }
    uses.push({
      service: entry.id,
      name: definition.metadata.name ?? entry.id,
      version: latest.version,
      references,
    });
  }
  return uses;
};

export const blockUsageModule: PlatformModuleFactory = () => ({
  id: 'block-usage',
  mount: () => undefined,
});
