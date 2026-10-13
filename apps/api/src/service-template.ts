import { strategyKey, validateDefinition } from '@genai/definitions';
import { piiCategories } from '@genai/guardrails';
import type { ModelDescription } from '@genai/port-model';
import type { Context } from 'hono';
import { blockKey, blockStatusFor, readBlockPolicy, type BlockPolicy } from './building-blocks.js';
import { modelsForTenant } from './model-access.js';
import { t } from './i18n/index.js';
import type { ModuleDeps, PlatformModuleFactory } from './platform-modules.js';
import { requireRight, rightRefused } from './rights.js';

export const templateStrategy = { id: 'rag-single-shot', version: 1 } as const;

export const templatePlaceholders = () => ({
  id: 'ny-tjeneste',
  name: t('services.templateName'),
  purpose: t('services.templatePurpose'),
});

const usable = new Set(['available', 'in_use']);

export const defaultModelSetting = 'services.defaultModel';

const configuredModel = (deps: Pick<ModuleDeps, 'settings'>, tenant: string) => {
  try {
    const value = deps.settings.effective(tenant)[defaultModelSetting]?.value;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
};

export const templateModels = (
  deps: Pick<ModuleDeps, 'models' | 'plugins' | 'catalog' | 'prices' | 'settings'>,
  tenant: string,
  policy: BlockPolicy,
): ModelDescription[] => {
  const needs =
    deps.plugins.modelNeeds?.get(strategyKey(templateStrategy.id, templateStrategy.version)) ?? [];
  const costOf = (id: string) => {
    const price = deps.prices[id];
    return price ? price.inputPerThousand + price.outputPerThousand : Number.POSITIVE_INFINITY;
  };
  const configured = configuredModel(deps, tenant);
  const rank = (m: ModelDescription) => (m.id === configured ? -1 : costOf(m.id));
  const candidates = modelsForTenant(deps, tenant).filter((m) => {
    if (!deps.plugins.models.has(m.id)) return false;
    if (!needs.every((c) => m.capabilities.includes(c as never))) return false;
    const adoption = policy.adoptions.get(blockKey('model', m.id));
    if (adoption?.spec.settings?.enabled === false) return false;
    return usable.has(
      blockStatusFor(policy, { kind: 'model', id: m.id, dataLocation: m.residency }).status,
    );
  });
  return candidates.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
};

const templateGuardrails = (deps: Pick<ModuleDeps, 'plugins'>) => {
  const wanted: Record<string, unknown> = {
    'pii-before-model': { categories: [...piiCategories] },
    'pii-out-of-log': { categories: [...piiCategories] },
    language: { mode: 'same' },
  };
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([id, config]) => deps.plugins.guardrails.get(id)?.safeParse(config).success,
    ),
  );
};

export const serviceTemplate = (
  deps: Pick<ModuleDeps, 'plugins'>,
  tenant: string,
  model: ModelDescription,
) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'ny-tjeneste', name: templatePlaceholders().name },
  spec: {
    purpose: templatePlaceholders().purpose,
    audience: ['employees'],
    riskClass: 'minimal',
    variants: ['default'],
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer', withSources: true },
    strategy: { ...templateStrategy, config: { generate: true } },
    knowledge: { datasets: [] },
    tools: [],
    skills: [],
    model: { primary: model.id, residency: model.residency },
    guardrails: templateGuardrails(deps),
    exposure: { chat: true },
    improve: { allow: ['instructions'] },
  },
});

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const serviceTemplateModule: PlatformModuleFactory = () => ({
  id: 'service-template',
  mount: (app, deps) => {
    app.get('/tenants/:tenant/definitions/template', async (c) => {
      const principal = await deps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Not authenticated');
      const tenant = c.req.param('tenant') ?? '';
      const scoped = deps.access(principal, tenant, c.req.raw);
      if (!scoped) return problem(c, 404, 'Not found');
      const right = requireRight(scoped, tenant, 'manage-services');
      if (!right.ok) return rightRefused(c, right.problem);
      const kind = c.req.query('kind') ?? 'Service';
      if (kind !== 'Service')
        return problem(c, 400, 'Only kind=Service has a template', [
          { path: 'kind', message: `no template for ${kind}` },
        ]);
      const policy = await readBlockPolicy(deps.configEntries, tenant);
      const [model] = templateModels(deps, tenant, policy);
      if (!model)
        return problem(c, 409, 'Ingen modell er tilgjengelig for virksomheten', [
          { path: 'spec.model.primary', message: 'no enabled model this tenant may use' },
        ]);
      const definition = serviceTemplate(deps, tenant, model);
      const validated = validateDefinition(definition, deps.plugins);
      if (!validated.ok) return problem(c, 500, 'The template is not valid', validated.errors);
      return c.json({ definition }, 200);
    });
  },
});
