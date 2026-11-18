export interface LedgerObject {
  tenant: string;
  run: string;
  connection: string;
  descriptor: string;
  deployment: string;
  step: string;
  field: string;
  objectId: string;
  deleteBy: string;
  deletable: boolean;
}

export type LedgerKey = Pick<LedgerObject, 'tenant' | 'connection' | 'objectId'>;

/** Every object a descriptor leaves at the provider is written here when it is issued and struck when it is deleted. */
export interface ObjectLedger {
  created(object: LedgerObject): Promise<void>;
  deleted(key: LedgerKey): Promise<void>;
}

export const providerObjectStates = ['open', 'deleted', 'incident', 'retained'] as const;
export type ProviderObjectState = (typeof providerObjectStates)[number];

export interface ProviderObjectRecord extends LedgerObject {
  state: ProviderObjectState;
  createdAt: string;
  settledAt?: string;
  incident?: string;
}

export interface ProviderObjectStore extends ObjectLedger {
  /** Open objects whose delete-by time has passed, oldest first. */
  due(before: Date, limit: number): Promise<ProviderObjectRecord[]>;
  incident(key: LedgerKey, reason: string, at: Date): Promise<void>;
  list(tenant: string, state?: ProviderObjectState): Promise<ProviderObjectRecord[]>;
}

const keyOf = (k: LedgerKey) => JSON.stringify([k.tenant, k.connection, k.objectId]);

export class InMemoryProviderObjects implements ProviderObjectStore {
  readonly #records = new Map<string, ProviderObjectRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async created(object: LedgerObject) {
    this.#records.set(keyOf(object), {
      ...object,
      state: object.deletable ? 'open' : 'retained',
      createdAt: this.now().toISOString(),
    });
  }

  async deleted(key: LedgerKey) {
    const found = this.#records.get(keyOf(key));
    if (found?.state === 'open')
      this.#records.set(keyOf(key), {
        ...found,
        state: 'deleted',
        settledAt: this.now().toISOString(),
      });
  }

  async due(before: Date, limit: number) {
    return [...this.#records.values()]
      .filter((r) => r.state === 'open' && new Date(r.deleteBy) <= before)
      .sort((a, b) => a.deleteBy.localeCompare(b.deleteBy))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async incident(key: LedgerKey, reason: string, at: Date) {
    const found = this.#records.get(keyOf(key));
    if (found?.state === 'open')
      this.#records.set(keyOf(key), {
        ...found,
        state: 'incident',
        settledAt: at.toISOString(),
        incident: reason,
      });
  }

  async list(tenant: string, state?: ProviderObjectState) {
    return [...this.#records.values()]
      .filter((r) => r.tenant === tenant && (state === undefined || r.state === state))
      .map((r) => structuredClone(r));
  }
}
