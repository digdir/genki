import type { Principal } from '@genai/contracts';
import { serviceDefinition, type DefinitionStore, type PublishedVersion } from '@genai/definitions';
import { actorOf } from './admin.js';
import { appendVersion, type ConfigEntry, type ConfigEntryStore } from './config-store.js';

export const serviceDraftKind = 'service-draft';
export const draftOutdatedType = 'urn:genai:problem:draft-outdated';
export const draftOutdatedTitle = 'Utkastet bygger på en eldre versjon';

export interface ServiceDraft {
  definition: Record<string, unknown>;
  files: Record<string, string>;
  baseVersion?: number;
}

export interface DraftConflict {
  path: string;
  published: unknown;
  draft: unknown;
}

type Tree = Record<string, unknown>;
type Segments = string[];

const isRecord = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export const pathOf = (segments: Segments) => segments.join('.');

const withDefaults = (definition: Tree): Tree => {
  const parsed = serviceDefinition.safeParse(definition);
  return parsed.success ? (parsed.data as unknown as Tree) : definition;
};

const treeOf = (subject: { definition: Tree; files: Record<string, string> }) => {
  const definition = { ...subject.definition };
  if (isRecord(definition.metadata)) {
    const metadata = { ...definition.metadata };
    delete metadata.version;
    definition.metadata = metadata;
  }
  return { ...withDefaults(definition), files: subject.files };
};

const fromTree = (tree: Tree): Pick<ServiceDraft, 'definition' | 'files'> => {
  const { files, ...definition } = tree;
  return { definition, files: (isRecord(files) ? files : {}) as Record<string, string> };
};

export const changedPaths = (base: unknown, next: unknown, at: Segments = []): Segments[] => {
  if (same(base, next)) return [];
  if (isRecord(base) && isRecord(next))
    return [...new Set([...Object.keys(base), ...Object.keys(next)])].flatMap((key) =>
      changedPaths(base[key], next[key], [...at, key]),
    );
  return [at];
};

