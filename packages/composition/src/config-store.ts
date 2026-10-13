export const platformScope = 'platform';

export interface ConfigEntry<T = Record<string, unknown>> {
  kind: string;
  scope: string;
  id: string;
  version: number;
  spec: T;
  deleted: boolean;
  by: string;
  at: string;
  reason: string;
}

export interface ConfigEntryFilter {
  kind?: string;
  scope?: string;
}

export interface ConfigEntryStore {
  append(entry: ConfigEntry<unknown>): Promise<void>;
  history(kind: string, scope: string, id: string): Promise<ConfigEntry<unknown>[]>;
  latest(filter?: ConfigEntryFilter): Promise<ConfigEntry<unknown>[]>;
}

const keyOf = (kind: string, scope: string, id: string) => `${kind}\u0000${scope}\u0000${id}`;

export class InMemoryConfigEntryStore implements ConfigEntryStore {
  readonly #entries = new Map<string, ConfigEntry<unknown>[]>();

  async append(entry: ConfigEntry<unknown>) {
    const key = keyOf(entry.kind, entry.scope, entry.id);
    const versions = this.#entries.get(key) ?? [];
    if (versions.some((v) => v.version === entry.version))
      throw new Error(`${entry.kind} ${entry.id} v${entry.version} already exists`);
    this.#entries.set(key, [...versions, structuredClone(entry)]);
  }

  async history(kind: string, scope: string, id: string) {
    return structuredClone(this.#entries.get(keyOf(kind, scope, id)) ?? []);
  }

  async latest(filter: ConfigEntryFilter = {}) {
    return [...this.#entries.values()]
      .flatMap((versions) => versions.slice(-1))
      .filter(
        (e) =>
          (filter.kind === undefined || e.kind === filter.kind) &&
          (filter.scope === undefined || e.scope === filter.scope),
      )
      .map((e) => structuredClone(e));
  }
}

export class VersionConflict extends Error {
  constructor(
    readonly current: number,
    expected: number,
  ) {
    super(`the entry is at version ${current}, not ${expected}`);
    this.name = 'VersionConflict';
  }
}

export const appendVersion = async <T>(
  store: ConfigEntryStore,
  entry: Omit<ConfigEntry<T>, 'version' | 'at'> & { at?: string; ifVersion?: number },
): Promise<ConfigEntry<T>> => {
  const history = await store.history(entry.kind, entry.scope, entry.id);
  const current = history.at(-1)?.version ?? 0;
  if (entry.ifVersion !== undefined && entry.ifVersion !== current)
    throw new VersionConflict(current, entry.ifVersion);
  const saved: ConfigEntry<T> = {
    kind: entry.kind,
    scope: entry.scope,
    id: entry.id,
    spec: entry.spec,
    deleted: entry.deleted,
    by: entry.by,
    reason: entry.reason,
    version: current + 1,
    at: entry.at ?? new Date().toISOString(),
  };
  await store.append(saved);
  return saved;
};

export const serialized = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
};
