import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from '@genai/i18n';
import { useLocale } from '@genai/i18n/react';
import {
  getAt,
  isRecord,
  nonNull,
  resolveText,
  type OptionsRoute,
  type OptionsSource,
  type UiSchema,
} from './schema.js';

export type FetchJson = (path: string, signal?: AbortSignal, locale?: Locale) => Promise<unknown>;

export interface SchemaFormSettings {
  fetchJson?: FetchJson;
  routeParams?: Record<string, string>;
  can?: (right: string) => boolean;
  rightLabel?: (right: string) => string;
  operator?: boolean;
  layer?: string;
}

const Settings = createContext<SchemaFormSettings>({});

export const SchemaFormProvider = ({
  children,
  ...settings
}: SchemaFormSettings & { children?: ReactNode }) => {
  const outer = useContext(Settings);
  const value = useMemo(
    () => ({ ...outer, ...settings }),
    [
      outer,
      settings.fetchJson,
      settings.routeParams,
      settings.can,
      settings.rightLabel,
      settings.operator,
      settings.layer,
    ],
  );
  return <Settings.Provider value={value}>{children}</Settings.Provider>;
};

export const useSchemaFormSettings = () => useContext(Settings);

export interface Option {
  value: string;
  label: string;
}

export const fillRoute = (route: string, params: Record<string, string> = {}) =>
  route.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? `{${name}}`));

const listIn = (body: unknown, items?: string): unknown[] => {
  if (Array.isArray(body)) return body;
  const nested = items?.includes('.') ? getAt(body, items) : undefined;
  if (Array.isArray(nested)) return nested;
  if (!isRecord(body)) return [];
  if (items && Array.isArray(body[items])) return body[items];
  for (const key of ['data', 'items', 'entries', 'values', 'models', 'datasets', 'tools'])
    if (Array.isArray(body[key])) return body[key];
  return Object.values(body).find(Array.isArray) ?? [];
};

const routeOf = (source: OptionsSource | undefined): OptionsRoute | undefined => {
  if (typeof source === 'string') return source.startsWith('/') ? { route: source } : undefined;
  if (isRecord(source) && 'route' in source && typeof source.route === 'string')
    return source as OptionsRoute;
  return undefined;
};

const pick = (item: unknown, key: string | undefined, fallbacks: string[]) => {
  if (!isRecord(item)) return String(item);
  for (const k of key ? [key] : fallbacks) {
    const v = item[k];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return undefined;
};

const toOptions = (list: unknown[], route: OptionsRoute, locale: 'nb' | 'en'): Option[] =>
  list.flatMap((item) => {
    const value = pick(item, route.value, ['id', 'value', 'name', 'ref', 'key']);
    if (value === undefined) return [];
    const rawLabel = isRecord(item) ? item[route.label ?? ''] : undefined;
    const label =
      (isRecord(rawLabel) || typeof rawLabel === 'string'
        ? resolveText(rawLabel as never, locale)
        : undefined) ??
      pick(item, undefined, ['label', 'title', 'name', 'displayName']) ??
      value;
    return [{ value, label }];
  });

export const staticOptions = (schema: UiSchema, locale: 'nb' | 'en'): Option[] | undefined => {
  const s = nonNull(schema);
  const source = s['x-options'];
  if (Array.isArray(source))
    return source.map((o) => ({ value: o.value, label: resolveText(o.label, locale) ?? o.value }));
  const listed =
    isRecord(source) && Array.isArray(source.enum) ? (source.enum as unknown[]) : undefined;
  const values = s.enum ?? (s.items ? nonNull(s.items).enum : undefined) ?? listed;
  if (!values) return undefined;
  const named = s['x-enumLabels'] ?? (s.items ? nonNull(s.items)['x-enumLabels'] : undefined);
  return values.map((v, i) => {
    const value = String(v);
    return {
      value,
      label: resolveText(named?.[value], locale) ?? s.enumTitles?.[i] ?? value,
    };
  });
};

export type OptionsState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; options: Option[] };

export const useOptions = (schema: UiSchema): OptionsState => {
  const { locale } = useLocale();
  const { fetchJson, routeParams } = useSchemaFormSettings();
  const fixed = staticOptions(schema, locale);
  const route = routeOf(nonNull(schema)['x-options']);
  const path = route ? fillRoute(route.route, routeParams) : undefined;
  const [state, setState] = useState<OptionsState>(
    fixed
      ? { status: 'ready', options: fixed }
      : route
        ? { status: 'loading' }
        : { status: 'none' },
  );
  useEffect(() => {
    if (fixed || !route || !path) return;
    if (!fetchJson) {
      setState({ status: 'none' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchJson(path, controller.signal).then(
      (body) => {
        if (!controller.signal.aborted)
          setState({
            status: 'ready',
            options: toOptions(listIn(body, route.items), route, locale),
          });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      },
    );
    return () => controller.abort();
  }, [path, fetchJson, locale, Boolean(fixed)]);
  return fixed ? { status: 'ready', options: fixed } : state;
};
