import { reservedInputFieldIds } from '@genai/contracts';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { t } from './i18n/index.js';
import { modelsForTenant } from './model-access.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { strategyCatalogue, type StrategyEntry } from './strategy-catalogue.js';

export type CompletionRule =
  | 'residency-from-model'
  | 'field-id-from-label'
  | 'strategy-starting-config'
  | 'human-approval-for-high-risk'
  | 'no-required-sources-for-fields'
  | 'output-for-kind'
  | 'field-description-from-name';

export interface Applied {
  path: string;
  rule: CompletionRule;
}

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reserved = new Set<string>(reservedInputFieldIds);

export const fieldIdFrom = (label: string, taken: Set<string>) => {
  const ascii = label
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 48);
  const base = ascii && !reserved.has(ascii) ? ascii : 'field';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
};

export interface CompletionSources {
  residencyOf: (model: string) => string | undefined;
  strategies: StrategyEntry[];
}

export const completeService = (definition: Tree, sources: CompletionSources) => {
  const applied: Applied[] = [];
  const out = structuredClone(definition);
  const spec = isTree(out.spec) ? out.spec : {};
  out.spec = spec;

  const model = isTree(spec.model) ? spec.model : undefined;
  if (model && typeof model.primary === 'string' && model.residency === undefined) {
    const residency = sources.residencyOf(model.primary);
    if (residency) {
      model.residency = residency;
      applied.push({ path: 'spec.model.residency', rule: 'residency-from-model' });
    }
  }

  const fields = isTree(spec.input) && Array.isArray(spec.input.fields) ? spec.input.fields : [];
  const taken = new Set(
    fields.flatMap((f) => (isTree(f) && typeof f.id === 'string' && f.id ? [f.id] : [])),
  );
  fields.forEach((field, i) => {
    if (!isTree(field) || (typeof field.id === 'string' && field.id)) return;
    const id = fieldIdFrom(typeof field.label === 'string' ? field.label : '', taken);
    taken.add(id);
    field.id = id;
    applied.push({ path: `spec.input.fields.${i}.id`, rule: 'field-id-from-label' });
  });

  const strategy = isTree(spec.strategy) ? spec.strategy : undefined;
  const entry = sources.strategies.find((s) => s.id === strategy?.id);
  if (strategy && entry && strategy.config === undefined) {
    strategy.config = structuredClone(entry.newConfig);
    applied.push({ path: 'spec.strategy.config', rule: 'strategy-starting-config' });
  }

  const guardrails = isTree(spec.guardrails) ? spec.guardrails : {};
  if (spec.riskClass === 'high' && guardrails['human-approval'] === undefined) {
    spec.guardrails = { ...guardrails, 'human-approval': true };
    applied.push({
      path: 'spec.guardrails.human-approval',
      rule: 'human-approval-for-high-risk',
    });
  }

  const output = isTree(spec.output) ? spec.output : {};
  const foreign: [string, boolean][] = [
    ['fields', output.kind !== 'fields'],
    ['columns', output.kind !== 'table'],
    ['rowKey', output.kind !== 'table'],
    ['template', output.kind !== 'document'],
  ];
  foreign.forEach(([key, drop]) => {
    if (!drop || output[key] === undefined) return;
    Reflect.deleteProperty(output, key);
    applied.push({ path: `spec.output.${key}`, rule: 'output-for-kind' });
  });
  if (output.kind !== 'answer' && output.withSources === true) {
    output.withSources = false;
    applied.push({ path: 'spec.output.withSources', rule: 'output-for-kind' });
  }
  (Array.isArray(output.fields) ? output.fields : []).forEach((field, i) => {
    if (!isTree(field) || typeof field.name !== 'string' || !field.name.trim()) return;
    if (typeof field.description === 'string' && field.description.trim()) return;
    field.description = field.name;
    applied.push({
      path: `spec.output.fields.${i}.description`,
      rule: 'field-description-from-name',
    });
  });

  const current = isTree(spec.guardrails) ? spec.guardrails : {};
  if (output.kind === 'fields' && current['require-sources'] !== undefined) {
    spec.guardrails = Object.fromEntries(
      Object.entries(current).filter(([name]) => name !== 'require-sources'),
    );
    applied.push({
      path: 'spec.guardrails.require-sources',
      rule: 'no-required-sources-for-fields',
    });
  }

  return { definition: out, applied };
};

const problem = (
  c: Context,
  status: 400 | 401,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const definitionCompletionModule: PlatformModuleFactory = () => ({
  id: 'definition-completion',
  mount: (app, deps) => {
    app.post('/tenants/:tenant/definitions/complete', async (c) => {
      const principal = await deps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, t('problems.notSignedIn'));
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, deps.access, principal, tenant, 'manage-services');
      if ('response' in entered) return entered.response;
      const body = (await c.req.json().catch(() => undefined)) as
        { definition?: unknown } | undefined;
      const definition = body?.definition;
      if (!isTree(definition) || definition.kind !== 'Service')
        return problem(c, 400, t('problems.invalidRequest'), [
          { path: 'definition', message: 'required' },
        ]);
      const models = modelsForTenant(deps, tenant);
      return c.json(
        completeService(definition, {
          residencyOf: (id) => models.find((m) => m.id === id)?.residency,
          strategies: strategyCatalogue(deps.plugins.strategies),
        }),
      );
    });
  },
});
