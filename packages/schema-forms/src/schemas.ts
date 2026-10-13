import type { Locale } from '@genai/i18n';
import { useLocale } from '@genai/i18n/react';
import { useEffect, useState } from 'react';
import type { FetchJson } from './context.js';
import { isRecord, type SchemaRef, type SchemaUse, type Text, type UiSchema } from './schema.js';

export const schemaPath = (kind: string, version: string) =>
  `/schemas/${encodeURIComponent(kind)}@${encodeURIComponent(version)}`;

const textOf = (v: unknown): Text | undefined =>
  typeof v === 'string' || isRecord(v) ? (v as Text) : undefined;

export const parseSchemaList = (body: unknown): SchemaRef[] => {
  const list = Array.isArray(body)
    ? body
    : isRecord(body)
      ? ((Array.isArray(body.data)
          ? body.data
          : Array.isArray(body.schemas)
            ? body.schemas
            : body.kinds) ?? [])
      : [];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): SchemaRef[] => {
    if (!isRecord(entry) || typeof entry.kind !== 'string') return [];
    const versions = Array.isArray(entry.versions)
      ? entry.versions.filter((v): v is string => typeof v === 'string')
      : [typeof entry.version === 'string' ? entry.version : 'v1'];
    const label = textOf(entry.label ?? entry['x-label'] ?? entry.title);
    const help = textOf(entry.help ?? entry['x-help'] ?? entry.description);
    return versions.map((version) => ({
      kind: entry.kind as string,
      version,
      ...(label ? { label } : {}),
      ...(help ? { help } : {}),
      ...(typeof entry.href === 'string' ? { href: entry.href } : {}),
      ...(Array.isArray(entry.uses) ? { uses: entry.uses.filter(isUse) } : {}),
    }));
  });
};

const isUse = (u: unknown): u is SchemaUse =>
  isRecord(u) && typeof u.at === 'string' && typeof u.href === 'string';

const cache = new WeakMap<FetchJson, Map<string, Promise<unknown>>>();

export const fetchCached = (fetchJson: FetchJson, path: string, locale: Locale) => {
  let own = cache.get(fetchJson);
  if (!own) {
    own = new Map();
    cache.set(fetchJson, own);
  }
  const key = `${locale} ${path}`;
  const hit = own.get(key);
  if (hit) return hit;
  const made = fetchJson(path, undefined, locale).catch((error: unknown) => {
    own.delete(key);
    throw error;
  });
  own.set(key, made);
  return made;
};

export type Loaded<V> =
  { status: 'loading' } | { status: 'failed'; error: unknown } | { status: 'ready'; data: V };

const useLoaded = <V>(
  fetchJson: FetchJson | undefined,
  path: string | undefined,
  read: (b: unknown) => V,
) => {
  const { locale } = useLocale();
  const [state, setState] = useState<Loaded<V>>({ status: 'loading' });
  useEffect(() => {
    if (!fetchJson || !path) return;
    let active = true;
    setState({ status: 'loading' });
    fetchCached(fetchJson, path, locale).then(
      (body) => active && setState({ status: 'ready', data: read(body) }),
      (error: unknown) => active && setState({ status: 'failed', error }),
    );
    return () => {
      active = false;
    };
  }, [fetchJson, path, locale]);
  return state;
};

export const useSchemaList = (fetchJson: FetchJson | undefined) =>
  useLoaded(fetchJson, '/schemas', parseSchemaList);

const asSchema = (body: unknown): UiSchema => (isRecord(body) ? (body as UiSchema) : {});

export const useSchema = (
  fetchJson: FetchJson | undefined,
  kind: string | undefined,
  version = 'v1',
) =>
  useLoaded(
    fetchJson,
    kind ? (kind.startsWith('/') ? kind : schemaPath(kind, version)) : undefined,
    asSchema,
  );
