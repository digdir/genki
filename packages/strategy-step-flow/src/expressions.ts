export interface StepRecord {
  status: 'done' | 'skipped' | 'defaulted';
  output: unknown;
}

export interface Scope {
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  settings?: Record<string, unknown>;
  vars: Record<string, unknown>;
  steps: Record<string, StepRecord>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const walk = (value: unknown, path: string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (Array.isArray(current) && key === 'length') current = current.length;
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
};

const literal = (text: string): { ok: true; value: unknown } | { ok: false } => {
  const t = text.trim();
  if (t === 'true') return { ok: true, value: true };
  if (t === 'false') return { ok: true, value: false };
  if (t === 'null') return { ok: true, value: null };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  if (/^'(?:[^'\\]|\\.)*'$/.test(t))
    return { ok: true, value: t.slice(1, -1).replace(/\\'/g, "'") };
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return { ok: true, value: JSON.parse(t) as unknown };
  return { ok: false };
};

export const resolvePath = (expression: string, scope: Scope): unknown => {
  const alternatives = expression.split('??').map((a) => a.trim());
  for (const alternative of alternatives.slice(0, -1)) {
    const value = resolveOne(alternative, scope);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return resolveOne(alternatives.at(-1) ?? '', scope);
};

const resolveOne = (expression: string, scope: Scope): unknown => {
  const parsed = literal(expression);
  if (parsed.ok) return parsed.value;
  const [head = '', ...rest] = expression.split('.');
  if (head === 'input') return walk(scope.input, rest);
  if (head === 'config') return walk(scope.config, rest);
  if (head === 'settings') return walk(scope.settings ?? {}, rest);
  if (head === 'vars') return walk(scope.vars, rest);
  if (head === 'steps') {
    const [id = '', field, ...tail] = rest;
    const record = scope.steps[id];
    if (!record) return undefined;
    if (field === 'status') return record.status;
    if (field === 'output') return walk(record.output, tail);
    return walk(record.output, field === undefined ? [] : [field, ...tail]);
  }
  if (head in scope.vars) return walk(scope.vars[head], rest);
  const record = scope.steps[head];
  return record ? walk(record.output, rest) : undefined;
};

const comparison = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

const truthy = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === '' ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );

export const evaluateCondition = (expression: string, scope: Scope): boolean => {
  const trimmed = expression.trim();
  if (trimmed.startsWith('!')) return !evaluateCondition(trimmed.slice(1), scope);
  const match = comparison.exec(trimmed);
  if (!match) return truthy(resolvePath(trimmed, scope));
  const [, left = '', op, right = ''] = match;
  const a = resolvePath(left, scope);
  const b = resolvePath(right, scope);
  switch (op) {
    case '==':
      return sameValue(a, b);
    case '!=':
      return !sameValue(a, b);
    case '>':
      return Number(a) > Number(b);
    case '>=':
      return Number(a) >= Number(b);
    case '<':
      return Number(a) < Number(b);
    default:
      return Number(a) <= Number(b);
  }
};

export const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

const template = /\{\{\s*([^}]+?)\s*\}\}/g;
const whole = /^\{\{\s*([^}]+?)\s*\}\}$/;

const asText = (value: unknown) =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

export const render = (value: unknown, scope: Scope): unknown => {
  if (typeof value === 'string') {
    const single = whole.exec(value);
    if (single?.[1]) return resolvePath(single[1], scope);
    return value.replace(template, (_m, path: string) => asText(resolvePath(path, scope)));
  }
  if (Array.isArray(value)) return value.map((v) => render(v, scope));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, scope)]));
  return value;
};

export const referencedSteps = (value: unknown): string[] => {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(template)) out.push(...stepsIn(m[1] ?? ''));
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (isRecord(v)) Object.values(v).forEach(visit);
  };
  visit(value);
  return out;
};

export const stepsIn = (expression: string): string[] =>
  expression
    .split('??')
    .map((part) => part.trim())
    .flatMap((part) => {
      if (literal(part).ok) return [];
      const [head = '', id] = part.split('.');
      if (head === 'steps') return id ? [id] : [];
      return ['input', 'config', 'settings', 'vars'].includes(head) ? [] : [head];
    });
