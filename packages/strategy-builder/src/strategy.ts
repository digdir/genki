import type { Input } from '@genai/contracts';
import type { PluginSchemas } from '@genai/definitions';
import type {
  Emitted,
  InvocationContext,
  PortContext,
  PortProvider,
  Strategy,
} from '@genai/kernel';
import type { KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { z } from 'zod';
import { runTurn, type SampledDocument } from './assistant.js';
import {
  serviceIntents,
  skillIntents,
  type BuilderEvent,
  type BuilderTurnInput,
  type BuilderTurnResult,
} from './types.js';

export const builderStrategyId = 'builder-assistant';
export const builderServiceId = 'builder-assistant';
export const builderResultMime = 'application/vnd.genai.builder-turn+json';
export const builderChecksMime = 'application/vnd.genai.builder-checks+json';

export interface BuilderAssistantDeps {
  plugins(): PluginSchemas;
  knowledge?: PortProvider<KnowledgePort>;
}

export const platformServiceConfig = z.strictObject({ instructions: z.string().min(1) });

export interface PlatformServiceConfig {
  strategy: z.infer<typeof platformServiceConfig>;
  model: { primary: string; tenant?: string };
}

export const platformModel = (ctx: InvocationContext, config: PlatformServiceConfig) =>
  ctx.use<ModelPort>('model', {
    kind: 'model',
    id: config.model.primary,
    tenant: config.model.tenant ?? ctx.tenant,
  });

const residency = z.enum(['norway', 'eu', 'global']);
const kind = z.enum(['model', 'dataset', 'tool', 'skill', 'guardrail']);

export const builderTurnInput = z.object({
  target: z.enum(['service', 'skill', 'stepflow']),
  tenant: z.string().min(1),
  message: z.string(),
  answers: z.record(z.string(), z.string()).optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .optional(),
  intent: z.enum([...serviceIntents, ...skillIntents]),
  draft: z.record(z.string(), z.unknown()),
  stream: z.boolean(),
  context: z.object({
    available: z.array(
      z.object({
        kind,
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        dataLocation: residency.nullable().optional(),
        capabilities: z.array(z.string()).optional(),
      }),
    ),
    refused: z.array(
      z.object({
        kind,
        id: z.string(),
        rule: z.string(),
        ownedBy: z.string(),
        link: z.string().optional(),
      }),
    ),
    blockedResidencies: z.array(
      z.object({
        residency,
        rule: z.string(),
        ownedBy: z.string(),
        link: z.string().optional(),
      }),
    ),
    tenantName: z.string().optional(),
    rights: z.array(z.string()).optional(),
    recipes: z
      .array(
        z.object({
          ref: z.string(),
          title: z.object({ nb: z.string(), en: z.string() }),
          summary: z.object({ nb: z.string(), en: z.string() }),
          purpose: z.string(),
          settings: z.unknown(),
        }),
      )
      .optional(),
  }),
});

const emitted = (event: BuilderEvent): Emitted =>
  event.type === 'delta'
    ? { type: 'kernel.part.delta', data: event.data }
    : { type: `x.builder.${event.type}`, data: event.data };

const sampler =
  (provider: PortProvider<KnowledgePort>, ctx: PortContext) =>
  async (datasets: string[], query: string, limit: number): Promise<SampledDocument[]> => {
    const seen = new Map<string, SampledDocument>();
    for (const dataset of datasets) {
      if (seen.size >= limit) break;
      const port = provider.open({ kind: 'dataset', id: dataset }, ctx);
      const { hits } = await port.search({ query, limit });
      for (const hit of hits) {
        const source = hit.title ?? hit.document ?? hit.id;
        if (seen.size >= limit || seen.has(source)) continue;
        seen.set(source, { source, text: hit.text.slice(0, 1500) });
      }
    }
    return [...seen.values()];
  };

export const builderChecks = (result: BuilderTurnResult) => ({
  status: result.status,
  proposals: result.proposals.map((p) => p.kind),
  needsRight: result.proposals.flatMap((p) => (p.approval ? [p.approval.right] : [])),
  refused: result.policy?.code ?? null,
  rejected: (result.rejected ?? []).map((r) => r.code),
});

export const createBuilderAssistant = (
  deps: BuilderAssistantDeps,
): Strategy<PlatformServiceConfig> => ({
  id: builderStrategyId,
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (ctx: InvocationContext, input: Input, config: PlatformServiceConfig) {
    const data = builderTurnInput.parse(input.data);
    if (data.tenant !== ctx.tenant) throw new Error('the turn belongs to another tenant');
    const portContext: PortContext = {
      tenant: ctx.tenant,
      principal: ctx.principal,
      task: ctx.task,
      signal: ctx.signal,
      meter: (usage) => ctx.budget.charge(usage),
    };
    const turn = runTurn({
      input: {
        ...data,
        model: config.model.primary,
        systemPrompt: config.strategy.instructions,
      } as BuilderTurnInput,
      plugins: deps.plugins(),
      ports: {
        model: await platformModel(ctx, config),
        ...(deps.knowledge ? { sample: sampler(deps.knowledge, portContext) } : {}),
      },
    });
    for (;;) {
      const next = await turn.next();
      if (next.done) {
        const result: BuilderTurnResult = next.value;
        yield {
          type: 'kernel.result',
          data: [
            { mime: builderChecksMime, body: { kind: 'json', json: builderChecks(result) } },
            { mime: builderResultMime, body: { kind: 'json', json: result } },
            ...(result.message
              ? [{ mime: 'text/plain', body: { kind: 'text' as const, text: result.message } }]
              : []),
          ],
        };
        return;
      }
      yield emitted(next.value);
    }
  },
});
