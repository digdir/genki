import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  strategyKey,
  validateYaml,
  type PluginSchemas,
  type ServiceDefinition,
} from '@genai/definitions';
import { agentLoopConfig } from '@genai/strategy-agent-loop';
import { retrievalConfig } from '@genai/retrieval';
import { ragConfig } from '@genai/strategy-rag';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Plan } from './assess.ts';

const plan = JSON.parse(readFileSync(join(import.meta.dirname, 'plan.json'), 'utf8')) as Plan;
const yaml = readFileSync(join(import.meta.dirname, 'smoke-service.yaml'), 'utf8');

const models = new Set([...plan.models.map((m) => m.model), ...plan.questions.map((q) => q.model)]);

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    [strategyKey('agent-loop', 1), agentLoopConfig],
    [strategyKey('rag-single-shot', 1), ragConfig],
  ]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  retrieval: retrievalConfig,
  rerankers: new Set(['colbert']),
  models: new Map(
    [...models].map((id) => [
      id,
      { residency: 'global' as const, capabilities: ['stream', 'tools', 'json-schema'] },
    ]),
  ),
};

const definition = () => {
  const result = validateYaml(yaml, plugins);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.definition as ServiceDefinition;
};

const variantsOf = (d: ServiceDefinition) =>
  d.spec.variants.map((v) => (typeof v === 'string' ? { id: v } : v));

describe('smoke service', () => {
  it('is a valid service with the real strategy and retrieval schemas', () => {
    expect(definition().metadata.id).toBe(plan.service);
  });

  it('belongs to the tenant the plan reads timelines in', () => {
    expect(definition().metadata.tenant).toBe(plan.tenant);
  });

  it('has a variant on each model the plan checks, and no model variant the plan skips', () => {
    const own = variantsOf(definition())
      .filter((v) => 'model' in v && v.model)
      .map((v) => ({ variant: v.id, model: (v as { model: string }).model }));
    expect(own).toEqual(plan.models.map(({ variant, model }) => ({ variant, model })));
  });

  it('has every variant a question asks', () => {
    const ids = variantsOf(definition()).map((v) => v.id);
    for (const q of plan.questions) expect(ids).toContain(q.variant);
  });

  it('streams exactly the questions on a variant that writes an answer', () => {
    const d = definition();
    for (const q of plan.questions) {
      const variant = variantsOf(d).find((v) => v.id === q.variant);
      const strategy = (variant && 'strategy' in variant && variant.strategy) || d.spec.strategy;
      const writes = (strategy.config as { generate?: boolean }).generate !== false;
      expect({ question: q.id, stream: q.stream }).toEqual({ question: q.id, stream: writes });
    }
  });

  it('prices each question at the model that serves its variant', () => {
    const d = definition();
    for (const q of plan.questions) {
      const variant = variantsOf(d).find((v) => v.id === q.variant);
      const model = (variant && 'model' in variant && variant.model) || d.spec.model.primary;
      expect({ question: q.id, model: q.model }).toEqual({ question: q.id, model });
    }
  });

  it('checks the facets for every organisation a question expects detected', () => {
    for (const q of plan.questions.filter((x) => !x.knownIssue))
      for (const value of q.detected ?? []) expect(plan.facets.values).toContain(value);
  });

  it('is not offered in chat, so no frontend picks it up', () => {
    expect(definition().spec.exposure).not.toHaveProperty('chat', true);
  });

  it('prices every model the plan calls', () => {
    for (const model of models) expect(plan.prices).toHaveProperty([model]);
  });

  const baseline =
    [...plan.models, ...plan.questions].reduce((sum, c) => sum + c.estimateKr, 0) +
    plan.models.reduce((sum, m) => sum + m.playgroundKr, 0) +
    0.1;

  it('fits a baseline run, every model check rerun once, under the per-run cap', () => {
    expect(baseline * 2).toBeLessThanOrEqual(plan.maxKrPerRun);
  });

  it('fits a run with every group in full under the per-run cap', () => {
    const streamed = plan.models.reduce((sum, m) => sum + m.estimateKr, 0);
    expect(baseline + streamed).toBeLessThanOrEqual(plan.maxKrPerRun);
  });

  it('refuses each broken definition offline at the path the run expects', () => {
    for (const r of plan.refusals) {
      const broken = yaml
        .replace('id: smoke,', 'id: smoke-refusal,')
        .replace(r.replace[0], r.replace[1]);
      expect(broken).not.toBe(yaml.replace('id: smoke,', 'id: smoke-refusal,'));
      const result = validateYaml(broken, plugins);
      expect(result.ok).toBe(false);
      const paths = result.ok ? [] : result.errors.map((e) => e.path);
      expect({
        refusal: r.id,
        found: paths.some((p) => p === r.path || p.startsWith(`${r.path}.`)),
      }).toEqual({
        refusal: r.id,
        found: true,
      });
    }
  });

  it('publishes its throwaway only under the smoke- prefix', () => {
    expect(plan.throwaway).toMatch(/^smoke-/);
  });

  it('visits the smoke service’s test page, where the playground run happens', () => {
    expect(plan.screens.portal.map((s) => s.path)).toContain('#/services/smoke/test');
  });

  it('links every known failure to an issue', () => {
    for (const q of plan.questions.filter((x) => x.knownIssue))
      expect(q.knownIssue).toMatch(/^#\d+$/);
  });
});

describe('the texts the screens are checked for', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : /\.tsx?$/.test(e.name)
          ? [readFileSync(join(dir, e.name), 'utf8')]
          : [],
    );
  const apps = ['portal', 'console'].flatMap((app) =>
    sources(join(import.meta.dirname, '../../apps', app, 'src')),
  );

  it('still exist in the apps, so a renamed text does not silently turn a check off', () => {
    for (const text of [...plan.screenErrorText, ...plan.signedOutHeadings])
      expect({ text, found: apps.some((s) => s.includes(text)) }).toEqual({ text, found: true });
  });
});
