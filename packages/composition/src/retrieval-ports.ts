import type { Input, Ref } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { combineKnowledge, type KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { RerankPort } from '@genai/port-rerank';
import { fromFilterMap } from '@genai/retrieval';

interface KnowledgeConfig {
  datasets?: { dataset: string }[];
  filters?: { fields?: unknown[] };
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
    ...optionalFilters(
      fromFilterMap(withFixedFields(request.overrides?.['retrieve-filter-by'], config)),
    ),
  };
};

const optionalFilters = (filters: ReturnType<typeof fromFilterMap>) => (filters ? { filters } : {});

const fieldsOf = (map: unknown): unknown[] => {
  const fields = (map as { fields?: unknown } | undefined)?.fields;
  return Array.isArray(fields) ? fields : [];
};

const withFixedFields = (map: unknown, config: unknown): unknown => {
  const fixed = fieldsOf((config as RuntimeConfig | undefined)?.knowledge?.filters);
  const caller = fieldsOf(map);
  // A nested strategy (a step flow's agent) is wrapped too; add each fixed field once.
  const present = new Set(caller.map((f) => JSON.stringify(f)));
  const added = fixed.filter((f) => !present.has(JSON.stringify(f)));
  return added.length === 0 ? map : { fields: [...added, ...caller] };
};

/** Adds a variant's fixed filter to the caller's, so a caller can narrow it but never widen it. */
export const withFixedFilters = (input: Input, config: unknown): Input => {
  const data = (input.data && typeof input.data === 'object' ? input.data : {}) as Record<
    string,
    unknown
  >;
  const overrides = (
    data.overrides && typeof data.overrides === 'object' ? data.overrides : {}
  ) as Record<string, unknown>;
  const map = overrides['retrieve-filter-by'];
  const merged = withFixedFields(map, config);
  if (merged === map) return input;
  return {
    ...input,
    data: { ...data, overrides: { ...overrides, 'retrieve-filter-by': merged } },
  };
};

export const usingRetrievalPorts = <C>(strategy: Strategy<C>): Strategy<C> => ({
  ...strategy,
  requires: {
    ...strategy.requires,
    ports: [...new Set([...strategy.requires.ports, 'model', 'knowledge', 'rerank'])],
  },
  run: (ctx, input, config) => strategy.run(ctx, withFixedFilters(input, config), config),
});
