import {
  runContract,
  type ContractSetup,
  type ContractSuite,
  type RunOptions,
  type SuiteResult,
} from './contract.js';
import { parseManifest, type PluginKind, type PluginManifest } from './manifest.js';

export interface PluginRegistration<T = unknown> {
  manifest: PluginManifest;
  suite?: ContractSuite<T>;
  target?: ContractSetup<T>;
}

export const contractTriggers = ['boot', 'operator', 'registration'] as const;
export type ContractTrigger = (typeof contractTriggers)[number];

export interface ContractRun extends SuiteResult {
  plugin: string;
  version: string;
  trigger: ContractTrigger;
  by?: string;
}

export interface ContractRunStore {
  record(run: ContractRun): Promise<void>;
  list(plugin: string): Promise<ContractRun[]>;
}

export class InMemoryContractRuns implements ContractRunStore {
  readonly #runs = new Map<string, ContractRun[]>();

  async record(run: ContractRun) {
    this.#runs.set(run.plugin, [...(this.#runs.get(run.plugin) ?? []), structuredClone(run)]);
  }

  async list(plugin: string) {
    return structuredClone(this.#runs.get(plugin) ?? []);
  }
}

export type PluginErrorCode = 'not_found' | 'unsupported' | 'invalid' | 'conflict' | 'forbidden';

export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface PluginEntry {
  manifest: PluginManifest;
  verifiable: boolean;
  latest?: ContractRun;
  history: { version: string; passed: boolean; at: string }[];
}

export interface PluginRegistryOptions {
  runs?: ContractRunStore;
  run?: RunOptions;
}

export class PluginRegistry {
  readonly #plugins = new Map<string, PluginRegistration>();
  readonly runs: ContractRunStore;

  constructor(private readonly options: PluginRegistryOptions = {}) {
    this.runs = options.runs ?? new InMemoryContractRuns();
  }

  register<T>(registration: PluginRegistration<T>): this {
    const parsed = parseManifest(registration.manifest);
    if (!parsed.ok)
      throw new PluginError(
        'invalid',
        `invalid manifest for ${String(registration.manifest.id)}: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    const { id, contract } = parsed.manifest;
    if (this.#plugins.has(id)) throw new PluginError('conflict', `plug-in ${id} is registered`);
    if (registration.suite && registration.suite.contract !== contract)
      throw new PluginError(
        'invalid',
        `plug-in ${id} claims ${contract} but brings the ${registration.suite.contract} suite`,
      );
    this.#plugins.set(id, { ...registration, manifest: parsed.manifest } as PluginRegistration);
    return this;
  }

  unregister(id: string): boolean {
    return this.#plugins.delete(id);
  }

  get(id: string): PluginRegistration | undefined {
    return this.#plugins.get(id);
  }

  manifests(kind?: PluginKind): PluginManifest[] {
    return [...this.#plugins.values()]
      .map((p) => p.manifest)
      .filter((m) => !kind || m.kind === kind)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  async describe(id: string): Promise<PluginEntry | undefined> {
    const plugin = this.#plugins.get(id);
    if (!plugin) return undefined;
    const runs = await this.runs.list(id);
    const latest = runs.filter((r) => r.version === plugin.manifest.version).at(-1);
    return {
      manifest: plugin.manifest,
      verifiable: Boolean(plugin.suite && plugin.target),
      ...(latest ? { latest } : {}),
      history: runs.map((r) => ({ version: r.version, passed: r.passed, at: r.endedAt })),
    };
  }

  async list(kind?: PluginKind): Promise<PluginEntry[]> {
    const out: PluginEntry[] = [];
    for (const manifest of this.manifests(kind)) {
      const entry = await this.describe(manifest.id);
      if (entry) out.push(entry);
    }
    return out;
  }

  async verify(
    id: string,
    how: { trigger: ContractTrigger; by?: string; signal?: AbortSignal },
  ): Promise<ContractRun> {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new PluginError('not_found', `no plug-in ${id}`);
    if (!plugin.suite || !plugin.target)
      throw new PluginError(
        'unsupported',
        `plug-in ${id} has no contract target the platform can run; its suite runs in CI`,
      );
    const result = await runContract(plugin.suite, plugin.target, {
      ...this.options.run,
      ...(how.signal ? { signal: how.signal } : {}),
    });
    const run: ContractRun = {
      ...result,
      plugin: id,
      version: plugin.manifest.version,
      trigger: how.trigger,
      ...(how.by ? { by: how.by } : {}),
    };
    await this.runs.record(run);
    return run;
  }

  async admit<T>(
    registration: PluginRegistration<T>,
    how: { by?: string; signal?: AbortSignal } = {},
  ): Promise<ContractRun | undefined> {
    const parsed = parseManifest(registration.manifest);
    if (!parsed.ok)
      throw new PluginError(
        'invalid',
        `invalid manifest: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    if (!registration.suite || !registration.target) return undefined;
    const result = await runContract(registration.suite, registration.target, {
      ...this.options.run,
      ...(how.signal ? { signal: how.signal } : {}),
    });
    const run: ContractRun = {
      ...result,
      plugin: parsed.manifest.id,
      version: parsed.manifest.version,
      trigger: 'registration',
      ...(how.by ? { by: how.by } : {}),
    };
    await this.runs.record(run);
    return run;
  }

  async verifyUnverified(trigger: ContractTrigger = 'boot'): Promise<ContractRun[]> {
    const out: ContractRun[] = [];
    for (const manifest of this.manifests()) {
      const entry = await this.describe(manifest.id);
      if (!entry?.verifiable || entry.latest) continue;
      out.push(await this.verify(manifest.id, { trigger }));
    }
    return out;
  }
}
