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

export const resolveCatalog = (
  raw: unknown,
  listKey: string,
  env: NodeJS.ProcessEnv,
): LoadedCatalog => {
  const filled = interpolate(raw ?? {}, env) as Record<string, unknown>;
  const skipped: string[] = [];
  const reachable = Object.fromEntries(
    Object.entries((filled.endpoints ?? {}) as Record<string, unknown>).filter(([name, e]) => {
      if (!unresolved(e)) return true;
      skipped.push(`endpoint ${name}`);
      return false;
    }),
  );
  const endpoints = Object.fromEntries(
    Object.entries(reachable).filter(([name, e]) => {
      const from = (e as { discovery?: { from?: string } }).discovery?.from;
      if (!from || reachable[from]) return true;
      skipped.push(`endpoint ${name}`);
      return false;
    }),
  );
  const entries = ((filled[listKey] ?? []) as { id: string; endpoint: string }[]).filter(
    (entry) => {
      if (endpoints[entry.endpoint] && !unresolved(entry)) return true;
      skipped.push(`${listKey} ${entry.id}`);
      return false;
    },
  );
  return { catalog: { ...filled, endpoints, [listKey]: entries }, skipped };
};

export const loadCatalog = (dir: string, file: string, listKey: string, env = process.env) =>
  resolveCatalog(parseYaml(readFileSync(join(dir, file), 'utf8')), listKey, env);
