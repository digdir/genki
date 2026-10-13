import {
  childrenOf,
  chosenVariant,
  variantsOf,
  withoutProperty,
  getAt,
  isGroup,
  isRecord,
  nonNull,
  shown,
  typeOf,
  widgetOf,
  type UiSchema,
} from './schema.js';

export type Issue =
  | { code: 'required' }
  | { code: 'number' }
  | { code: 'integer' }
  | { code: 'min'; min: number }
  | { code: 'max'; max: number }
  | { code: 'minLength'; min: number }
  | { code: 'maxLength'; max: number }
  | { code: 'pattern' }
  | { code: 'option' }
  | { code: 'json' }
  | { code: 'cron' }
  | { code: 'server'; message: string };

export type Issues = Record<string, Issue>;

const cronField = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
export const isCron = (text: string) => {
  const parts = text.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => cronField.test(p));
};

const empty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const checkValue = (schema: UiSchema, v: unknown): Issue | undefined => {
  const s = nonNull(schema);
  const type = typeOf(s);
  const widget = widgetOf(s);
  if (typeof v === 'string' && v.includes('{{')) return undefined;
  if (widget === 'code' && typeof v === 'string' && type !== 'string') return { code: 'json' };
  if (type === 'integer' || type === 'number') {
    if (typeof v !== 'number' || Number.isNaN(v)) return { code: 'number' };
    if (type === 'integer' && !Number.isInteger(v)) return { code: 'integer' };
    const min = s.minimum ?? s.exclusiveMinimum;
    const max = s.maximum ?? s.exclusiveMaximum;
    if (min !== undefined && (v < min || (s.exclusiveMinimum !== undefined && v === min)))
      return { code: 'min', min };
    if (max !== undefined && (v > max || (s.exclusiveMaximum !== undefined && v === max)))
      return { code: 'max', max };
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength)
      return { code: 'minLength', min: s.minLength };
    if (s.maxLength !== undefined && v.length > s.maxLength)
      return { code: 'maxLength', max: s.maxLength };
    if (widget === 'cron' && !isCron(v)) return { code: 'cron' };
    if (s.pattern && !s['x-sensitive'] && !new RegExp(s.pattern, 'u').test(v))
      return { code: 'pattern' };
    if (s.enum && !s.enum.includes(v)) return { code: 'option' };
  }
  return undefined;
};

export const validate = (schema: UiSchema, value: unknown): Issues => {
  const issues: Issues = {};
  const walk = (s: UiSchema, path: string) => {
    for (const field of childrenOf(s, path)) {
      const own = nonNull(field.schema);
      if (!shown(own, value, path)) continue;
      const v = getAt(value, field.path);
      const variants = variantsOf(own);
      if (variants) {
        const chosen = chosenVariant(variants, v);
        if (chosen) walk(withoutProperty(chosen.schema, variants.discriminator), field.path);
        else if (field.required)
          issues[`${field.path}.${variants.discriminator}`] = { code: 'required' };
        continue;
      }
      if (isGroup(own)) {
        if (field.required || isRecord(v)) walk(own, field.path);
        continue;
      }
      if (empty(v)) {
        if (field.required && own.default === undefined && !own['x-sensitive'])
          issues[field.path] = { code: 'required' };
        continue;
      }
      const issue = checkValue(own, v);
      if (issue) issues[field.path] = issue;
    }
  };
  walk(schema, '');
  return issues;
};

export interface ProblemLike {
  errors?: { path?: string; message: string }[];
}

export const problemIssues = (problem: ProblemLike | undefined, prefix = ''): Issues => {
  const out: Issues = {};
  for (const e of problem?.errors ?? []) {
    const raw = (e.path ?? '')
      .replace(/\[(\d+)\]/g, '.$1')
      .replace(/^\//, '')
      .replace(/\//g, '.');
    const path = prefix && raw.startsWith(`${prefix}.`) ? raw.slice(prefix.length + 1) : raw;
    out[path] ??= { code: 'server', message: e.message };
  }
  return out;
};
