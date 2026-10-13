import { AsyncLocalStorage } from 'node:async_hooks';
import type { Ref } from '@genai/contracts';
import type { PortContext } from '@genai/kernel';
import { KnowledgeRouter, type KnowledgePort } from '@genai/port-knowledge';

export const portContexts = new AsyncLocalStorage<PortContext>();

const withinContext = (port: KnowledgePort, ctx: PortContext): KnowledgePort => {
  const within =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    (...args: A) =>
      portContexts.run(ctx, () => run(...args));
  return {
    info: () => port.info(),
    search: within((request) => port.search(request)),
    searchMany: within((requests) => port.searchMany(requests)),
    fetch: within((ids) => port.fetch(ids)),
    range: within((document, from, to) => port.range(document, from, to)),
    facets: within((fields, filters) => port.facets(fields, filters)),
    ...(port.documents
      ? {
          documents: within(
            (request) => port.documents?.(request) ?? Promise.resolve({ documents: [] }),
          ),
        }
      : {}),
    ...(port.export ? { export: port.export } : {}),
  };
};

export class ContextualKnowledgeRouter extends KnowledgeRouter {
  override open(ref: Ref, ctx: PortContext): KnowledgePort {
    return withinContext(super.open(ref, ctx), ctx);
  }

  override openAt(
    ref: Ref,
    endpointId: string,
    ctx: PortContext,
    overrides?: Parameters<KnowledgeRouter['openAt']>[3],
  ): KnowledgePort {
    return withinContext(super.openAt(ref, endpointId, ctx, overrides), ctx);
  }
}

export const withoutEngines = (
  catalog: unknown,
  engines: string[],
  warn?: (message: string) => void,
) => {
  const raw = (catalog ?? {}) as {
    endpoints?: Record<string, { engine?: string }>;
    datasets?: { id?: string; endpoint?: string }[];
  };
  const dropped = Object.entries(raw.endpoints ?? {})
    .filter(([, e]) => engines.includes(String(e.engine)))
    .map(([name]) => name);
  if (dropped.length === 0) return catalog;
  warn?.(`knowledge endpoints skipped, their engine needs a database: ${dropped.join(', ')}`);
  return {
    ...raw,
    endpoints: Object.fromEntries(
      Object.entries(raw.endpoints ?? {}).filter(([name]) => !dropped.includes(name)),
    ),
    datasets: (raw.datasets ?? []).filter((d) => !dropped.includes(String(d.endpoint))),
  };
};

export const routerCatalog = (catalog: unknown) => {
  const raw = (catalog ?? {}) as { endpoints?: Record<string, Record<string, unknown>> };
  return {
    ...raw,
    endpoints: Object.fromEntries(
      Object.entries(raw.endpoints ?? {}).map(([name, e]) => [
        name,
        Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'sharing')),
      ]),
    ),
  };
};
