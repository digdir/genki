import { parseTestSet, type EvalRun, type TestSet } from './schema.js';

export interface StoredRun {
  run: EvalRun;
  tenant: string;
  task: string;
  service?: string;
  subject?: string;
}

export interface RunFilter {
  tenant: string;
  service?: string;
  subject?: string;
  testSet?: string;
}

export interface EvalRunStore {
  save(stored: StoredRun): Promise<void>;
  get(id: string): Promise<StoredRun | undefined>;
  list(filter: RunFilter): Promise<StoredRun[]>;
}

export interface TestSetStore {
  put(set: TestSet): Promise<void>;
  get(tenant: string, id: string, version?: number): Promise<TestSet | undefined>;
  list(tenant: string, service?: string): Promise<TestSet[]>;
}

const newestFirst = (a: StoredRun, b: StoredRun) => b.run.endedAt.localeCompare(a.run.endedAt);

export class InMemoryEvalRunStore implements EvalRunStore {
  readonly #runs = new Map<string, StoredRun>();

  async save(stored: StoredRun) {
    this.#runs.set(stored.run.id, structuredClone(stored));
  }

  async get(id: string) {
    const found = this.#runs.get(id);
    return found && structuredClone(found);
  }

  async list(filter: RunFilter) {
    return [...this.#runs.values()]
      .filter(
        (s) =>
          s.tenant === filter.tenant &&
          (filter.service === undefined || s.service === filter.service) &&
          (filter.subject === undefined || s.subject === filter.subject) &&
          (filter.testSet === undefined || s.run.testSet.id === filter.testSet),
      )
      .sort(newestFirst)
      .map((s) => structuredClone(s));
  }
}

export class InMemoryTestSetStore implements TestSetStore {
  readonly #sets = new Map<string, TestSet[]>();

  async put(set: TestSet) {
    const key = `${set.metadata.tenant}/${set.metadata.id}`;
    const versions = this.#sets.get(key) ?? [];
    if (versions.some((v) => v.metadata.version === set.metadata.version))
      throw new Error(`test set ${key} v${set.metadata.version} already exists`);
    this.#sets.set(
      key,
      [...versions, structuredClone(set)].sort((a, b) => a.metadata.version - b.metadata.version),
    );
  }

  async get(tenant: string, id: string, version?: number) {
    const versions = this.#sets.get(`${tenant}/${id}`) ?? [];
    const found =
      version === undefined
        ? versions.at(-1)
        : versions.find((v) => v.metadata.version === version);
    return found && parseTestSet(structuredClone(found));
  }

  async list(tenant: string, service?: string) {
    return [...this.#sets.values()]
      .flatMap((versions) => versions.slice(-1))
      .filter(
        (s) =>
          s.metadata.tenant === tenant && (service === undefined || s.spec.service === service),
      )
      .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))
      .map((s) => parseTestSet(structuredClone(s)));
  }
}
