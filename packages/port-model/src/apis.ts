import { descriptorIdPattern, type Descriptor, type DescriptorRegistry } from '@genai/operations';
import type { BuiltInApi, ModelAdapter } from './adapter.js';

export const apiIdPattern = descriptorIdPattern;

export const apiSources = ['built-in', 'bundled', 'uploaded'] as const;
export type ApiSource = (typeof apiSources)[number];

export interface ApiEntry {
  id: string;
  kind: string;
  family: string;
  source: ApiSource;
  status: Descriptor['status'];
  summary?: string;
}

export interface ApiRegistry {
  get(id: string): ApiEntry | undefined;
  list(): ApiEntry[];
  builtIn(id: string): { api: BuiltInApi; adapter: ModelAdapter } | undefined;
  descriptor(id: string): Descriptor | undefined;
  defaultFor(kind: string, family: string): string | undefined;
  kinds(): string[];
}

export type ApiDescriptors = DescriptorRegistry & { bundled?: DescriptorRegistry };

const sourceOf = (descriptors: ApiDescriptors, id: string): ApiSource =>
  !descriptors.bundled || descriptors.bundled.get(id) ? 'bundled' : 'uploaded';

/** Every API Genki can bind: built-in implementations and descriptors, one list keyed by API id. */
export const apiRegistry = (
  adapters: readonly ModelAdapter[],
  descriptors?: ApiDescriptors,
): ApiRegistry => {
  const builtIns = new Map<string, { api: BuiltInApi; adapter: ModelAdapter }>();
  for (const adapter of adapters)
    for (const api of adapter.apis) {
      if (builtIns.has(api.id)) throw new Error(`two adapters implement ${api.id}`);
      builtIns.set(api.id, { api, adapter });
    }
  const entryOf = (id: string): ApiEntry | undefined => {
    const described = descriptors?.get(id);
    const built = builtIns.get(id)?.api;
    if (built)
      return {
        id,
        kind: built.kind,
        family: built.family,
        source: 'built-in',
        status: 'typed',
        ...(described ? { summary: described.summary } : {}),
      };
    if (!described || !descriptors) return undefined;
    return {
      id,
      kind: described.operation,
      family: described.api.family,
      source: sourceOf(descriptors, id),
      status: described.status,
      summary: described.summary,
    };
  };
  const list = () =>
    [...new Set([...builtIns.keys(), ...(descriptors?.list().map((d) => d.id) ?? [])])]
      .map((id) => entryOf(id) as ApiEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
  return {
    get: entryOf,
    list,
    builtIn: (id) => builtIns.get(id),
    descriptor: (id) => descriptors?.get(id),
    defaultFor: (kind, family) =>
      [...builtIns.values()].find(
        ({ api }) => api.default && api.kind === kind && api.family === family,
      )?.api.id,
    kinds: () => [...new Set(list().map((a) => a.kind))].sort(),
  };
};
