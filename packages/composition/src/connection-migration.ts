import { withoutTrailingSlashes } from '@genai/kernel';
import { familyOfProtocol } from '@genai/operations';
import type { ApiRegistry, ModelClassification, ModelClassificationStore } from '@genai/port-model';
import {
  appendVersion,
  platformScope,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import { processorRecordKind, type ProcessorRecord } from './operation-governance.js';

export const connectionMigrationActor = 'genki';
export const connectionMigrationReason =
  'ADR 0048: one connection per provider resource, models bind one API per operation kind';

type Spec = Record<string, unknown>;

interface Placed {
  scope: string;
  spec: Spec;
}

const legacyChatApis: Readonly<Record<string, string>> = {
  'openai-chat': 'openai/chat-completions@1',
  'anthropic-messages': 'anthropic/messages@1',
};

const familyChatApis: Readonly<Record<string, string>> = {
  openai: 'openai/chat-completions@1',
  anthropic: 'anthropic/messages@1',
};

const familySuffixes = [/\/openai\/v1\/?$/, /\/openai\/?$/, /\/anthropic\/?$/, /\/v1\/?$/];

const record = (value: unknown): Spec =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Spec) : {};

/** A base URL split into the provider resource's root and the family's path under it. */
export const resourceRoot = (baseURL: string): { root: string; path: string } => {
  const url = withoutTrailingSlashes(baseURL);
  for (const suffix of familySuffixes) {
    const match = suffix.exec(url);
    if (match) return { root: url.slice(0, match.index), path: withoutTrailingSlashes(match[0]) };
  }
  return { root: url, path: '' };
};

const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Spec).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

export const isLegacyEndpoint = (spec: Spec) => 'protocol' in spec;

export const isLegacyModel = (spec: Spec) =>
  'operations' in spec || 'descriptors' in spec || 'api' in record(spec.options);

const commonName = (ids: string[]) => {
  const parts = ids.map((id) => id.split('-'));
  const first = parts[0] ?? [];
  const shared: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (parts.every((p) => p[i] === first[i])) shared.push(first[i] as string);
    else break;
  }
  return shared.join('-');
};

export type ApiForKind = (kind: string, families: string[]) => string | undefined;

export interface CatalogView {
  endpoints: Map<string, Placed>;
  models: Map<string, Placed>;
}

export interface ConnectionPlan {
  endpoints: Map<string, Placed>;
  removed: Map<string, string>;
  models: Map<string, Placed>;
  moved: Map<string, string>;
}

/** The API a legacy model binds for each operation it listed, from its endpoint's old protocol or family. */
export const legacyBindings = (
  model: Spec,
  chatApi: string | undefined,
  families: string[],
  apiFor: ApiForKind,
): Record<string, string> => {
  const operations = Array.isArray(model.operations) ? model.operations.map(String) : ['chat'];
  const descriptors = record(model.descriptors);
  const options = record(model.options);
  return Object.fromEntries(
    operations.flatMap((kind) => {
      const api =
        kind === 'chat'
          ? options.api === 'responses'
            ? 'openai/responses@1'
            : chatApi
          : typeof descriptors[kind] === 'string'
            ? (descriptors[kind] as string)
            : apiFor(kind, families);
      return api ? [[kind, api] as const] : [];
    }),
  );
};

const without = (spec: Spec, keys: string[]): Spec =>
  Object.fromEntries(Object.entries(spec).filter(([k]) => !keys.includes(k)));

const withoutLegacy = (model: Spec, apis: Record<string, string>): Spec => {
  const rest = without(model, ['operations', 'descriptors']);
  const options = without(record(model.options), ['api']);
  return {
    ...rest,
    ...(Object.keys(options).length > 0 || 'options' in model ? { options } : {}),
    apis,
  };
};

const ruleOf = (discovery: Spec, idPrefix: string | undefined, apis: Record<string, string>) => ({
  source: discovery.source,
  ...(Array.isArray(discovery.include) ? { include: discovery.include } : {}),
  ...(Array.isArray(discovery.exclude) ? { exclude: discovery.exclude } : {}),
  ...(Array.isArray(discovery.capabilities) ? { capabilities: discovery.capabilities } : {}),
  ...(idPrefix ? { idPrefix } : {}),
  apis,
});

const prefixOf = (rule: Spec, connection: string) =>
  typeof rule.idPrefix === 'string' ? rule.idPrefix : connection;

/** Old connection ids a connection now answers for, named by its discovery rules' id prefixes. */
export const formerIds = (endpoints: Map<string, Placed>): Map<string, string> => {
  const former = new Map<string, string>();
  for (const [id, { spec }] of endpoints)
    for (const rule of Array.isArray(spec.discovery) ? spec.discovery.map(record) : []) {
      const prefix = prefixOf(rule, id);
      if (prefix !== id && !endpoints.has(prefix)) former.set(prefix, id);
    }
  return former;
};

