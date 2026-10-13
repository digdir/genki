import {
  checkSettingValue,
  resolveSetting,
  type Layer,
  type Lock,
  type Pin,
  type Resolved,
  type SettingDefinition,
} from './settings.js';
import type { ValidationError } from './validate.js';

export interface DefaultVersion {
  key: string;
  version: number;
  value: unknown;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
}

export interface ServiceSettings {
  tenant: string;
  service: string;
  version: number;
  settings: Record<string, unknown>;
}

export interface Effective extends Resolved {
  defaultVersion: number;
}

export interface SettingChange {
  key: string;
  before: unknown;
  after: unknown;
  beforeSource: Effective['source'];
  afterSource: Effective['source'];
}

export interface ServiceImpact {
  tenant: string;
  service: string;
  version: number;
  status: 'changes' | 'pinned' | 'overridden' | 'unchanged';
  before: unknown;
  after: unknown;
}

export interface TenantSettings {
  values: Record<string, unknown>;
  pins: Record<string, number>;
}

export type SettingsResult<T = undefined> =
  { ok: true; value: T } | { ok: false; errors: ValidationError[] };

export interface SettingsSnapshot {
  defaults: DefaultVersion[];
  tenants: Record<string, TenantSettings>;
  tenantVersions: Record<string, number>;
  locks: Record<string, Lock>;
}

export class SettingsConflictError extends Error {
  constructor(readonly tenant: string) {
    super(`settings for ${tenant} were changed elsewhere`);
    this.name = 'SettingsConflictError';
  }
}

export interface SettingsStore {
  load(): Promise<SettingsSnapshot>;
  appendDefault(version: DefaultVersion): Promise<void>;
  /** Saves only if the stored version is `expectedVersion` (0 when never saved); returns the new version or throws SettingsConflictError. */
  saveTenant(tenant: string, settings: TenantSettings, expectedVersion: number): Promise<number>;
  saveLock(key: string, lock: Lock | undefined): Promise<void>;
}

export class InMemorySettingsStore implements SettingsStore {
  readonly #defaults: DefaultVersion[] = [];
  readonly #tenants = new Map<string, TenantSettings>();
  readonly #versions = new Map<string, number>();
  readonly #locks = new Map<string, Lock>();

