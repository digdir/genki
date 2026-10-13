import { isRecord, nonNull, typeOf, type UiSchema } from './schema.js';

const matchesType = (schema: UiSchema, v: unknown) => {
  const type = typeOf(schema);
  if (v === null)
    return (
      schema.type === 'null' ||
      (Array.isArray(schema.type) && schema.type.includes('null')) ||
      !!(schema.anyOf ?? schema.oneOf)?.some((s) => s.type === 'null')
    );
  if (type === undefined) return true;
  if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (type === 'number') return typeof v === 'number';
  if (type === 'array') return Array.isArray(v);
  if (type === 'object') return isRecord(v);
  return typeof v === type;
};

export const undescribedPaths = (schema: UiSchema, value: unknown, path = ''): string[] => {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants && variants.length > 1 && value !== null) {
    const fits = variants
      .filter((v) => v.type !== 'null')
      .map((v) => undescribedPaths({ ...v, ...withoutVariants(schema) }, value, path));
    return fits.find((f) => f.length === 0) ?? fits[0] ?? [];
  }
  const s = nonNull(schema);
  const here = path || '(root)';
  if (!matchesType(s, value)) return [here];
  if (s.const !== undefined && s.const !== value) return [here];
  if (s.enum && !s.enum.includes(value)) return [here];
  if (Array.isArray(value)) {
    const items = s.items;
    return items
      ? value.flatMap((v, i) => undescribedPaths(items, v, `${path}${path ? '.' : ''}${i}`))
      : [];
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, v]) => {
    const at = path ? `${path}.${key}` : key;
    const own = s.properties?.[key];
    if (own) return undescribedPaths(own, v, at);
    if (isRecord(s.additionalProperties)) return undescribedPaths(s.additionalProperties, v, at);
    if (s.additionalProperties === true) return [];
    return [at];
  });
};

const withoutVariants = (schema: UiSchema) => {
  const rest: UiSchema = { ...schema };
  delete rest.anyOf;
  delete rest.oneOf;
  return rest;
};

export interface Submission {
  method: string;
  path: string;
  body: unknown;
}

export const captureSubmissions = (base: typeof fetch) => {
  const sent: Submission[] = [];
  const send: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && typeof init?.body === 'string')
      sent.push({
        method,
        path: new URL(url, 'http://local').pathname,
        body: JSON.parse(init.body) as unknown,
      });
    return base(input, init);
  };
  return { fetch: send, sent };
};
