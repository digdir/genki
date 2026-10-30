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

type RawCatalog = {
  endpoints?: Record<string, { engine?: string; options?: { connection?: unknown } }>;
  datasets?: { id?: string; endpoint?: string }[];
};

const withoutEndpoints = (
  catalog: unknown,
  drop: (endpoint: { engine?: string; options?: { connection?: unknown } }) => boolean,
  warning: string,
  warn?: (message: string) => void,
) => {
  const raw = (catalog ?? {}) as RawCatalog;
  const dropped = Object.entries(raw.endpoints ?? {})
    .filter(([, e]) => drop(e))
    .map(([name]) => name);
  if (dropped.length === 0) return catalog;
  warn?.(`${warning}: ${dropped.join(', ')}`);
  return {
    ...raw,
    endpoints: Object.fromEntries(
      Object.entries(raw.endpoints ?? {}).filter(([name]) => !dropped.includes(name)),
    ),
    datasets: (raw.datasets ?? []).filter((d) => !dropped.includes(String(d.endpoint))),
  };
};

export const withoutEngines = (
  catalog: unknown,
  engines: string[],
  warn?: (message: string) => void,
) =>
  withoutEndpoints(
    catalog,
    (e) => engines.includes(String(e.engine)),
    'knowledge endpoints skipped, their engine needs a database',
    warn,
  );

export const knowledgeServerEndpoints = (catalog: unknown) =>
  Object.entries((catalog as RawCatalog | undefined)?.endpoints ?? {})
    .filter(([, e]) => e.options?.connection === 'knowledge')
    .map(([name]) => name);

export const withoutKnowledgeServer = (catalog: unknown, warn?: (message: string) => void) =>
  withoutEndpoints(
    catalog,
    (e) => e.options?.connection === 'knowledge',
    'knowledge endpoints skipped, no knowledge server is configured',
    warn,
  );

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

export const databaseHosts = (env: Record<string, string | undefined>): string[] =>
  [
    env.DATABASE_URL,
    env.DATABASE_RUNTIME_URL,
    env.PGHOST,
    env.KNOWLEDGE_DATABASE_URL,
    env.KNOWLEDGE_PGHOST,
    env.KNOWLEDGE_READ_PGHOST,
  ].flatMap((value) => {
    if (!value) return [];
    if (!value.includes('://')) return [value];
    try {
      return [new URL(value).hostname.replace(/^\[|\]$/g, '')];
    } catch {
      return [];
    }
  });

/** Knowledge endpoints saved through the API, which the catalog registry skips when they fail its checks. */
export const savedKnowledgeCatalog = (
  entries: { id: string; spec: unknown; deleted?: boolean }[],
) => ({
  endpoints: Object.fromEntries(entries.filter((e) => !e.deleted).map((e) => [e.id, e.spec])),
  datasets: [],
});
