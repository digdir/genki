import { isMediaInput } from '@genai/kernel';
import { DescriptorError } from './shape.js';

export type Scope = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const operators = [
  '$from',
  '$default',
  '$omitWhen',
  '$each',
  '$sort',
  '$map',
  '$literal',
  '$concat',
  '$join',
  '$if',
  '$add',
  '$sub',
  '$mul',
  '$coalesce',
  '$dataUrl',
];

const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('$');

const segment = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const index = /^(?:0|[1-9]\d{0,5})$/;

const lookup = (path: string, scope: Scope): unknown => {
  const [root, ...rest] = path.slice(1).split('.');
  if (!root || !(root in scope))
    throw new DescriptorError(`unknown root $${root ?? ''} in ${path}`);
  let value: unknown = scope[root];
  for (const key of rest) {
    if (index.test(key)) {
      value = Array.isArray(value) ? value[Number(key)] : undefined;
      continue;
    }
    if (!segment.test(key)) throw new DescriptorError(`not a field name: ${key} in ${path}`);
    value = isRecord(value) ? value[key] : undefined;
  }
  return value;
};

const isOperator = (value: Record<string, unknown>) => {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
};

const scalarText = (value: unknown, what: string): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new DescriptorError(`${what} joins text, numbers and booleans only`);
};

/** Whether a mapped test holds: it equals one of the given values, or is set and not false, 0 or empty. */
export const holds = (value: unknown, equals?: unknown): boolean => {
  if (equals !== undefined)
    return (Array.isArray(equals) ? equals : [equals]).some((e) => e === value);
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== '';
};

const numberOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
};

const arithmetic = (name: string, spec: unknown, scope: Scope): number | undefined => {
  if (!Array.isArray(spec) || spec.length < 2 || (name === '$sub' && spec.length !== 2))
    throw new DescriptorError(`${name} takes a list of numbers`);
  const values = spec.map((t) => evaluate(t, scope));
  if (values.some((v) => v === undefined || v === null)) return undefined;
  const numbers = values.map(numberOf);
  if (numbers.some((n) => n === undefined)) throw new DescriptorError(`${name} reads numbers only`);
  const [first = 0, ...rest] = numbers as number[];
  if (name === '$sub') return first - (rest[0] ?? 0);
  return rest.reduce((sum, n) => (name === '$add' ? sum + n : sum * n), first);
};

const conditional = (spec: unknown, scope: Scope): unknown => {
  if (!isRecord(spec) || !('test' in spec) || !('then' in spec))
    throw new DescriptorError('$if needs test and then, and may have equals and else');
  const unknown = Object.keys(spec).filter((k) => !['test', 'equals', 'then', 'else'].includes(k));
  if (unknown.length > 0) throw new DescriptorError(`$if: unknown key ${unknown.join(', ')}`);
  const equals = 'equals' in spec ? evaluate(spec.equals, scope) : undefined;
  return holds(evaluate(spec.test, scope), equals)
    ? evaluate(spec.then, scope)
    : evaluate(spec.else, scope);
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
  if ('$if' in template) return conditional(template.$if, scope);
  for (const name of ['$add', '$sub', '$mul'])
    if (name in template) return arithmetic(name, template[name], scope);
  if ('$coalesce' in template) {
    if (!Array.isArray(template.$coalesce) || template.$coalesce.length < 2)
      throw new DescriptorError('$coalesce takes a list of values');
    for (const t of template.$coalesce) {
      const value = evaluate(t, scope);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }
  if ('$dataUrl' in template) {
    const value = evaluate(template.$dataUrl, scope);
    if (value === undefined) return undefined;
    if (!isMediaInput(value)) throw new DescriptorError('$dataUrl reads a media value');
    return { ...value, dataUrl: true };
  }
  if ('$concat' in template) {
    if (!Array.isArray(template.$concat)) throw new DescriptorError('$concat takes a list');
    const parts = template.$concat.map((t) => evaluate(t, scope)).filter((p) => p !== undefined);
    if (parts.length > 0 && parts.every(Array.isArray)) return parts.flat();
    return parts.map((p) => scalarText(p, '$concat')).join('');
  }
  if ('$join' in template) {
    const spec = template.$join;
    if (!Array.isArray(spec) || spec.length !== 2 || typeof spec[1] !== 'string')
      throw new DescriptorError('$join takes a list to join and the text between its items');
    const items = evaluate(spec[0], scope);
    if (items === undefined) return undefined;
    if (!Array.isArray(items)) throw new DescriptorError('$join must read a list');
    return items.map((i) => scalarText(i, '$join')).join(spec[1]);
  }
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
  throw new DescriptorError(
    'a mapping operator needs $from, $each, $concat, $join, $if, $literal, $add, $sub, $mul, $coalesce or $dataUrl',
  );
};

/** The roots a mapping reads, so a descriptor can be checked before it runs. */
export const rootsOf = (template: unknown): string[] => {
  if (isPath(template)) return [template.slice(1).split('.')[0] ?? ''];
  if (Array.isArray(template)) return template.flatMap(rootsOf);
  if (!isRecord(template)) return [];
  if ('$literal' in template && isOperator(template)) return [];
  return Object.values(template).flatMap(rootsOf);
};

/** Every `$path` a mapping reads, such as `$steps.start.job`. */
export const pathsOf = (template: unknown): string[] => {
  if (isPath(template)) return [template];
  if (Array.isArray(template)) return template.flatMap(pathsOf);
  if (!isRecord(template)) return [];
  if ('$literal' in template && isOperator(template)) return [];
  return Object.values(template).flatMap(pathsOf);
};
