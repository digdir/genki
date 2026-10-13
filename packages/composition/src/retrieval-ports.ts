import type { Ref } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { combineKnowledge, type KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { RerankPort } from '@genai/port-rerank';
import { fromFilterMap } from '@genai/retrieval';

interface KnowledgeConfig {
  datasets?: { dataset: string }[];
  reranker?: string;
  retrieval?: unknown;
  planner?: unknown;
}

export interface RuntimeConfig {
  model?: { primary?: string; tenant?: string; roles?: { planner?: string } };
  knowledge?: KnowledgeConfig;
}

export const openRetrievalPorts = async (
  ctx: InvocationContext,
  config: RuntimeConfig,
  request: { overrides?: Record<string, unknown> } = {},
) => {
  const tenant = config.model?.tenant;
  const scoped = (kind: string, id: string): Ref => ({ kind, id, ...(tenant ? { tenant } : {}) });
  const datasets = [...new Set((config.knowledge?.datasets ?? []).map((d) => d.dataset))];
  if (datasets.length === 0) throw new Error('the service has no dataset to search');
  const knowledge = combineKnowledge(
    Object.fromEntries(
      await Promise.all(
        datasets.map(
          async (d) =>
            [d, await ctx.use<KnowledgePort>('knowledge', scoped('dataset', d))] as const,
        ),
      ),
    ),
  );
  const rerank = config.knowledge?.reranker
    ? await ctx.use<RerankPort>('rerank', scoped('reranker', config.knowledge.reranker))
    : undefined;
  const plannerModel = config.model?.roles?.planner ?? config.model?.primary;
  const model = plannerModel
    ? await ctx.use<ModelPort>('model', scoped('model', plannerModel))
    : undefined;
  return {
    knowledge,
    ...(rerank ? { rerank } : {}),
    ...(model ? { model } : {}),
    config: config.knowledge?.retrieval ?? {},
    ...(config.knowledge?.planner ? { planner: config.knowledge.planner } : {}),
    ...optionalFilters(fromFilterMap(request.overrides?.['retrieve-filter-by'])),
  };
};

const optionalFilters = (filters: ReturnType<typeof fromFilterMap>) => (filters ? { filters } : {});

export const usingRetrievalPorts = <C>(strategy: Strategy<C>): Strategy<C> => ({
  ...strategy,
  requires: {
    ...strategy.requires,
    ports: [...new Set([...strategy.requires.ports, 'model', 'knowledge', 'rerank'])],
  },
});