  async load(): Promise<SettingsSnapshot> {
    return structuredClone({
      defaults: this.#defaults,
      tenants: Object.fromEntries(this.#tenants),
      tenantVersions: Object.fromEntries(this.#versions),
      locks: Object.fromEntries(this.#locks),
    });
  }

  async appendDefault(version: DefaultVersion) {
    if (this.#defaults.some((d) => d.key === version.key && d.version === version.version))
      throw new Error(`default ${version.key} v${version.version} already exists`);
    this.#defaults.push(structuredClone(version));
  }

  async saveTenant(tenant: string, settings: TenantSettings, expectedVersion: number) {
    const current = this.#versions.get(tenant) ?? 0;
    if (current !== expectedVersion) throw new SettingsConflictError(tenant);
    this.#tenants.set(tenant, structuredClone(settings));
    this.#versions.set(tenant, current + 1);
    return current + 1;
  }

  async saveLock(key: string, lock: Lock | undefined) {
    if (lock) this.#locks.set(key, { ...lock });
    else this.#locks.delete(key);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const omit = <T>(record: Record<string, T>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

export class SettingsRegistry {
  readonly #definitions: Map<string, SettingDefinition>;
  readonly #defaults = new Map<string, DefaultVersion[]>();
  readonly #tenants = new Map<string, TenantSettings>();
  readonly #tenantVersions = new Map<string, number>();
  readonly #locks = new Map<string, Lock>();
  #store: SettingsStore | undefined;
  #writes: Promise<void> = Promise.resolve();
  #failure: unknown;

  constructor(
    definitions: SettingDefinition[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#definitions = new Map(definitions.map((d) => [d.key, d]));
    for (const d of definitions)
      this.#defaults.set(d.key, [{ key: d.key, version: 1, value: d.default }]);
  }

  async attach(store: SettingsStore): Promise<void> {
    this.#store = store;
    await this.reload();
  }

  async reload(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    for (;;) {
      const writes = this.#writes;
      await writes;
      const snapshot = await store.load();
      if (this.#writes === writes) return this.#apply(snapshot);
    }
  }

  #apply(snapshot: SettingsSnapshot) {
    this.#defaults.clear();
    for (const d of this.#definitions.values())
      this.#defaults.set(d.key, [{ key: d.key, version: 1, value: d.default }]);
    for (const version of [...snapshot.defaults].sort((a, b) => a.version - b.version)) {
      const history = this.#defaults.get(version.key) ?? [];
      if (version.version > (history.at(-1)?.version ?? 0))
        this.#defaults.set(version.key, [...history, version]);
    }
    this.#tenants.clear();
    for (const [tenant, settings] of Object.entries(snapshot.tenants))
      this.#tenants.set(tenant, settings);
    this.#tenantVersions.clear();
    for (const [tenant, version] of Object.entries(snapshot.tenantVersions))
      this.#tenantVersions.set(tenant, version);
    this.#locks.clear();
    for (const [key, lock] of Object.entries(snapshot.locks)) this.#locks.set(key, lock);
  }

  async flush(): Promise<void> {
    await this.#writes;
    const failure = this.#failure;
    this.#failure = undefined;
    if (failure === undefined) return;
    await this.reload().catch(() => undefined);
    throw failure;
  }

  #persist(write: (store: SettingsStore) => Promise<void>) {
    const store = this.#store;
    if (!store) return;
    this.#writes = this.#writes
      .then(() => write(store))
      .catch((error: unknown) => {
        this.#failure ??= error;
      });
  }

  #saveTenant(tenant: string, settings: TenantSettings) {
    this.#tenants.set(tenant, settings);
    const saved = structuredClone(settings);
    this.#persist(async (store) => {
      const version = await store.saveTenant(tenant, saved, this.#tenantVersions.get(tenant) ?? 0);
      this.#tenantVersions.set(tenant, version);
    });
  }

  definitions(): SettingDefinition[] {
    return [...this.#definitions.values()];
  }

  #definition(key: string): SettingDefinition | undefined {
    return this.#definitions.get(key);
  }

  defaultOf(key: string, version?: number): DefaultVersion | undefined {
    const history = this.#defaults.get(key) ?? [];
    const found =
      version === undefined ? history.at(-1) : history.find((v) => v.version === version);
    return found && structuredClone(found);
  }

  changelog(key?: string): DefaultVersion[] {
    const all =
      key === undefined ? [...this.#defaults.values()].flat() : (this.#defaults.get(key) ?? []);
    return structuredClone(all.filter((v) => v.version > 1));
  }

  setDefault(
    key: string,
    value: unknown,
    actor: string,
    reason: string,
  ): SettingsResult<DefaultVersion> {
    const definition = this.#definition(key);
    if (!definition)
      return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
    const checked = checkSettingValue(definition, 'platform', value);
    if (!checked.ok) return { ok: false, errors: [{ path: key, message: checked.reason }] };
    if (reason.trim().length === 0)
      return { ok: false, errors: [{ path: '', message: 'a reason is required' }] };
    const history = this.#defaults.get(key) ?? [];
    const next: DefaultVersion = {
      key,
      version: (history.at(-1)?.version ?? 0) + 1,
      value: checked.value,
      changedAt: this.now().toISOString(),
      changedBy: actor,
      reason,
    };
    this.#defaults.set(key, [...history, next]);
    const saved = structuredClone(next);
    this.#persist((store) => store.appendDefault(saved));
    return { ok: true, value: structuredClone(next) };
  }

  lock(key: string, reason: string): SettingsResult {
    if (!this.#definition(key))
      return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
    this.#locks.set(key, { reason });
    this.#persist((store) => store.saveLock(key, { reason }));
    return { ok: true, value: undefined };
  }

  unlock(key: string) {
    this.#locks.delete(key);
    this.#persist((store) => store.saveLock(key, undefined));
  }

  tenant(tenant: string): TenantSettings {
    return structuredClone(this.#tenants.get(tenant) ?? { values: {}, pins: {} });
  }

  #checkTenantValue(key: string, value: unknown): ValidationError[] {
    const definition = this.#definition(key);
    if (!definition) return [{ path: key, message: `unknown setting ${key}` }];
    const lock = this.#locks.get(key);
    if (lock) return [{ path: key, message: `locked: ${lock.reason}` }];
    const checked = checkSettingValue(definition, 'tenant', value);
    return checked.ok ? [] : [{ path: key, message: checked.reason }];
  }

  setTenant(tenant: string, key: string, value: unknown): SettingsResult {
    const current = this.tenant(tenant);
    if (value === undefined || value === null) {
      if (!this.#definition(key))
        return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
      current.values = omit(current.values, key);
    } else {
      const errors = this.#checkTenantValue(key, value);
      if (errors.length > 0) return { ok: false, errors };
      current.values[key] = value;
    }
    this.#saveTenant(tenant, current);
    return { ok: true, value: undefined };
  }

  pin(tenant: string, key: string, version: number | null): SettingsResult {
    if (!this.#definition(key))
      return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
    const current = this.tenant(tenant);
    if (version === null) current.pins = omit(current.pins, key);
    else {
      if (!this.defaultOf(key, version))
        return {
          ok: false,
          errors: [{ path: key, message: `no platform default version ${version}` }],
        };
      current.pins[key] = version;
    }
    this.#saveTenant(tenant, current);
    return { ok: true, value: undefined };
  }

  #pins(tenant: string): Record<string, Pin> {
    return Object.fromEntries(
      Object.entries(this.tenant(tenant).pins).map(([key, version]) => [
        key,
        { version, value: this.defaultOf(key, version)?.value },
      ]),
    );
  }

  #platformValues(overrides: Record<string, DefaultVersion> = {}) {
    return Object.fromEntries(
      [...this.#definitions.keys()].flatMap((key) => {
        const current = overrides[key] ?? this.defaultOf(key);
        return current && current.version > 1 ? [[key, current.value]] : [];
      }),
    );
  }

  #effective(
    tenant: string,
    service: ServiceSettings | undefined,
    call: Record<string, unknown> | undefined,
    patch: {
      tenantValues?: Record<string, unknown>;
      defaults?: Record<string, DefaultVersion>;
    } = {},
  ): Record<string, Effective> {
    const values: Partial<Record<Layer, Record<string, unknown>>> = {
      platform: this.#platformValues(patch.defaults),
      tenant: patch.tenantValues ?? this.tenant(tenant).values,
      ...(service ? { service: service.settings } : {}),
      ...(call ? { call } : {}),
    };
    const locks = Object.fromEntries(this.#locks);
    const pins = this.#pins(tenant);
    return Object.fromEntries(
      this.definitions()
        .filter((d) => d.axis === 'service')
        .map((d) => [
          d.key,
          {
            ...resolveSetting(d, { values, locks, pins }),
            defaultVersion: (patch.defaults?.[d.key] ?? this.defaultOf(d.key))?.version ?? 1,
          },
        ]),
    );
  }

  effective(tenant: string, service?: ServiceSettings, call?: Record<string, unknown>) {
    return this.#effective(tenant, service, call);
  }

  previewTenant(
    tenant: string,
    key: string,
    value: unknown,
    services: ServiceSettings[],
  ): SettingsResult<{ tenant: SettingChange; services: ServiceImpact[] }> {
    if (value !== undefined && value !== null) {
      const errors = this.#checkTenantValue(key, value);
      if (errors.length > 0) return { ok: false, errors };
    } else if (!this.#definition(key)) {
      return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
    }
    const tenantValues =
      value === undefined || value === null
        ? omit(this.tenant(tenant).values, key)
        : { ...this.tenant(tenant).values, [key]: value };
    const beforeTenant = this.#effective(tenant, undefined, undefined)[key];
    const afterTenant = this.#effective(tenant, undefined, undefined, { tenantValues })[key];
    return {
      ok: true,
      value: {
        tenant: {
          key,
          before: beforeTenant?.value,
          after: afterTenant?.value,
          beforeSource: beforeTenant?.source ?? 'default',
          afterSource: afterTenant?.source ?? 'default',
        },
        services: services
          .filter((s) => s.tenant === tenant)
          .map((s) => {
            const before = this.#effective(tenant, s, undefined)[key];
            const after = this.#effective(tenant, s, undefined, { tenantValues })[key];
            return {
              tenant: s.tenant,
              service: s.service,
              version: s.version,
              status: same(before?.value, after?.value)
                ? before?.source === 'service'
                  ? 'overridden'
                  : 'unchanged'
                : 'changes',
              before: before?.value,
              after: after?.value,
            };
          }),
      },
    };
  }

  previewDefault(
    key: string,
    value: unknown,
    services: ServiceSettings[],
  ): SettingsResult<ServiceImpact[]> {
    const definition = this.#definition(key);
    if (!definition)
      return { ok: false, errors: [{ path: key, message: `unknown setting ${key}` }] };
    const checked = checkSettingValue(definition, 'platform', value);
    if (!checked.ok) return { ok: false, errors: [{ path: key, message: checked.reason }] };
    const current = this.defaultOf(key);
    const proposed: DefaultVersion = {
      key,
      version: (current?.version ?? 1) + 1,
      value: checked.value,
    };
    return {
      ok: true,
      value: services.map((s) => {
        const before = this.#effective(s.tenant, s, undefined)[key];
        const after = this.#effective(s.tenant, s, undefined, { defaults: { [key]: proposed } })[
          key
        ];
        const status: ServiceImpact['status'] = !same(before?.value, after?.value)
          ? 'changes'
          : before?.source === 'pin'
            ? 'pinned'
            : before?.source === 'default' || before?.source === 'platform'
              ? 'unchanged'
              : 'overridden';
        return {
          tenant: s.tenant,
          service: s.service,
          version: s.version,
          status,
          before: before?.value,
          after: after?.value,
        };
      }),
    };
  }

  restoreTenant(tenant: string, settings: TenantSettings) {
    this.#saveTenant(tenant, structuredClone(settings));
  }
}
