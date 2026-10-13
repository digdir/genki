import { gate as gateSchema, type Gate } from '@genai/eval';
import { customRuleSpec, type CustomRule, type CustomRuleSpec } from '@genai/guardrails';
import type { z } from 'zod';
import {
  appendVersion,
  platformScope,
  serialized,
  VersionConflict,
  type ConfigEntryStore,
} from './config-store.js';

export interface ScopedDefinition<T> {
  id: string;
  scope: string;
  version: number;
  spec: T;
  mandatory: boolean;
  builtin: boolean;
  by?: string;
  at?: string;
  reason?: string;
}

export type ScopedResult<T> =
  | { ok: true; value: ScopedDefinition<T> }
  | { ok: false; errors: { path: string; message: string }[]; conflict?: boolean };

interface Stored<T> {
  spec: T;
  mandatory?: boolean;
}

const slug = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ScopedRegistryOptions<T> {
  kind: string;
  store: ConfigEntryStore;
  schema: z.ZodType<T>;
  builtins?: Map<string, T>;
  seed?: { id: string; spec: unknown; mandatory?: boolean }[];
  now?: () => Date;
}

export class ScopedRegistry<T> {
  readonly #serial = serialized();
  readonly #seed = new Map<string, ScopedDefinition<T>>();

  constructor(private readonly options: ScopedRegistryOptions<T>) {
    for (const entry of options.seed ?? []) {
      this.#seed.set(entry.id, {
        id: entry.id,
        scope: platformScope,
        version: 0,
        spec: options.schema.parse(entry.spec),
        mandatory: entry.mandatory ?? false,
        builtin: false,
      });
    }
  }

  #builtins(): ScopedDefinition<T>[] {
    return [...(this.options.builtins ?? new Map<string, T>())].map(([id, spec]) => ({
      id,
      scope: platformScope,
      version: 0,
      spec,
      mandatory: false,
      builtin: true,
    }));
  }

  async #stored(scope: string): Promise<ScopedDefinition<T>[]> {
    const entries = await this.options.store.latest({ kind: this.options.kind, scope });
    return entries
      .filter((e) => !e.deleted)
      .map((e) => {
        const stored = e.spec as Stored<T>;
        return {
          id: scope === platformScope ? e.id : e.id.slice(scope.length + 1),
          scope,
          version: e.version,
          spec: stored.spec,
          mandatory: Boolean(stored.mandatory),
          builtin: false,
          by: e.by,
          at: e.at,
          reason: e.reason,
        };
      });
  }

  async #platform(): Promise<ScopedDefinition<T>[]> {
    const stored = await this.#stored(platformScope);
    const deleted = new Set(
      (await this.options.store.latest({ kind: this.options.kind, scope: platformScope }))
        .filter((e) => e.deleted)
        .map((e) => e.id),
    );
    const byId = new Map<string, ScopedDefinition<T>>();
    for (const d of this.#seed.values()) if (!deleted.has(d.id)) byId.set(d.id, d);
    for (const d of stored) byId.set(d.id, d);
    for (const d of this.#builtins()) byId.set(d.id, d);
    return [...byId.values()];
  }

  async list(tenant?: string): Promise<ScopedDefinition<T>[]> {
    const platform = await this.#platform();
    const own = tenant ? await this.#stored(tenant) : [];
    return [...platform, ...own].sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
    );
  }

  async forTenant(tenant: string): Promise<Map<string, T>> {
    const own = await this.#stored(tenant);
    const platform = await this.#platform();
    return new Map([...own, ...platform].map((d) => [d.id, d.spec]));
  }

  async mandatory(): Promise<ScopedDefinition<T>[]> {
    return (await this.#platform()).filter((d) => d.mandatory);
  }

  async history(scope: string, id: string) {
    return this.options.store.history(this.options.kind, scope, this.#key(scope, id));
  }

  #key(scope: string, id: string) {
    return scope === platformScope ? id : `${scope}/${id}`;
  }

  async save(input: {
    scope: string;
    id: string;
    spec: unknown;
    mandatory?: boolean;
    by: string;
    reason: string;
    ifVersion?: number;
  }): Promise<ScopedResult<T>> {
    return this.#serial(async () => {
      if (!slug.test(input.id))
        return { ok: false, errors: [{ path: 'id', message: 'not a valid id' }] };
      if (this.options.builtins?.has(input.id))
        return {
          ok: false,
          errors: [{ path: 'id', message: `${input.id} is built in and cannot be changed` }],
        };
      if (input.scope !== platformScope) {
        if (input.mandatory)
          return {
            ok: false,
            errors: [
              { path: 'mandatory', message: 'only the platform makes a definition mandatory' },
            ],
          };
        if ((await this.#platform()).some((d) => d.id === input.id))
          return {
            ok: false,
            errors: [
              { path: 'id', message: `${input.id} is a platform definition; pick another id` },
            ],
          };
      }
      const parsed = this.options.schema.safeParse(input.spec);
      if (!parsed.success)
        return {
          ok: false,
          errors: parsed.error.issues.map((i) => ({
            path: ['spec', ...i.path.map(String)].join('.'),
            message: i.message,
          })),
        };
      try {
        const saved = await appendVersion<Stored<T>>(this.options.store, {
          kind: this.options.kind,
          scope: input.scope,
          id: this.#key(input.scope, input.id),
          spec: { spec: parsed.data, ...(input.mandatory ? { mandatory: true } : {}) },
          deleted: false,
          by: input.by,
          reason: input.reason,
          at: (this.options.now?.() ?? new Date()).toISOString(),
          ...(input.ifVersion !== undefined ? { ifVersion: input.ifVersion } : {}),
        });
        return {
          ok: true,
          value: {
            id: input.id,
            scope: input.scope,
            version: saved.version,
            spec: parsed.data,
            mandatory: Boolean(input.mandatory),
            builtin: false,
            by: saved.by,
            at: saved.at,
            reason: saved.reason,
          },
        };
      } catch (error) {
        if (error instanceof VersionConflict)
          return {
            ok: false,
            conflict: true,
            errors: [{ path: 'if-match', message: error.message }],
          };
        throw error;
      }
    });
  }

  async remove(input: {
    scope: string;
    id: string;
    by: string;
    reason: string;
  }): Promise<ScopedResult<T>> {
    return this.#serial(async () => {
      if (this.options.builtins?.has(input.id))
        return {
          ok: false,
          errors: [{ path: 'id', message: `${input.id} is built in and cannot be removed` }],
        };
      const current =
        input.scope === platformScope
          ? (await this.#platform()).find((d) => d.id === input.id && !d.builtin)
          : (await this.#stored(input.scope)).find((d) => d.id === input.id);
      if (!current)
        return {
          ok: false,
          errors: [{ path: 'id', message: `no ${this.options.kind} ${input.id}` }],
        };
      const saved = await appendVersion<Stored<T>>(this.options.store, {
        kind: this.options.kind,
        scope: input.scope,
        id: this.#key(input.scope, input.id),
        spec: { spec: current.spec, ...(current.mandatory ? { mandatory: true } : {}) },
        deleted: true,
        by: input.by,
        reason: input.reason,
        at: (this.options.now?.() ?? new Date()).toISOString(),
      });
      return { ok: true, value: { ...current, version: saved.version } };
    });
  }
}

