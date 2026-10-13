export interface CacheOptions {
  now?: () => number;
  maxAgeMs?: number;
  maxEntries?: number;
}

interface Entry {
  data: unknown;
  json: string;
  at: number;
  tenant: string;
}

type Listener = (id: string, key: string) => void;

const listeners = new Set<Listener>();
const readers = new WeakMap<AbortSignal, Set<string>>();
const pageLoads = new WeakSet<AbortSignal>();
const reloads = new WeakSet<AbortSignal>();
let nextId = 0;

export const markPageLoad = (signal: AbortSignal, reload = false) => {
  pageLoads.add(signal);
  if (reload) reloads.add(signal);
};

export const onRefreshed = (signal: AbortSignal, listener: () => void) => {
  const wrapped: Listener = (id, key) =>
    readers.get(signal)?.has(`${id}\u0000${key}`) && listener();
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
};

export const tenantOf = (path: string) => /^\/tenants\/([^/?]+)/.exec(path)?.[1] ?? '';

export const createResponseCache = ({
  now = Date.now,
  maxAgeMs = 10 * 60_000,
  maxEntries = 300,
}: CacheOptions = {}) => {
  const id = String(nextId++);
  const entries = new Map<string, Entry>();
  const refreshing = new Map<string, Promise<void>>();
  let generation = 0;

  const store = (key: string, tenant: string, data: unknown) => {
    const json = JSON.stringify(data);
    const changed = entries.get(key)?.json !== json;
    entries.delete(key);
    entries.set(key, { data, json, at: now(), tenant });
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    if (changed) for (const listener of listeners) listener(id, key);
  };

  const fetchAndStore = async <T>(
    key: string,
    tenant: string,
    fetcher: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    const started = generation;
    const data = await fetcher(signal);
    if (started === generation) store(key, tenant, data);
    return data;
  };

  return {
    load: async <T>(
      key: string,
      tenant: string,
      fetcher: (signal?: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> => {
      if (!signal || !pageLoads.has(signal)) return fetchAndStore(key, tenant, fetcher, signal);
      const read = readers.get(signal) ?? new Set<string>();
      read.add(`${id}\u0000${key}`);
      readers.set(signal, read);
      const entry = entries.get(key);
      if (!entry || now() - entry.at > maxAgeMs) return fetchAndStore(key, tenant, fetcher, signal);
      if (!reloads.has(signal) && !refreshing.has(key)) {
        const refresh = fetchAndStore(key, tenant, fetcher).then(
          () => undefined,
          () => undefined,
        );
        refreshing.set(key, refresh);
        void refresh.finally(() => refreshing.delete(key));
      }
      return entry.data as T;
    },
    invalidate: (tenant?: string) => {
      generation += 1;
      for (const [key, entry] of entries)
        if (!tenant || !entry.tenant || entry.tenant === tenant) entries.delete(key);
    },
    clear: () => {
      generation += 1;
      entries.clear();
    },
    size: () => entries.size,
  };
};

export type ResponseCache = ReturnType<typeof createResponseCache>;
