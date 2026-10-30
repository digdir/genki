import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { residencies, type Residency } from '@genai/port-model';
import { z } from 'zod';
import {
  appendVersion,
  platformScope,
  serialized,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';

export const catalogKinds = [
  'model-endpoint',
  'model',
  'knowledge-endpoint',
  'dataset',
  'rerank-endpoint',
  'reranker',
  'price',
] as const;
export type CatalogKind = (typeof catalogKinds)[number];

export const defaultTenantKinds: CatalogKind[] = [
  'model-endpoint',
  'model',
  'knowledge-endpoint',
  'dataset',
];

type Group = 'models' | 'knowledge' | 'rerank' | 'prices';

const groupOf: Record<CatalogKind, Group> = {
  'model-endpoint': 'models',
  model: 'models',
  'knowledge-endpoint': 'knowledge',
  dataset: 'knowledge',
  'rerank-endpoint': 'rerank',
  reranker: 'rerank',
  price: 'prices',
};

const listKeyOf: Partial<Record<CatalogKind, string>> = {
  model: 'models',
  dataset: 'datasets',
  reranker: 'rerankers',
};

const isEndpoint = (kind: CatalogKind) => kind.endsWith('-endpoint');

export interface CatalogProblem {
  path: string;
  message: string;
}

export interface CatalogSeed {
  models: unknown;
  knowledge: unknown;
  rerank: unknown;
  prices?: Record<string, unknown>;
}

export interface CatalogChecks {
  models(catalog: unknown): CatalogProblem[];
  knowledge(catalog: unknown): CatalogProblem[];
  rerank(catalog: unknown): CatalogProblem[];
}

export interface EffectiveCatalogs {
  models: { endpoints: Record<string, unknown>; models: Record<string, unknown>[] };
  knowledge: { endpoints: Record<string, unknown>; datasets: Record<string, unknown>[] };
  rerank: { endpoints: Record<string, unknown>; rerankers: Record<string, unknown>[] };
  prices: Record<string, { inputPerThousand: number; outputPerThousand: number }>;
}

export interface CatalogPolicy {
  tenantKinds?: CatalogKind[];
  tenantResidencies?: Residency[];
}

export interface CatalogItem {
  kind: CatalogKind;
  id: string;
  scope: string;
  origin: 'seed' | 'api';
  version: number;
  spec: Record<string, unknown>;
  by?: string;
  at?: string;
  reason?: string;
}

export interface CatalogReferences {
  models: Set<string>;
  datasets: Set<string>;
  rerankers: Set<string>;
}

export interface CatalogRegistryOptions {
  seed: CatalogSeed;
  store: ConfigEntryStore;
  checks: CatalogChecks;
  apply(catalogs: EffectiveCatalogs): void | Promise<void>;
  policy?: CatalogPolicy;
  references?: () => Promise<CatalogReferences>;
  localEngines?: () => ReadonlySet<string>;
  derive?: (entries: ConfigEntry<unknown>[]) => ConfigEntry<unknown>[];
  now?: () => Date;
}

export type CatalogResult =
  { ok: true; item: CatalogItem } | { ok: false; errors: CatalogProblem[]; conflict?: boolean };

const shortId = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const fullId = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const fieldName = /^[A-Za-z0-9_.]+$/;
const tenantSecret = /^secret:\/\/tenant(?:\/|-)(\d{9})\/([a-z0-9][a-z0-9._-]*)$/;

export const catalogSecretRef = (tenant: string, name: string) =>
  `secret://tenant-${tenant}/${name}`;

const price = z.strictObject({
  inputPerThousand: z.number().min(0),
  outputPerThousand: z.number().min(0),
});

export { price as catalogPrice };

const sharing = z.strictObject({
  tenants: z.union([z.literal('*'), z.array(z.string().regex(/^\d{9}$/)).min(1)]),
  collectionPrefixes: z.array(z.string().min(1)).optional(),
});

type Sharing = z.infer<typeof sharing>;

const registryOnly: Partial<Record<CatalogKind, string[]>> = {
  'model-endpoint': ['sharing'],
  'knowledge-endpoint': ['sharing'],
  'rerank-endpoint': ['sharing'],
  dataset: ['facets'],
  model: ['release'],
};

const omit = (spec: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(spec).filter(([k]) => !keys.includes(k)));

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const publicHost = (raw: unknown): string | undefined => {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return 'baseURL is not a URL';
  }
  if (url.protocol !== 'https:') return 'a tenant endpoint must use HTTPS';
  if (url.username || url.password) return 'credentials in the URL are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/.test(host))
    return `${host} is not a public host`;
  if (isIP(host)) return 'use a host name, not an IP address';
  return undefined;
};

