import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event, Principal, Usage } from '@genai/contracts';
import type { DefinitionStore } from '@genai/definitions';
import { parse as parseYaml } from 'yaml';
import { builderServiceId, optimiserServiceId } from '@genai/strategy-builder';
import type { DraftRunOutcome } from './draft-runner.js';
import { ownedElsewhere } from './model-access.js';
import type { ModuleDeps } from './platform-modules.js';

export { builderServiceId, optimiserServiceId };

type ServiceDeps = Pick<
  ModuleDeps,
  'definitions' | 'platformTenant' | 'models' | 'drafts' | 'catalog'
>;

export interface PlatformServiceRun {
  principal: Principal;
  tenant: string;
  service: string;
  model: string;
  data: Record<string, unknown>;
  budget?: Usage;
  onEvent?: (event: Event) => void | Promise<void>;
}

export const platformService = (
  deps: Pick<ServiceDeps, 'definitions' | 'platformTenant'>,
  id: string,
) => deps.definitions.get('Service', deps.platformTenant, id);

export const defaultModelOf = (found: { definition: unknown } | undefined) => {
  const spec = (found?.definition as { spec?: { model?: { primary?: unknown } } } | undefined)
    ?.spec;
  return typeof spec?.model?.primary === 'string' ? spec.model.primary : undefined;
};

export const runsPlatformServices = (
  deps: Pick<ServiceDeps, 'catalog' | 'platformTenant'>,
  model: string,
) => !ownedElsewhere(deps.catalog, model, deps.platformTenant);

export const runPlatformService = async (
  deps: ServiceDeps,
  run: PlatformServiceRun,
): Promise<DraftRunOutcome | undefined> => {
  const found = await platformService(deps, run.service);
  if (!found) return undefined;
  const definition = structuredClone(found.definition) as unknown as {
    spec: { model: Record<string, unknown> };
  };
  definition.spec.model = {
    primary: run.model,
    residency: deps.models.describe().find((m) => m.id === run.model)?.residency ?? 'global',
  };
  return deps.drafts.run({
    principal: run.principal,
    tenant: deps.platformTenant,
    definition,
    files: found.files,
    version: found.version,
    parts: [],
    origin: 'assistant',
    chargeTo: run.tenant,
    data: run.data,
    ...(run.budget ? { budget: run.budget } : {}),
    ...(run.onEvent ? { onEvent: run.onEvent } : {}),
  });
};

export const publishPlatformServices = async (
  definitions: Pick<DefinitionStore, 'publish'>,
  configDir: string,
) => {
  for (const id of [builderServiceId, optimiserServiceId]) {
    const definition = parseYaml(
      readFileSync(join(configDir, 'services', `${id}.yaml`), 'utf8'),
    ) as { spec: { strategy: { config: { instructions: string } } } };
    const prompt = definition.spec.strategy.config.instructions;
    const result = await definitions.publish(definition, 'platform:seed', 'local configuration', {
      [prompt]: readFileSync(join(configDir, prompt), 'utf8'),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
  }
};
