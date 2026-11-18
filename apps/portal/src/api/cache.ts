export interface CacheOptions {
  now?: () => number;
  freshMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
}

interface Entry {
  data: unknown;
  json: string;
  at: number;
  tenant: string;
}

type Listener = (id: string, key: string, sources: ReadonlySet<AbortSignal>) => void;

const listeners = new Set<Listener>();
const readers = new WeakMap<AbortSignal, Set<string>>();
const pageLoads = new WeakSet<AbortSignal>();
const reloads = new WeakSet<AbortSignal>();
let nextId = 0;

export const markPageLoad = (signal: AbortSignal, reload = false) => {
  pageLoads.add(signal);
  if (reload) reloads.add(signal);
};

export const prefetchSignal = () => {
  const signal = new AbortController().signal;
  markPageLoad(signal);
  return signal;
};

export const onRefreshed = (signal: AbortSignal, listener: () => void) => {
  const wrapped: Listener = (id, key, sources) =>
    !sources.has(signal) && readers.get(signal)?.has(`${id}\u0000${key}`) && listener();
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
};

export const tenantOf = (path: string) => /^\/tenants\/([^/?]+)/.exec(path)?.[1] ?? '';

interface Shared {
  promise: Promise<unknown>;
  readers: Set<AbortSignal>;
  controller: AbortController;
  forget: () => void;
}

const join = <T>(shared: Shared, signal: AbortSignal): Promise<T> => {
  shared.readers.add(signal);
  return new Promise<T>((resolve, reject) => {
    const leave = () => {
      shared.readers.delete(signal);
      if (shared.readers.size === 0) {
        shared.forget();
        shared.controller.abort();
      }
      reject(signal.reason);
    };
    signal.addEventListener('abort', leave, { once: true });
    shared.promise.then(
      (data) => {
        signal.removeEventListener('abort', leave);
        resolve(data as T);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
};

export const createResponseCache = ({
  now = () => Date.now(),
  freshMs = 10_000,
  maxAgeMs = 10 * 60_000,
  maxEntries = 300,
}: CacheOptions = {}) => {
  const id = String(nextId++);
  const entries = new Map<string, Entry>();
  const refreshing = new Map<string, Promise<void>>();
  const inFlight = new Map<string, Shared>();
  let generation = 0;

  const store = (key: string, tenant: string, data: unknown, sources: ReadonlySet<AbortSignal>) => {
    const json = JSON.stringify(data);
    const changed = entries.get(key)?.json !== json;
    entries.delete(key);
    entries.set(key, { data, json, at: now(), tenant });
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    if (changed) for (const listener of listeners) listener(id, key, sources);
  };

  const fetchAndStore = async <T>(
    key: string,
    tenant: string,
    fetcher: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    sources: ReadonlySet<AbortSignal> = new Set(signal ? [signal] : []),
  ) => {
    const started = generation;
    const data = await fetcher(signal);
    if (started === generation) store(key, tenant, data, sources);
    return data;
  };

  const shared = <T>(
    key: string,
    tenant: string,
    fetcher: (signal?: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const running = inFlight.get(key);
    if (running) return join<T>(running, signal);
    const controller = new AbortController();
    const readers = new Set<AbortSignal>();
    const forget = () => inFlight.get(key) === entry && inFlight.delete(key);
    const entry: Shared = {
      promise: fetchAndStore(key, tenant, fetcher, controller.signal, readers),
      readers,
      controller,
      forget,
    };
    inFlight.set(key, entry);
    entry.promise.then(forget, forget);
    return join<T>(entry, signal);
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
      if (!entry || now() - entry.at > maxAgeMs) return shared(key, tenant, fetcher, signal);
      const fresh = now() - entry.at < freshMs || inFlight.has(key);
      if (!fresh && !reloads.has(signal) && !refreshing.has(key)) {
        const refresh = fetchAndStore(key, tenant, fetcher, undefined, new Set()).then(
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
      inFlight.clear();
      for (const [key, entry] of entries)
        if (!tenant || !entry.tenant || entry.tenant === tenant) entries.delete(key);
    },
    clear: () => {
      generation += 1;
      inFlight.clear();
      entries.clear();
    },
    size: () => entries.size,
  };
};

export type ResponseCache = ReturnType<typeof createResponseCache>;