export const mergeThreeWay = (
  base: unknown,
  draft: unknown,
  published: unknown,
  conflicts: DraftConflict[],
  at: Segments = [],
): unknown => {
  if (same(draft, published) || same(base, published)) return draft;
  if (same(base, draft)) return published;
  if (isRecord(draft) && isRecord(published)) {
    const from = isRecord(base) ? base : {};
    const merged: Tree = {};
    for (const key of new Set([...Object.keys(draft), ...Object.keys(published)])) {
      const value = mergeThreeWay(from[key], draft[key], published[key], conflicts, [...at, key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  conflicts.push({ path: pathOf(at), published, draft });
  return draft;
};

const valueAt = (tree: unknown, segments: Segments) =>
  segments.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), tree);

export const serviceDrafts = (
  entries: ConfigEntryStore,
  definitions: Pick<DefinitionStore, 'get'>,
) => {
  const entryOf = async (tenant: string, service: string) =>
    (await entries.history(serviceDraftKind, tenant, service)).at(-1) as
      ConfigEntry<ServiceDraft> | undefined;

  const draftOf = async (tenant: string, service: string) => {
    const entry = await entryOf(tenant, service);
    return entry && !entry.deleted ? entry : undefined;
  };

  const latestVersion = async (tenant: string, service: string) =>
    (await definitions.get('Service', tenant, service))?.version;

  const write = async (
    principal: Principal | string,
    tenant: string,
    service: string,
    draft: ServiceDraft,
    deleted: boolean,
    reason: string,
    ifVersion?: number,
  ) => {
    const entry = await entryOf(tenant, service);
    const expected = ifVersion === 0 && entry?.deleted ? entry.version : ifVersion;
    return appendVersion<ServiceDraft>(entries, {
      kind: serviceDraftKind,
      scope: tenant,
      id: service,
      spec: draft,
      deleted,
      by: typeof principal === 'string' ? principal : actorOf(principal.actor ?? principal),
      reason,
      ...(expected === undefined ? {} : { ifVersion: expected }),
    });
  };

  const save = async (
    principal: Principal,
    tenant: string,
    service: string,
    draft: ServiceDraft,
    reason: string,
    ifVersion?: number,
  ) => {
    const baseVersion =
      draft.baseVersion ??
      (await draftOf(tenant, service))?.spec.baseVersion ??
      (await latestVersion(tenant, service)) ??
      0;
    return write(principal, tenant, service, { ...draft, baseVersion }, false, reason, ifVersion);
  };

  const remove = async (
    principal: Principal,
    tenant: string,
    service: string,
    reason: string,
    ifVersion?: number,
  ) => {
    const draft = await draftOf(tenant, service);
    if (!draft) return undefined;
    return write(principal, tenant, service, draft.spec, true, reason, ifVersion);
  };

  const baseTree = async (tenant: string, service: string, draft: ServiceDraft) => {
    if (draft.baseVersion === undefined) return undefined;
    if (draft.baseVersion === 0) return {};
    const base = await definitions.get('Service', tenant, service, draft.baseVersion);
    return base
      ? treeOf({ definition: base.definition as unknown as Tree, files: base.files })
      : undefined;
  };

  const outdated = async (tenant: string, service: string) => {
    const draft = await draftOf(tenant, service);
    const latest = await definitions.get('Service', tenant, service);
    if (!draft || !latest || draft.spec.baseVersion === undefined) return undefined;
    if (draft.spec.baseVersion >= latest.version) return undefined;
    const base = await baseTree(tenant, service, draft.spec);
    const published = treeOf({
      definition: latest.definition as unknown as Tree,
      files: latest.files,
    });
    const mine = treeOf(draft.spec);
    const reverted = changedPaths(base ?? {}, published).filter(
      (segments) => !same(valueAt(mine, segments), valueAt(published, segments)),
    );
    if (reverted.length === 0) return undefined;
    return {
      baseVersion: draft.spec.baseVersion,
      latestVersion: latest.version,
      paths: reverted.map(pathOf),
    };
  };

  const merged = async (
    tenant: string,
    service: string,
    draft: ServiceDraft,
    latest: PublishedVersion,
  ) => {
    const published = treeOf({
      definition: latest.definition as unknown as Tree,
      files: latest.files,
    });
    const mine = treeOf(draft);
    const base = (await baseTree(tenant, service, draft)) ?? published;
    const conflicts: DraftConflict[] = [];
    const tree = mergeThreeWay(base, mine, published, conflicts) as Tree;
    return {
      draft: { ...fromTree(tree), baseVersion: latest.version } satisfies ServiceDraft,
      conflicts,
      unchanged: same(tree, mine),
    };
  };

  const rebase = async (
    principal: Principal,
    tenant: string,
    service: string,
    reason: string,
    ifVersion?: number,
    onlyIfClean = false,
  ) => {
    const draft = await draftOf(tenant, service);
    if (!draft) return undefined;
    const latest = await definitions.get('Service', tenant, service);
    if (!latest) return { entry: draft, conflicts: [], applied: true };
    const result = await merged(tenant, service, draft.spec, latest);
    if (onlyIfClean && result.conflicts.length > 0)
      return { entry: draft, conflicts: result.conflicts, applied: false };
    const entry = await write(
      principal,
      tenant,
      service,
      result.draft,
      false,
      reason,
      ifVersion ?? draft.version,
    );
    return { entry, conflicts: result.conflicts, applied: true };
  };

  const followPublish = async (
    actor: string,
    tenant: string,
    service: string,
    published: PublishedVersion,
    reason: string,
  ) => {
    const draft = await draftOf(tenant, service);
    if (!draft || draft.spec.baseVersion === undefined) return undefined;
    if (draft.spec.baseVersion >= published.version) return undefined;
    const result = await merged(tenant, service, draft.spec, published);
    if (result.conflicts.length > 0 || result.unchanged) return undefined;
    return write(actor, tenant, service, result.draft, false, reason, draft.version);
  };

  return { draftOf, latestVersion, save, remove, outdated, rebase, followPublish };
};

export type ServiceDrafts = ReturnType<typeof serviceDrafts>;