const gateSpec = gateSchema;

export const createGateRegistry = (options: {
  store: ConfigEntryStore;
  builtins: Map<string, Gate>;
  seed?: { id: string; spec: unknown; mandatory?: boolean }[];
  now?: () => Date;
}) =>
  new ScopedRegistry<Gate>({
    kind: 'gate',
    store: options.store,
    schema: gateSpec as z.ZodType<Gate>,
    builtins: options.builtins,
    ...(options.seed ? { seed: options.seed } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

export type GateRegistry = ReturnType<typeof createGateRegistry>;

export const createGuardrailRuleRegistry = (options: {
  store: ConfigEntryStore;
  seed?: { id: string; spec: unknown; mandatory?: boolean }[];
  now?: () => Date;
}) =>
  new ScopedRegistry<CustomRuleSpec>({
    kind: 'guardrail-rule',
    store: options.store,
    schema: customRuleSpec,
    ...(options.seed ? { seed: options.seed } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

export type GuardrailRuleRegistry = ReturnType<typeof createGuardrailRuleRegistry>;

export const resolveRules = async (
  registry: GuardrailRuleRegistry,
  tenant: string,
  entries: unknown[],
): Promise<CustomRule[]> => {
  const known = await registry.forTenant(tenant);
  const mandatory = (await registry.mandatory()).map(
    (d) => ({ ...d.spec, id: d.id }) as CustomRule,
  );
  const listed = entries.flatMap((entry): CustomRule[] => {
    if (typeof entry === 'string') {
      const id = entry.startsWith(`${tenant}/`) ? entry.slice(tenant.length + 1) : entry;
      const spec = known.get(id);
      if (!spec) throw new Error(`unknown guardrail rule ${entry}`);
      return [{ ...spec, id } as CustomRule];
    }
    const { id, ...rest } = entry as { id: string };
    return [{ ...customRuleSpec.parse(rest), id } as CustomRule];
  });
  const seen = new Set<string>();
  return [...mandatory, ...listed].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
};
