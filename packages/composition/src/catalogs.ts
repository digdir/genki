import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface LoadedCatalog {
  catalog: Record<string, unknown>;
  skipped: string[];
}

const placeholder = /\$\{([A-Z0-9_]+)\}/g;

const unresolved = (value: unknown): boolean =>
  typeof value === 'string'
    ? /\$\{[A-Z0-9_]+\}/.test(value)
    : Array.isArray(value)
      ? value.some(unresolved)
      : value !== null && typeof value === 'object'
        ? Object.values(value).some(unresolved)
        : false;

const interpolate = (value: unknown, env: NodeJS.ProcessEnv): unknown => {
  if (typeof value === 'string')
    return value.replace(placeholder, (m, name: string) => env[name] || m);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const rulesOf = (endpoint: unknown): Record<string, unknown>[] => {
  const discovery = record(endpoint).discovery;
  if (Array.isArray(discovery)) return discovery.map(record);
  return discovery ? [record(discovery)] : [];
};

/** An API id names its provider first, and every built-in provider is also its family's name. */
const needsFamily = (apis: unknown, families: Set<string>) =>
  Object.values(record(apis)).some((id) => families.has(String(id).split('/')[0] ?? ''));

/** Drops the families whose base is not set; the endpoint stays when another family is. */
const withSetFamilies = (name: string, endpoint: unknown, skipped: string[]) => {
  const spec = record(endpoint);
  const families = record(spec.families);
  const unset = new Set(Object.keys(families).filter((f) => unresolved(families[f])));
  if (unset.size === 0 || unset.size === Object.keys(families).length) return { spec, unset };
  for (const family of unset) skipped.push(`endpoint ${name} family ${family}`);
  const rules = rulesOf(spec).filter((r) => !needsFamily(r.apis, unset));
  return {
    spec: {
      ...spec,
      families: Object.fromEntries(Object.entries(families).filter(([f]) => !unset.has(f))),
      ...(Array.isArray(spec.discovery) ? { discovery: rules } : {}),
    },
    unset,
  };
};

export const resolveCatalog = (
  raw: unknown,
  listKey: string,
  env: NodeJS.ProcessEnv,
): LoadedCatalog => {
  const filled = interpolate(raw ?? {}, env) as Record<string, unknown>;
  const skipped: string[] = [];
  const unsetFamilies = new Map<string, Set<string>>();
  const reachable = Object.fromEntries(
    Object.entries((filled.endpoints ?? {}) as Record<string, unknown>).flatMap(([name, e]) => {
      const { spec, unset } = withSetFamilies(name, e, skipped);
      if (!unresolved(spec)) {
        unsetFamilies.set(name, unset);
        return [[name, spec]];
      }
      skipped.push(`endpoint ${name}`);
      return [];
    }),
  );
  const endpoints = Object.fromEntries(
    Object.entries(reachable).filter(([name, e]) => {
      if (rulesOf(e).every((r) => !r.from || reachable[String(r.from)])) return true;
      skipped.push(`endpoint ${name}`);
      return false;
    }),
  );
  const entries = (
    (filled[listKey] ?? []) as { id: string; endpoint: string; apis?: unknown }[]
  ).filter((entry) => {
    if (
      endpoints[entry.endpoint] &&
      !unresolved(entry) &&
      !needsFamily(entry.apis, unsetFamilies.get(entry.endpoint) ?? new Set())
    )
      return true;
    skipped.push(`${listKey} ${entry.id}`);
    return false;
  });
  return { catalog: { ...filled, endpoints, [listKey]: entries }, skipped };
};

export const loadCatalog = (dir: string, file: string, listKey: string, env = process.env) =>
  resolveCatalog(parseYaml(readFileSync(join(dir, file), 'utf8')), listKey, env);
