import {
  isHttpsAddress,
  isSitePath,
  templatePagePattern,
  type TemplateHref,
  type TemplateText,
  type TextPart,
} from '@genai/contracts/block-template';
import type { BlockTexts } from '@genai/contracts/blocks';

export type BlockLocale = 'nb' | 'nn' | 'en';

export interface Scope {
  data: Readonly<Record<string, unknown>>;
  props: Readonly<Record<string, unknown>>;
  items: ReadonlyMap<string, unknown>;
}

const intlLocale = (locale: BlockLocale) =>
  locale === 'en' ? 'en-GB' : locale === 'nn' ? 'nn-NO' : 'nb-NO';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a path, reading only own properties. */
export const valueAt = (path: string, scope: Scope): unknown => {
  const [head = '', ...rest] = path.split('.');
  let value: unknown = scope.items.has(head)
    ? scope.items.get(head)
    : head === 'props'
      ? scope.props
      : Object.hasOwn(scope.data, head)
        ? scope.data[head]
        : undefined;
  for (const key of rest) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
};

export const listAt = (path: string, scope: Scope): unknown[] => {
  const value = valueAt(path, scope);
  return Array.isArray(value) ? value : [];
};

export const formatValue = (
  value: unknown,
  locale: BlockLocale,
  format: 'plain' | 'date' | 'number' = 'plain',
): string => {
  if (format === 'date' && typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium' }).format(date);
  }
  if (typeof value === 'number')
    return format === 'number'
      ? new Intl.NumberFormat(intlLocale(locale)).format(value)
      : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ');
  return '';
};

const textIn = (texts: BlockTexts | undefined, locale: BlockLocale, key: string) => {
  const own = texts?.[locale];
  if (own && Object.hasOwn(own, key)) return own[key];
  const nb = texts?.nb;
  return nb && Object.hasOwn(nb, key) ? nb[key] : undefined;
};

const partOf = (
  part: TextPart,
  scope: Scope,
  texts: BlockTexts | undefined,
  locale: BlockLocale,
): string => {
  if (typeof part === 'string') return part;
  if ('bind' in part) return formatValue(valueAt(part.bind, scope), locale, part.format);
  if (!('t' in part)) return formatValue(listAt(part.count, scope).length, locale, 'number');
  const args = new Map<string, string>();
  let count: number | undefined;
  for (const [name, arg] of Object.entries(part.args ?? {})) {
    if (typeof arg === 'string') args.set(name, formatValue(valueAt(arg, scope), locale));
    else {
      const n = listAt(arg.count, scope).length;
      if (name === 'count') count = n;
      args.set(name, formatValue(n, locale, 'number'));
    }
  }
  const key =
    count === undefined
      ? part.t
      : `${part.t}.${new Intl.PluralRules(intlLocale(locale)).select(count)}`;
  const template = textIn(texts, locale, key) ?? textIn(texts, locale, `${part.t}.other`) ?? '';
  return template.replace(
    /\{([a-zA-Z][a-zA-Z0-9]{0,31})\}/g,
    (whole, name: string) => args.get(name) ?? whole,
  );
};

/** A template text as plain text: data is only ever text, never markup. */
export const textOf = (
  text: TemplateText,
  scope: Scope,
  texts: BlockTexts | undefined,
  locale: BlockLocale,
) =>
  (Array.isArray(text) ? text : [text]).map((part) => partOf(part, scope, texts, locale)).join('');

/** A link's address when it is https or a page of the host's own site; otherwise none. */
export const hrefOf = (href: TemplateHref, scope: Scope): string | undefined => {
  if (typeof href === 'string') return isHttpsAddress(href) ? href : undefined;
  if ('page' in href) return templatePagePattern.test(href.page) ? `/${href.page}` : undefined;
  const value = valueAt(href.bind, scope);
  return typeof value === 'string' && (isHttpsAddress(value) || isSitePath(value))
    ? value
    : undefined;
};
