import type { BlobInfo, BlobStore } from './blob.js';

export type BlobListener = (info: BlobInfo) => void | Promise<void>;

export interface ObservableBlobStore extends BlobStore {
  onPut(tenant: string, prefix: string, listener: BlobListener): () => void;
}

export const observable = (store: BlobStore): ObservableBlobStore => {
  const listeners = new Set<{ tenant: string; prefix: string; listener: BlobListener }>();
  return {
    put: async (key, body, contentType) => {
      const info = await store.put(key, body, contentType);
      for (const l of listeners)
        if (l.tenant === info.tenant && info.path.startsWith(l.prefix)) await l.listener(info);
      return info;
    },
    get: (key) => store.get(key),
    head: (key) => store.head(key),
    list: (tenant, prefix) => store.list(tenant, prefix),
    delete: (key) => store.delete(key),
    onPut: (tenant, prefix, listener) => {
      const entry = { tenant, prefix, listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
  };
};

export interface PollingWatcher {
  poll(): Promise<BlobInfo[]>;
  stop(): void;
}

export const pollFolder = (
  store: BlobStore,
  tenant: string,
  prefix: string,
  listener: BlobListener,
  options: { intervalMs?: number; seen?: Set<string>; timers?: boolean } = {},
): PollingWatcher => {
  const seen = options.seen ?? new Set<string>();
  const poll = async () => {
    const fresh = (await store.list(tenant, prefix)).filter(
      (i) => !seen.has(`${i.path}@${i.sha256}`),
    );
    for (const info of fresh) {
      seen.add(`${info.path}@${info.sha256}`);
      await listener(info);
    }
    return fresh;
  };
  const timer =
    options.timers === false
      ? undefined
      : setInterval(() => void poll().catch(() => undefined), options.intervalMs ?? 10_000);
  timer?.unref();
  return { poll, stop: () => timer && clearInterval(timer) };
};