/** Endpoints on one resource root with one credential become one connection, and models bind APIs; ids stay. */
export const planConnections = (view: CatalogView, apiFor: ApiForKind): ConnectionPlan => {
  const current = new Map([...view.endpoints].filter(([, e]) => !isLegacyEndpoint(e.spec)));
  const legacy = [...view.endpoints]
    .filter(([, e]) => isLegacyEndpoint(e.spec))
    .sort(([a], [b]) => a.localeCompare(b));
  const keyOf = (scope: string, baseURL: unknown, auth: unknown) =>
    `${scope}\u0000${resourceRoot(String(baseURL)).root}\u0000${sortedJson(auth)}`;
  const groups = new Map<string, string[]>();
  for (const [id, e] of legacy) {
    const key = keyOf(e.scope, e.spec.baseURL, e.spec.auth);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const taken = new Set(view.endpoints.keys());
  const endpoints = new Map<string, Placed>();
  const moved = new Map<string, string>();
  const target = (key: string, members: string[]) => {
    const existing = [...current].find(
      ([, e]) => keyOf(e.scope, e.spec.baseURL, e.spec.auth) === key,
    );
    if (existing) return existing[0];
    if (members.length === 1) return members[0] as string;
    const name = commonName(members);
    return name && !taken.has(name) ? name : (members[0] as string);
  };
  for (const [key, members] of groups) {
    const to = target(key, members);
    const first = view.endpoints.get(members[0] as string) as Placed;
    const base = endpoints.get(to) ??
      current.get(to) ?? {
        scope: first.scope,
        spec: {
          baseURL: resourceRoot(String(first.spec.baseURL)).root,
          auth: first.spec.auth,
          families: {},
          discovery: [],
        },
      };
    const spec: Spec = {
      ...base.spec,
      families: { ...record(base.spec.families) },
      discovery: [...(Array.isArray(base.spec.discovery) ? base.spec.discovery : [])],
    };
    const families = spec.families as Record<string, string>;
    const rules = spec.discovery as Spec[];
    for (const id of members) {
      const e = view.endpoints.get(id) as Placed;
      const family = familyOfProtocol(String(e.spec.protocol));
      const url = withoutTrailingSlashes(String(e.spec.baseURL));
      const root = withoutTrailingSlashes(String(spec.baseURL));
      const at = url.startsWith(root) ? url.slice(root.length) : url;
      if (families[family] !== undefined && families[family] !== at) {
        endpoints.set(id, {
          scope: e.scope,
          spec: {
            baseURL: e.spec.baseURL,
            auth: e.spec.auth,
            families: { [family]: '' },
            discovery: e.spec.discovery
              ? [ruleOf(record(e.spec.discovery), undefined, chatBinding(e.spec.protocol))]
              : [],
          },
        });
        continue;
      }
      families[family] = at;
      if (e.spec.discovery) {
        const discovery = record(e.spec.discovery);
        const prefix = id === to ? undefined : id;
        if (!rules.some((r) => prefixOf(r, to) === (prefix ?? to) && r.source === discovery.source))
          rules.push(ruleOf(discovery, prefix, chatBinding(e.spec.protocol)));
      }
      if (id !== to) moved.set(id, to);
    }
    endpoints.set(to, { scope: base.scope, spec });
  }
  for (const [old, now] of formerIds(new Map([...current, ...endpoints])))
    if (!view.endpoints.has(old) || moved.has(old)) moved.set(old, now);
  for (const [id] of legacy) {
    const from = record(view.endpoints.get(id)?.spec.discovery).from;
    if (typeof from !== 'string') continue;
    const to = moved.get(id) ?? id;
    const listing = moved.get(from) ?? from;
    const rule = (endpoints.get(to)?.spec.discovery as Spec[] | undefined)?.find(
      (r) => prefixOf(r, to) === id,
    );
    if (rule && listing !== to && (endpoints.has(listing) || current.has(listing)))
      rule.from = listing;
  }

  const familiesOf = (id: string) =>
    Object.keys(record((endpoints.get(id) ?? current.get(id))?.spec.families));
  const models = new Map<string, Placed>();
  for (const [id, placed] of view.models) {
    const was = String(placed.spec.endpoint);
    const now = moved.get(was) ?? was;
    if (!isLegacyModel(placed.spec) && now === was) continue;
    const old = view.endpoints.get(was)?.spec;
    const families = familiesOf(now);
    const chatApi =
      old && isLegacyEndpoint(old)
        ? legacyChatApis[String(old.protocol)]
        : families.map((f) => familyChatApis[f]).find(Boolean);
    const apis =
      isLegacyModel(placed.spec) || !placed.spec.apis
        ? legacyBindings(placed.spec, chatApi, families, apiFor)
        : (placed.spec.apis as Record<string, string>);
    const spec = { ...withoutLegacy(placed.spec, apis), endpoint: now };
    if (sortedJson(spec) !== sortedJson(placed.spec)) models.set(id, { scope: placed.scope, spec });
  }
  const removed = new Map([...moved].filter(([old]) => view.endpoints.has(old)));
  return { endpoints, removed, models, moved };
};

const chatBinding = (protocol: unknown): Record<string, string> => {
  const api = legacyChatApis[String(protocol)];
  return api ? { chat: api } : {};
};

/** One record for a merged connection: the first agreement, every sub-processor, the longest retention. */
export const mergedProcessorRecord = (records: ProcessorRecord[]): ProcessorRecord => {
  const [first, ...rest] = records as [ProcessorRecord, ...ProcessorRecord[]];
  const agreements = [...new Set(records.map((r) => r.agreement))];
  const seen = new Set<string>();
  return {
    agreement: agreements.join(' / ').slice(0, 500),
    subProcessors: records
      .flatMap((r) => r.subProcessors)
      .filter((s) => {
        const key = `${s.name}\u0000${s.location}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 50),
    retention: rest.reduce(
      (longest, r) => (r.retention.days > longest.days ? r.retention : longest),
      first.retention,
    ),
  };
};

/** The bindings a classification that lists operations gets, from the model's own bindings or its connection's families. */
export const classificationBindings = (
  operations: string[],
  modelApis: Record<string, string> | undefined,
  families: string[],
  apiFor: ApiForKind,
): Record<string, string> =>
  Object.fromEntries(
    operations.flatMap((kind) => {
      const api =
        modelApis?.[kind] ??
        (kind === 'chat'
          ? families.map((f) => familyChatApis[f]).find(Boolean)
          : apiFor(kind, families));
      return api ? [[kind, api] as const] : [];
    }),
  );

/** The first API of a kind in one of the families, built-in before descriptors and reviewed before in review. */
export const registryApiFor =
  (apis: ApiRegistry): ApiForKind =>
  (kind, families) => {
    const rank = (source: string, status: string) =>
      (source === 'built-in' ? 0 : 2) + (status === 'review' ? 1 : 0);
    return apis
      .list()
      .filter((a) => a.kind === kind && families.includes(a.family))
      .sort((a, b) => rank(a.source, a.status) - rank(b.source, b.status))[0]?.id;
  };

export interface ConnectionMigrationInput {
  store: ConfigEntryStore;
  seed: unknown;
  apis: ApiRegistry;
  classifications?: ModelClassificationStore;
  now?: () => Date;
}

export interface ConnectionMigrationResult {
  endpoints: number;
  models: number;
  removed: number;
  processorRecords: number;
  classifications: number;
}

const placedSeed = (seed: unknown) => {
  const catalog = record(seed);
  const endpoints = new Map<string, Placed>(
    Object.entries(record(catalog.endpoints)).map(([id, spec]) => [
      id,
      { scope: platformScope, spec: record(spec) },
    ]),
  );
  const models = new Map<string, Placed>(
    (Array.isArray(catalog.models) ? catalog.models : []).map((m) => {
      const { id, ...spec } = record(m);
      return [String(id), { scope: platformScope, spec }];
    }),
  );
  return { endpoints, models };
};

const plan = async (input: ConnectionMigrationInput) => {
  const latest = (await input.store.latest()).filter((e) => !e.deleted);
  const seed = placedSeed(input.seed);
  const stored = (kind: string) =>
    new Map(
      latest
        .filter((e) => e.kind === kind)
        .map((e) => [e.id, { scope: e.scope, spec: record(e.spec) }] as const),
    );
  const view: CatalogView = {
    endpoints: new Map([...seed.endpoints, ...stored('model-endpoint')]),
    models: new Map([...seed.models, ...stored('model')]),
  };
  const storedEndpoints = stored('model-endpoint');
  const storedModels = stored('model');
  const apiFor = registryApiFor(input.apis);
  const planned = planConnections(view, apiFor);
  const endpointChanges = [...planned.endpoints].filter(
    ([id, placed]) =>
      sortedJson(placed.spec) !==
      sortedJson((storedEndpoints.get(id) ?? seed.endpoints.get(id))?.spec),
  );
  const modelChanges = [...planned.models].filter(
    ([id]) => storedModels.has(id) || !seed.models.has(id),
  );
  const removals = [...planned.removed].filter(([old]) => storedEndpoints.has(old));
  const records = latest.filter(
    (e) => e.kind === processorRecordKind,
  ) as ConfigEntry<ProcessorRecord>[];
  const recordMoves = new Map<string, ProcessorRecord[]>();
  for (const entry of records) {
    const to = planned.moved.get(entry.id);
    if (!to) continue;
    recordMoves.set(to, [...(recordMoves.get(to) ?? []), entry.spec]);
  }
  const classified = input.classifications ? await input.classifications.load() : {};
  const effectiveEndpoints = new Map([...view.endpoints, ...planned.endpoints]);
  for (const old of planned.removed.keys()) effectiveEndpoints.delete(old);
  const effectiveModels = new Map([...view.models, ...planned.models]);
  const classificationChanges = Object.entries(classified).flatMap(([id, c]) => {
    const operations = (c as { operations?: unknown }).operations;
    if (!Array.isArray(operations)) return [];
    const model = effectiveModels.get(id)?.spec;
    const found = model
      ? undefined
      : [...effectiveEndpoints].flatMap(([cid, e]) =>
          (Array.isArray(e.spec.discovery) ? e.spec.discovery.map(record) : [])
            .filter((r) => id.startsWith(`${prefixOf(r, cid)}/`))
            .map((rule) => ({ connection: cid, rule })),
        )[0];
    const connection = model ? String(model.endpoint) : found?.connection;
    const families = Object.keys(record(effectiveEndpoints.get(connection ?? '')?.spec.families));
    const rest = without(c as Spec, ['operations']) as ModelClassification;
    const apis = classificationBindings(
      operations.map(String),
      (model?.apis ?? found?.rule.apis) as Record<string, string> | undefined,
      families,
      apiFor,
    );
    return [[id, { ...rest, ...(Object.keys(apis).length > 0 ? { apis } : {}) }] as const];
  });
  return {
    endpointChanges,
    modelChanges,
    removals,
    records,
    recordMoves,
    planned,
    classificationChanges,
  };
};

const isEmpty = (p: Awaited<ReturnType<typeof plan>>) =>
  p.endpointChanges.length +
    p.modelChanges.length +
    p.removals.length +
    p.recordMoves.size +
    p.classificationChanges.length ===
  0;

/** Moves stored endpoints, models, processor records and classifications to ADR 0048; a no-op once done. */
export const migrateConnections = async (
  input: ConnectionMigrationInput,
): Promise<ConnectionMigrationResult> => {
  const p = await plan(input);
  const result: ConnectionMigrationResult = {
    endpoints: p.endpointChanges.length,
    models: p.modelChanges.length,
    removed: p.removals.length,
    processorRecords: p.recordMoves.size,
    classifications: p.classificationChanges.length,
  };
  if (isEmpty(p)) return result;
  const start = (input.now?.() ?? new Date()).getTime();
  let tick = 0;
  const append = (kind: string, scope: string, id: string, spec: unknown, deleted = false) =>
    appendVersion(input.store, {
      kind,
      scope,
      id,
      spec,
      deleted,
      by: connectionMigrationActor,
      reason: connectionMigrationReason,
      at: new Date(start + tick++).toISOString(),
    });
  try {
    for (const [id, placed] of p.endpointChanges)
      await append('model-endpoint', placed.scope, id, placed.spec);
    for (const [id, placed] of p.modelChanges) await append('model', placed.scope, id, placed.spec);
    for (const [to, moving] of p.recordMoves) {
      const own = p.records.find((r) => r.id === to)?.spec;
      await append(
        processorRecordKind,
        platformScope,
        to,
        mergedProcessorRecord([...(own ? [own] : []), ...moving]),
      );
    }
    for (const entry of p.records)
      if (p.planned.moved.has(entry.id))
        await append(processorRecordKind, platformScope, entry.id, entry.spec, true);
    for (const [old] of p.removals) {
      const scope = (await input.store.latest({ kind: 'model-endpoint' })).find(
        (e) => e.id === old,
      )?.scope;
      await append('model-endpoint', scope ?? platformScope, old, {}, true);
    }
    for (const [id, c] of p.classificationChanges) await input.classifications?.save(id, c);
  } catch (error) {
    if (!isEmpty(await plan(input))) throw error;
  }
  return result;
};

export const migratedCatalog = (catalog: unknown, apiFor: ApiForKind): unknown => {
  const seed = placedSeed(catalog);
  const legacy =
    [...seed.endpoints.values()].some((e) => isLegacyEndpoint(e.spec)) ||
    [...seed.models.values()].some((m) => isLegacyModel(m.spec));
  if (!legacy) return catalog;
  const planned = planConnections(seed, apiFor);
  const endpoints = new Map([...seed.endpoints, ...planned.endpoints]);
  for (const old of planned.removed.keys()) endpoints.delete(old);
  const models = new Map([...seed.models, ...planned.models]);
  return {
    ...record(catalog),
    endpoints: Object.fromEntries([...endpoints].map(([id, e]) => [id, e.spec])),
    models: [...models].map(([id, m]) => ({ id, ...m.spec })),
  };
};
