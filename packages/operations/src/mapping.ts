import { DescriptorError } from './shape.js';

export type Scope = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const operators = ['$from', '$default', '$omitWhen', '$each', '$sort', '$map', '$literal'];

const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('$');

const segment = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const lookup = (path: string, scope: Scope): unknown => {
  const [root, ...rest] = path.slice(1).split('.');
  if (!root || !(root in scope))
    throw new DescriptorError(`unknown root $${root ?? ''} in ${path}`);
  let value: unknown = scope[root];
  for (const key of rest) {
    if (!segment.test(key)) throw new DescriptorError(`not a field name: ${key} in ${path}`);
    value = isRecord(value) ? value[key] : undefined;
  }
  return value;
};

const isOperator = (value: Record<string, unknown>) => {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
};

/** Evaluates a declarative mapping: `$root.path` reads a value, `$`-keyed maps transform, the rest is literal. */
export const evaluate = (template: unknown, scope: Scope): unknown => {
  if (isPath(template)) return lookup(template, scope);
  if (Array.isArray(template)) return template.map((t) => evaluate(t, scope));
  if (!isRecord(template)) return template;
  if (!isOperator(template)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const mapped = evaluate(value, scope);
      if (mapped !== undefined) out[key] = mapped;
    }
    return out;
  }
  const unknown = Object.keys(template).filter((k) => !operators.includes(k));
  if (unknown.length > 0)
    throw new DescriptorError(`unknown mapping operator ${unknown.join(', ')}`);
  if ('$literal' in template) return template.$literal;
  if ('$each' in template) {
    const items = evaluate(template.$each, scope);
    if (items === undefined) return undefined;
    if (!Array.isArray(items)) throw new DescriptorError('$each must read a list');
    const sortBy = template.$sort;
    const ordered =
      typeof sortBy === 'string'
        ? [...items].sort(
            (a, b) => Number(isRecord(a) ? a[sortBy] : 0) - Number(isRecord(b) ? b[sortBy] : 0),
          )
        : items;
    return ordered.map((item) =>
      '$map' in template ? evaluate(template.$map, { ...scope, item }) : item,
    );
  }
  if ('$from' in template) {
    const value = evaluate(template.$from, scope);
    const omit = Array.isArray(template.$omitWhen) ? template.$omitWhen : [];
    if (value === undefined || value === null)
      return '$default' in template ? evaluate(template.$default, scope) : undefined;
    return omit.includes(value) ? undefined : value;
  }
  throw new DescriptorError(`a mapping operator needs $from, $each or $literal`);
};

/** The roots a mapping reads, so a descriptor can be checked before it runs. */
export const rootsOf = (template: unknown): string[] => {
  if (isPath(template)) return [template.slice(1).split('.')[0] ?? ''];
  if (Array.isArray(template)) return template.flatMap(rootsOf);
  if (!isRecord(template)) return [];
  if ('$literal' in template && isOperator(template)) return [];
  return Object.values(template).flatMap(rootsOf);
};
