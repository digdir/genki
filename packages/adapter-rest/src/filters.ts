import type { FilterClause, FilterValue } from '@genai/port-knowledge';

export interface FieldSpec {
  field: string;
  type?: string;
  valueType?: string;
  selected: string[];
}

const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const fieldTypes = ['contains', 'multiselect', 'not-in-set'];
const specKeys = new Set(['field', 'type', 'value-type', 'selected-options', 'value']);
const maxOptions = 100;
const maxValueLength = 256;
const maxFields = 20;

export const isFieldName = (s: unknown): s is string =>
  typeof s === 'string' && fieldNamePattern.test(s);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const prStr = (v: unknown): string => {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(prStr).join(' ')}]`;
  if (isRecord(v))
    return `{${Object.entries(v)
      .map(([k, x]) => `:${k} ${prStr(x)}`)
      .join(', ')}}`;
  return String(v);
};

const clip = (s: string, n: number) => s.slice(0, Math.min(n, s.length));

const unsafe = (s: string) =>
  [...s].some((c) => c === '`' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

const named = (x: unknown) => (typeof x === 'string' ? x : undefined);

const optionsOf = (spec: Record<string, unknown>): unknown[] | null => {
  const selected = spec['selected-options'];
  if (Array.isArray(selected)) return selected;
  if (selected !== undefined && selected !== null) return null;
  if (spec.value !== undefined && spec.value !== null) return [spec.value];
  return [];
};

const specErrors = (spec: unknown): string[] => {
  if (!isRecord(spec)) return ['Each filter field must be an object.'];
  const errors: string[] = [];
  const options = optionsOf(spec);
  const unknown = Object.keys(spec).filter((k) => !specKeys.has(k));
  if (unknown.length > 0) {
    const listed = `[${unknown
      .slice(0, 5)
      .map((k) => `:${k}`)
      .join(' ')}]`;
    errors.push(`Unknown filter field keys: ${clip(listed, 200)}.`);
  }
  if (!isFieldName(spec.field))
    errors.push(`Filter field must be a plain field name; got ${clip(prStr(spec.field), 80)}.`);
  if (spec.type !== undefined && spec.type !== null && !fieldTypes.includes(named(spec.type) ?? ''))
    errors.push(
      `Filter type must be one of (${fieldTypes.map((t) => `"${t}"`).join(' ')}); got ${prStr(spec.type)}.`,
    );
  const valueType = spec['value-type'];
  if (
    valueType !== undefined &&
    valueType !== null &&
    !['integer', 'string'].includes(named(valueType) ?? '')
  )
    errors.push(`Filter value-type must be integer or string; got ${prStr(valueType)}.`);
  if (options === null) errors.push('Filter selected-options must be a list.');
  if (options !== null && options.length === 0)
    errors.push('A filter field needs at least one option.');
  const list = options ?? [];
  if (list.length > maxOptions) errors.push(`A filter field takes at most ${maxOptions} options.`);
  if (list.some((o) => !(typeof o === 'string' || Number.isInteger(o))))
    errors.push('Filter options must be strings or integers.');
  if (list.some((o) => typeof o === 'string' && unsafe(o)))
    errors.push('Filter options cannot contain a backtick, a backslash or a control character.');
  if (list.some((o) => typeof o === 'string' && o.length > maxValueLength))
    errors.push(`Filter options are at most ${maxValueLength} characters.`);
  if (named(valueType) === 'integer' && list.some((o) => !/^-?\d+$/.test(String(o))))
    errors.push('An integer filter takes only integer options.');
  return errors;
};

export const filterMapErrors = (filterMap: unknown): string[] => {
  if (filterMap === null || filterMap === undefined) return [];
  if (!isRecord(filterMap)) return ['Filter must be an object with a fields list.'];
  const fields = filterMap.fields;
  if (!Array.isArray(fields)) return ['Filter fields must be a list.'];
  if (fields.length === 0) return ['Filter fields must not be empty.'];
  if (fields.length > maxFields) return [`A filter takes at most ${maxFields} fields.`];
  return fields.flatMap(specErrors);
};

export const toSpec = (raw: Record<string, unknown>): FieldSpec => {
  const options = optionsOf(raw) ?? [];
  return {
    field: raw.field as string,
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    ...(typeof raw['value-type'] === 'string' ? { valueType: raw['value-type'] } : {}),
    selected: options.map(String),
  };
};

const clauseOf = (spec: FieldSpec): FilterClause => {
  const values =
    spec.valueType === 'integer' ? spec.selected.map(Number) : spec.selected.map(String);
  if (spec.type === 'contains') return { contains: values.map(String) };
  if (spec.type === 'not-in-set') return { not: values };
  return values;
};

export const toPortFilters = (specs: FieldSpec[]): Record<string, FilterValue> => {
  const byField = new Map<string, FilterClause[]>();
  for (const spec of specs) {
    if (spec.selected.length === 0) continue;
    byField.set(spec.field, [...(byField.get(spec.field) ?? []), clauseOf(spec)]);
  }
  return Object.fromEntries(
    [...byField].map(([field, clauses]) => [
      field,
      clauses.length === 1 ? (clauses[0] as FilterClause) : { all: clauses },
    ]),
  );
};

export type FacetRequest =
  { ok: true; fields: string[]; specs: FieldSpec[] } | { ok: false; error: string };

const maxFacetFields = 10;

export const facetRequest = (
  fieldsParam: string | undefined,
  filterParam: string | undefined,
): FacetRequest => {
  const fields = [
    ...new Set(
      (fieldsParam ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    ),
  ];
  let parsed: unknown;
  let invalidJson = false;
  if (filterParam !== undefined) {
    try {
      parsed = JSON.parse(filterParam) as unknown;
    } catch {
      invalidJson = true;
    }
  }
  if (fields.length === 0) return { ok: false, error: 'fields must name at least one field.' };
  if (fields.length > maxFacetFields)
    return { ok: false, error: `fields takes at most ${maxFacetFields} fields.` };
  if (!fields.every(isFieldName)) return { ok: false, error: 'fields must be plain field names.' };
  if (invalidJson) return { ok: false, error: 'filter must be JSON.' };
  if (parsed !== undefined && parsed !== null && !isRecord(parsed))
    return { ok: false, error: 'filter must be an object with a fields list.' };
  const errors = isRecord(parsed) ? filterMapErrors(parsed) : [];
  if (errors.length > 0) return { ok: false, error: `Invalid filter: ${errors.join(' ')}` };

  const selected = isRecord(parsed) ? (parsed.fields as Record<string, unknown>[]).map(toSpec) : [];
  const byField = new Map(selected.map((s) => [s.field, s]));
  const requested = fields.map((f) => byField.get(f) ?? { field: f, selected: [] });
  const constraints = selected.filter((s) => !fields.includes(s.field));
  return { ok: true, fields, specs: [...requested, ...constraints] };
};