const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`;

interface Slot {
  kind: CatalogKind;
  id: string;
  scope: string;
  spec: Record<string, unknown>;
  origin: 'seed' | 'api';
  version: number;
  entry?: ConfigEntry<unknown>;
}

const seedSlots = (seed: CatalogSeed): Map<string, Slot> => {
  const slots = new Map<string, Slot>();
  const add = (kind: CatalogKind, id: string, spec: unknown) => {
    const rest = omit(record(spec), ['id']);
    slots.set(keyOf(kind, id), {
      kind,
      id,
      scope: platformScope,
      spec: rest,
      origin: 'seed',
      version: 0,
    });
  };
  const groups: [CatalogKind, CatalogKind, unknown][] = [
    ['model-endpoint', 'model', seed.models],
    ['knowledge-endpoint', 'dataset', seed.knowledge],
    ['rerank-endpoint', 'reranker', seed.rerank],
  ];
  for (const [endpointKind, itemKind, raw] of groups) {
    const catalog = record(raw);
    for (const [name, endpoint] of Object.entries(record(catalog.endpoints)))
      add(endpointKind, name, endpoint);
    for (const item of (catalog[listKeyOf[itemKind] as string] ?? []) as Record<string, unknown>[])
      add(itemKind, String(item.id), item);
  }
  for (const [model, p] of Object.entries(seed.prices ?? {})) add('price', model, p);
  return slots;
};

export class CatalogRegistry {
  readonly #options: CatalogRegistryOptions;
  readonly #serial = serialized();
  #slots = new Map<string, Slot>();
  #skipped: string[] = [];
  #derived = new Map<string, string>();

  constructor(options: CatalogRegistryOptions) {
    this.#options = options;
    this.#slots = seedSlots(options.seed);
  }

  get tenantKinds() {
    return this.#options.policy?.tenantKinds ?? defaultTenantKinds;
  }

  skipped() {
    return [...this.#skipped];
  }

  async initialize() {
    const slots = seedSlots(this.#options.seed);
    const latest = await this.#options.store.latest();
    const derived = this.#options.derive?.(latest) ?? [];
    const entries = [
      ...latest.filter((e) => !derived.some((d) => d.kind === e.kind && d.id === e.id)),
      ...derived,
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    this.#derived = new Map(derived.map((d) => [keyOf(d.kind, d.id), d.reason] as const));
    const skipped: string[] = [];
    for (const entry of entries) {
      if (!catalogKinds.includes(entry.kind as CatalogKind)) continue;
      const next = new Map(slots);
      this.#place(next, entry);
      const problems = this.#check(next, groupOf[entry.kind as CatalogKind]);
      if (problems.length > 0) skipped.push(`${entry.kind} ${entry.id}`);
      else this.#place(slots, entry);
    }
    this.#slots = slots;
    this.#skipped = skipped;
    await this.#options.apply(this.effective());
  }

  refresh(): Promise<void> {
    return this.#serial(() => this.initialize());
  }

  #place(slots: Map<string, Slot>, entry: ConfigEntry<unknown>) {
    const key = keyOf(entry.kind, entry.id);
    if (entry.deleted) {
      slots.delete(key);
      return;
    }
    slots.set(key, {
      kind: entry.kind as CatalogKind,
      id: entry.id,
      scope: entry.scope,
      spec: record(entry.spec),
      origin: 'api',
      version: entry.version,
      entry,
    });
  }

  #compose(slots: Map<string, Slot>): EffectiveCatalogs {
    const out: EffectiveCatalogs = {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
      prices: {},
    };
    for (const slot of slots.values()) {
      const spec = omit(slot.spec, registryOnly[slot.kind] ?? []);
      const group = groupOf[slot.kind];
      if (group === 'prices') {
        out.prices[slot.id] = spec as EffectiveCatalogs['prices'][string];
        continue;
      }
      if (isEndpoint(slot.kind)) {
        out[group].endpoints[slot.id] = spec;
        continue;
      }
      const tenantScoped = slot.scope !== platformScope;
      const item = { id: slot.id, ...spec, ...(tenantScoped ? { tenants: [slot.scope] } : {}) };
      if (group === 'models') out.models.models.push(item);
      else if (group === 'knowledge') out.knowledge.datasets.push(item);
      else out.rerank.rerankers.push(item);
    }
    return out;
  }

  #check(slots: Map<string, Slot>, group: Group): CatalogProblem[] {
    if (group === 'prices') return [];
    return this.#options.checks[group](this.#compose(slots)[group]);
  }

  effective(): EffectiveCatalogs {
    return this.#compose(this.#slots);
  }

  #item(slot: Slot): CatalogItem {
    return {
      kind: slot.kind,
      id: slot.id,
      scope: slot.scope,
      origin: slot.origin,
      version: slot.version,
      spec: structuredClone(slot.spec),
      ...(slot.entry ? { by: slot.entry.by, at: slot.entry.at, reason: slot.entry.reason } : {}),
    };
  }

  list(filter: { kind?: CatalogKind; scope?: string } = {}): CatalogItem[] {
    return [...this.#slots.values()]
      .filter(
        (s) =>
          (filter.kind === undefined || s.kind === filter.kind) &&
          (filter.scope === undefined || s.scope === filter.scope),
      )
      .map((s) => this.#item(s))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  get(kind: CatalogKind, id: string): CatalogItem | undefined {
    const slot = this.#slots.get(keyOf(kind, id));
    return slot && this.#item(slot);
  }

  async history(kind: CatalogKind, id: string): Promise<ConfigEntry<unknown>[]> {
    const scope = this.#slots.get(keyOf(kind, id))?.scope ?? /^(\d{9})\//.exec(id)?.[1];
    return this.#options.store.history(kind, scope ?? platformScope, id);
  }

  sharingOf(kind: CatalogKind, id: string): Sharing | undefined {
    const slot = this.#slots.get(keyOf(kind, id));
    if (!slot || slot.scope !== platformScope) return undefined;
    const parsed = sharing.safeParse(slot.spec.sharing);
    return parsed.success ? parsed.data : undefined;
  }

  sharedWith(sharingRule: Sharing | undefined, tenant: string) {
    return Boolean(
      sharingRule && (sharingRule.tenants === '*' || sharingRule.tenants.includes(tenant)),
    );
  }

  visibleTo(tenant: string): CatalogItem[] {
    return this.list().filter((item) => {
      if (item.scope === tenant) return true;
      if (item.scope !== platformScope) return false;
      if (isEndpoint(item.kind)) return this.sharedWith(this.sharingOf(item.kind, item.id), tenant);
      if (item.kind === 'dataset') {
        const tenants = item.spec.tenants as string[] | undefined;
        return !tenants || tenants.includes(tenant);
      }
      if (item.kind === 'model') return item.spec.release !== 'candidate';
      return item.kind !== 'price';
    });
  }

  qualify(scope: string, id: string) {
    if (scope === platformScope) return id;
    return id.startsWith(`${scope}/`) ? id : `${scope}/${id}`;
  }

  #normalize(
    kind: CatalogKind,
    scope: string,
    spec: Record<string, unknown>,
    slots: Map<string, Slot>,
  ): { spec: Record<string, unknown>; errors: CatalogProblem[] } {
    const errors: CatalogProblem[] = [];
    const out = structuredClone(spec);
    delete out.id;
    if (scope !== platformScope && !this.tenantKinds.includes(kind)) {
      errors.push({ path: 'kind', message: `tenants cannot register ${kind}` });
      return { spec: out, errors };
    }
    if (kind === 'price') {
      const parsed = price.safeParse(out);
      if (!parsed.success)
        for (const i of parsed.error.issues)
          errors.push({ path: ['spec', ...i.path].join('.'), message: i.message });
      return { spec: out, errors };
    }
    if (kind === 'dataset' && out.facets !== undefined) {
      const facets = out.facets;
      if (!Array.isArray(facets) || facets.some((f) => typeof f !== 'string' || !fieldName.test(f)))
        errors.push({ path: 'spec.facets', message: 'facets are a list of field names' });
      else {
        const filters = record(out.filters);
        const missing = facets.filter((f) => !(f in filters));
        if (missing.length > 0)
          errors.push({
            path: 'spec.facets',
            message: `facets must be filter fields too: ${missing.join(', ')}`,
          });
      }
    }
    if (scope === platformScope) {
      if (isEndpoint(kind) && out.sharing !== undefined) {
        const parsed = sharing.safeParse(out.sharing);
        if (!parsed.success)
          errors.push({
            path: 'spec.sharing',
            message: parsed.error.issues[0]?.message ?? 'invalid',
          });
      }
      return { spec: out, errors };
    }

    if (!this.tenantKinds.includes(kind)) {
      errors.push({ path: 'kind', message: `tenants cannot register ${kind}` });
      return { spec: out, errors };
    }
    if (kind === 'knowledge-endpoint' && this.#options.localEngines?.().has(String(out.engine))) {
      for (const key of ['baseURL', 'auth', 'sharing'])
        if (out[key] !== undefined)
          errors.push({
            path: `spec.${key}`,
            message: `${String(out.engine)} runs inside the platform and takes no ${key}`,
          });
      return { spec: out, errors };
    }
    if (isEndpoint(kind)) {
      if (out.sharing !== undefined)
        errors.push({ path: 'spec.sharing', message: 'only platform endpoints are shared' });
      if (out.discovery !== undefined)
        errors.push({
          path: 'spec.discovery',
          message: 'tenant endpoints list their models explicitly',
        });
      const hostProblem = publicHost(out.baseURL);
      if (hostProblem) errors.push({ path: 'spec.baseURL', message: hostProblem });
      const auth = record(out.auth);
      if (auth.kind !== 'api-key' && auth.kind !== 'bearer')
        errors.push({ path: 'spec.auth.kind', message: 'tenant endpoints use api-key or bearer' });
      else {
        const match = tenantSecret.exec(String(auth.secret ?? ''));
        if (!match)
          errors.push({
            path: 'spec.auth.secret',
            message: 'use a tenant secret: secret://tenant/<orgnr>/<name>',
          });
        else if (match[1] !== scope)
          errors.push({
            path: 'spec.auth.secret',
            message: 'the secret belongs to another tenant',
          });
        else out.auth = { ...auth, secret: catalogSecretRef(scope, match[2] as string) };
      }
      return { spec: out, errors };
    }

    const allowed = this.#options.policy?.tenantResidencies ?? [...residencies];
    if (!allowed.includes(out.residency as Residency))
      errors.push({
        path: 'spec.residency',
        message: `tenant entries may declare ${allowed.join(', ')}`,
      });
    if (out.tenants !== undefined)
      errors.push({
        path: 'spec.tenants',
        message: 'a tenant entry is always private to the tenant',
      });
    if (kind === 'dataset' && Array.isArray(out.aliases))
      out.aliases = (out.aliases as unknown[]).map((a) => this.qualify(scope, String(a)));

    const endpointKind: CatalogKind = kind === 'model' ? 'model-endpoint' : 'knowledge-endpoint';
    const ref = String(out.endpoint ?? '');
    const own = this.qualify(scope, ref);
    if (slots.has(keyOf(endpointKind, own))) out.endpoint = own;
    else {
      const rule = this.sharingOf(endpointKind, ref);
      if (!slots.has(keyOf(endpointKind, ref)))
        errors.push({ path: 'spec.endpoint', message: `unknown endpoint ${ref}` });
      else if (!this.sharedWith(rule, scope))
        errors.push({
          path: 'spec.endpoint',
          message: `endpoint ${ref} is not shared with ${scope}`,
        });
      else if (kind === 'dataset' && rule?.collectionPrefixes) {
        const collections = Object.values(record(record(out.options).collections)).map(String);
        const outside = collections.filter(
          (c) => !rule.collectionPrefixes?.some((p) => c.startsWith(p)),
        );
        if (outside.length > 0)
          errors.push({
            path: 'spec.options.collections',
            message: `collections outside the shared prefixes: ${outside.join(', ')}`,
          });
      }
    }
    return { spec: out, errors };
  }

  async publish(input: {
    kind: CatalogKind;
    scope: string;
    id: string;
    spec: unknown;
    by: string;
    reason: string;
    ifVersion?: number;
  }): Promise<CatalogResult> {
    return this.#serial(async () => {
      const id = this.qualify(input.scope, input.id);
      const idOk =
        input.scope === platformScope
          ? fullId.test(id)
          : shortId.test(id.slice(input.scope.length + 1));
      if (!idOk) return { ok: false, errors: [{ path: 'id', message: 'not a valid id' }] };
      const existing = this.#slots.get(keyOf(input.kind, id));
      if (existing && existing.scope !== input.scope)
        return { ok: false, errors: [{ path: 'id', message: `${id} belongs to another scope` }] };
      if (this.#derived.has(keyOf(input.kind, id)))
        return {
          ok: false,
          errors: [{ path: 'id', message: `${id} comes from a registered plug-in` }],
          conflict: true,
        };
      const { spec, errors } = this.#normalize(
        input.kind,
        input.scope,
        record(input.spec),
        this.#slots,
      );
      if (errors.length > 0) return { ok: false, errors };
      if (input.kind === 'dataset') {
        const problem = this.#nameGeneration(spec, existing?.spec);
        if (problem) return { ok: false, errors: [problem] };
      }
      const candidate = new Map(this.#slots);
      candidate.set(keyOf(input.kind, id), {
        kind: input.kind,
        id,
        scope: input.scope,
        spec,
        origin: 'api',
        version: (existing?.version ?? 0) + 1,
      });
      const problems = this.#check(candidate, groupOf[input.kind]);
      if (problems.length > 0) return { ok: false, errors: problems };
      return this.#commit(input, id, spec, false);
    });
  }

  #onKnowledgeServer(endpoint: unknown) {
    const slot = this.#slots.get(keyOf('knowledge-endpoint', String(endpoint ?? '')));
    return record(record(slot?.spec).options).connection === 'knowledge';
  }

  /** A dataset on the knowledge server is read by the generation its entry names. */
  #nameGeneration(
    spec: Record<string, unknown>,
    previous: Record<string, unknown> | undefined,
  ): CatalogProblem | undefined {
    if (!this.#onKnowledgeServer(spec.endpoint)) return undefined;
    if (spec.generation !== undefined) {
      const taken = [...this.#slots.values()].some(
        (slot) =>
          slot.kind === 'dataset' &&
          slot.spec !== previous &&
          slot.spec.generation === spec.generation,
      );
      return taken
        ? {
            path: 'spec.generation',
            message: `${String(spec.generation)} is the generation of another dataset`,
          }
        : undefined;
    }
    if (previous && previous.endpoint === spec.endpoint && previous.generation !== undefined) {
      spec.generation = previous.generation;
      return undefined;
    }
    if (previous && previous.endpoint !== spec.endpoint)
      return {
        path: 'spec.endpoint',
        message:
          'move a dataset onto the knowledge database with an engine switch, which fills a generation first',
      };
    const day = (this.#options.now?.() ?? new Date())
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    spec.generation = `g-${day}-${randomBytes(3).toString('hex')}`;
    return undefined;
  }

  async remove(input: {
    kind: CatalogKind;
    scope: string;
    id: string;
    by: string;
    reason: string;
    ifVersion?: number;
  }): Promise<CatalogResult> {
    return this.#serial(async () => {
      const id = this.qualify(input.scope, input.id);
      const existing = this.#slots.get(keyOf(input.kind, id));
      if (!existing || existing.scope !== input.scope)
        return { ok: false, errors: [{ path: 'id', message: `no ${input.kind} ${id}` }] };
      if (this.#derived.has(keyOf(input.kind, id)))
        return {
          ok: false,
          errors: [{ path: 'id', message: `${id} comes from a registered plug-in` }],
          conflict: true,
        };
      const listKey = listKeyOf[input.kind] as keyof CatalogReferences | undefined;
      if (listKey && this.#options.references) {
        const used = (await this.#options.references())[listKey];
        if (used.has(id))
          return {
            ok: false,
            errors: [{ path: 'id', message: `${id} is used by a published service` }],
          };
      }
      const candidate = new Map(this.#slots);
      candidate.delete(keyOf(input.kind, id));
      const problems = this.#check(candidate, groupOf[input.kind]);
      if (problems.length > 0) return { ok: false, errors: problems };
      return this.#commit(input, id, existing.spec, true);
    });
  }

  async #commit(
    input: { kind: CatalogKind; scope: string; by: string; reason: string; ifVersion?: number },
    id: string,
    spec: Record<string, unknown>,
    deleted: boolean,
  ): Promise<CatalogResult> {
    const history = await this.#options.store.history(input.kind, input.scope, id);
    const current = history.at(-1)?.version ?? 0;
    if (input.ifVersion !== undefined && input.ifVersion !== current)
      return {
        ok: false,
        conflict: true,
        errors: [{ path: 'if-match', message: `the entry is at version ${current}` }],
      };
    const saved = await appendVersion(this.#options.store, {
      kind: input.kind,
      scope: input.scope,
      id,
      spec,
      deleted,
      by: input.by,
      reason: input.reason,
      at: (this.#options.now?.() ?? new Date()).toISOString(),
    });
    this.#place(this.#slots, saved);
    await this.#options.apply(this.effective());
    const slot = this.#slots.get(keyOf(input.kind, id));
    return {
      ok: true,
      item: slot
        ? this.#item(slot)
        : {
            kind: input.kind,
            id,
            scope: input.scope,
            origin: 'api',
            version: saved.version,
            spec: {},
            by: saved.by,
            at: saved.at,
            reason: saved.reason,
          },
    };
  }
}
