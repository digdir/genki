import type { FilterClause, FilterKind, FilterValue } from '@genai/port-knowledge';

export type FilterInput = FilterValue;
export type FilterSet = Record<string, FilterClause[]>;
export type ClauseType = 'multiselect' | 'contains' | 'not-in-set' | 'range' | 'boolean';

export const clauseType = (value: FilterClause): ClauseType => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value !== 'object' || Array.isArray(value)) return 'multiselect';
  if ('not' in value) return 'not-in-set';
  if ('contains' in value) return 'contains';
  return 'range';
};

const isAll = (v: FilterInput): v is { all: FilterClause[] } =>
  typeof v === 'object' && !Array.isArray(v) && 'all' in v;

export const toSet = (input: Record<string, FilterInput> | undefined): FilterSet =>
  Object.fromEntries(
    Object.entries(input ?? {}).map(([field, v]) => [field, isAll(v) ? [...v.all] : [v]]),
  );

export const mergeTyped = (explicit: FilterSet, detected: FilterSet): FilterSet => {
  const merged: FilterSet = Object.fromEntries(
    Object.entries(explicit).map(([f, c]) => [f, [...c]]),
  );
  for (const [field, clauses] of Object.entries(detected)) {
    const taken = new Set((explicit[field] ?? []).map(clauseType));
    const added = clauses.filter((c) => !taken.has(clauseType(c)));
    if (added.length > 0) merged[field] = [...(merged[field] ?? []), ...added];
  }
  return merged;
};

export const toInput = (set: FilterSet): Record<string, FilterInput> | undefined => {
  const entries = Object.entries(set).filter(([, clauses]) => clauses.length > 0);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([field, clauses]) => [
      field,
      clauses.length === 1 ? (clauses[0] as FilterClause) : { all: clauses },
    ]),
  );
};

export const portFilters = (input: Record<string, FilterInput> | undefined) =>
  input as Record<string, FilterValue> | undefined;

export const accepts = (
  declared: FilterKind | FilterKind[] | undefined,
  clause: FilterClause,
): boolean => {
  const kinds = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const type = clauseType(clause);
  if (type === 'multiselect')
    return (
      kinds.includes('multiselect') ||
      (kinds.includes('select') && (!Array.isArray(clause) || clause.length === 1))
    );
  if (type === 'not-in-set') return kinds.includes('multiselect');
  if (type === 'contains') return kinds.includes('text');
  return kinds.includes(type);
};

export const selectedOptions = (input: Record<string, FilterInput>, field: string): string[] => {
  const v = input[field];
  if (v === undefined) return [];
  return (isAll(v) ? v.all : [v]).flatMap((c) => {
    if (Array.isArray(c)) return c.map(String);
    if (typeof c === 'string' || typeof c === 'number') return [String(c)];
    if (typeof c === 'object' && 'not' in c) return c.not.map(String);
    if (typeof c === 'object' && 'contains' in c) return c.contains;
    return [];
  });
};

export interface HeadlessFilterField {
  type: 'multiselect' | 'contains' | 'not-in-set';
  field: string;
  'selected-options': string[];
  'value-type': 'string' | 'integer';
}

const optionList = (spec: Record<string, unknown>): (string | number)[] => {
  const raw =
    spec['selected-options'] ??
    spec.selected_options ??
    (spec.value === undefined || spec.value === null ? [] : [spec.value]);
  return Array.isArray(raw)
    ? raw.filter((o): o is string | number => typeof o === 'string' || typeof o === 'number')
    : [];
};

export const fromFilterMap = (map: unknown): Record<string, FilterInput> | undefined => {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const fields = (map as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;
  const set: FilterSet = {};
  for (const spec of fields as unknown[]) {
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    if (typeof s.field !== 'string') continue;
    const integer = (s['value-type'] ?? s.value_type) === 'integer';
    const options = optionList(s).map((o) => (integer ? Number(o) : o));
    if (options.length === 0) continue;
    const clause: FilterClause =
      s.type === 'contains'
        ? { contains: options.map(String) }
        : s.type === 'not-in-set'
          ? { not: options }
          : options;
    set[s.field] = [...(set[s.field] ?? []), clause];
  }
  return toInput(set);
};

export const toFilterMapFields = (
  input: Record<string, FilterInput> | undefined,
): HeadlessFilterField[] =>
  Object.entries(input ?? {}).flatMap(([field, v]) =>
    (isAll(v) ? v.all : [v]).flatMap((c): HeadlessFilterField[] => {
      const type: HeadlessFilterField['type'] =
        clauseType(c) === 'contains'
          ? 'contains'
          : clauseType(c) === 'not-in-set'
            ? 'not-in-set'
            : 'multiselect';
      const values = selectedOptions({ [field]: c }, field);
      const integer =
        (Array.isArray(c) && c.every((x) => typeof x === 'number')) ||
        typeof c === 'number' ||
        (typeof c === 'object' &&
          !Array.isArray(c) &&
          'not' in c &&
          c.not.every((x) => typeof x === 'number'));
      return values.length
        ? [
            {
              type,
              field,
              'selected-options': values,
              'value-type': integer ? 'integer' : 'string',
            },
          ]
        : [];
    }),
  );

export const callerFirst = (
  caller: Record<string, FilterInput> | undefined,
  model: Record<string, FilterInput> | undefined,
): Record<string, FilterInput> | undefined => {
  const merged = { ...model, ...caller };
  return Object.keys(merged).length > 0 ? merged : undefined;
};
