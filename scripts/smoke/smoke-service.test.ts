import { readFileSync } from 'node:fs';
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
    for (const q of plan.questions)
      for (const value of q.detected ?? []) expect(plan.facets.values).toContain(value);
  });

  it('is not offered in chat, so no frontend picks it up', () => {
    expect(definition().spec.exposure).not.toHaveProperty('chat', true);
  });

  it('prices every model the plan calls', () => {
    for (const model of models) expect(plan.prices).toHaveProperty([model]);
  });

  it('fits a full run, every model check rerun once, under the per-run cap', () => {
    const once = [...plan.models, ...plan.questions].reduce((sum, c) => sum + c.estimateKr, 0);
    expect(once * 2).toBeLessThanOrEqual(plan.maxKrPerRun);
  });
});
