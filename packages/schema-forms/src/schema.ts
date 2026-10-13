import type { Locale } from '@genai/i18n';

export type Text = string | Partial<Record<Locale, string>>;

export const widgets = [
  'text',
  'textarea',
  'prompt',
  'number',
  'toggle',
  'select',
  'multiselect',
  'model',
  'dataset',
  'tool',
  'secret',
  'cron',
  'code',
  'list',
  'map',
] as const;
export type Widget = (typeof widgets)[number];

export const isWidget = (value: unknown): value is Widget =>
  typeof value === 'string' && (widgets as readonly string[]).includes(value);

export interface OptionsRoute {
  route: string;
  value?: string;
  label?: string;
  items?: string;
}

export interface OptionItem {
  value: string;
  label: Text;
}

export type OptionsSource = string | OptionsRoute | { enum: readonly unknown[] } | OptionItem[];

export type Condition =
  | { field: string; equals?: unknown; notEquals?: unknown; in?: unknown[]; truthy?: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | Record<string, unknown>;

export interface UiSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, UiSchema>;
  required?: string[];
  items?: UiSchema;
  additionalProperties?: boolean | UiSchema;
  enum?: readonly unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  anyOf?: UiSchema[];
  oneOf?: UiSchema[];
  enumTitles?: string[];
  'x-label'?: Text;
  'x-help'?: Text;
  'x-group'?: Text;
  'x-order'?: number;
  'x-widget'?: string;
  'x-options'?: OptionsSource;
  'x-enumLabels'?: Record<string, Text>;
  'x-right'?: string;
  'x-operator'?: boolean;
  'x-settableAt'?: string[];
  'x-readOnly'?: boolean;
  'x-advanced'?: boolean;
  'x-showIf'?: Condition;
  'x-sensitive'?: boolean;
  'x-unit'?: Text;
  [key: string]: unknown;
}

export interface SchemaUse {
  at: string;
  href: string;
  kind?: string;
  version?: string;
  when?: { field: string; equals?: unknown; in?: unknown[] };
  title?: Text;
}

export interface SchemaRef {
  kind: string;
  version: string;
  label?: Text;
  help?: Text;
  href?: string;
  uses?: SchemaUse[];
}

export const resolveText = (text: Text | undefined, locale: Locale): string | undefined => {
  if (text === undefined) return undefined;
  if (typeof text === 'string') return text;
  return text[locale] ?? text.nb ?? Object.values(text).find(Boolean);
};

export type Value = Record<string, unknown>;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const getAt = (value: unknown, path: string): unknown =>
  path === ''
    ? value
    : path
        .split('.')
        .reduce<unknown>(
          (at, key) => (isRecord(at) ? at[key] : Array.isArray(at) ? at[Number(key)] : undefined),
          value,
        );

const isEmptyValue = (v: unknown) =>
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isRecord(v) && Object.keys(v).length === 0);

const omit = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

export const setAt = (value: Value, path: string, next: unknown): Value => {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '') return value;
  if (rest.length === 0) return next === undefined ? omit(value, head) : { ...value, [head]: next };
  const current = value[head];
  const child = setAt(isRecord(current) ? current : {}, rest.join('.'), next);
  return isEmptyValue(child) ? omit(value, head) : { ...value, [head]: child };
};

export const nonNull = (schema: UiSchema): UiSchema => {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return schema;
  const real = variants.filter((v) => v.type !== 'null');
  if (real.length !== 1 || !real[0]) return schema;
  const own: UiSchema = { ...schema };
  delete own.anyOf;
  delete own.oneOf;
  return { ...real[0], ...own };
};

export const typeOf = (schema: UiSchema): string | undefined => {
  const s = nonNull(schema);
  if (typeof s.type === 'string') return s.type;
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null');
  if (s.properties) return 'object';
  if (s.enum) return 'string';
  return undefined;
};

export const widgetOf = (schema: UiSchema): Widget => {
  const s = nonNull(schema);
  const hint = s['x-widget'];
  if (isWidget(hint)) return hint;
  if (s['x-sensitive']) return 'secret';
  const type = typeOf(s);
  if (s.enum || (s['x-options'] && type !== 'array')) return 'select';
  if (type === 'boolean') return 'toggle';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array') {
    const items = s.items ? nonNull(s.items) : undefined;
    if (items?.enum || s['x-options']) return 'multiselect';
    return 'list';
  }
  if (type === 'object') {
    const values = isRecord(s.additionalProperties) ? s.additionalProperties : undefined;
    const simple =
      values && ['string', 'number', 'integer', 'boolean'].includes(typeOf(values) ?? '');
    return simple && !s.properties ? 'map' : 'code';
  }
  if (type === 'string') return 'text';
  return 'code';
};

export const isGroup = (schema: UiSchema) => {
  const s = nonNull(schema);
  return typeOf(s) === 'object' && !!s.properties && !isWidget(s['x-widget']);
};

const conditionHolds = (condition: Condition, read: (field: string) => unknown): boolean => {
  if ('all' in condition && Array.isArray(condition.all))
    return (condition.all as Condition[]).every((c) => conditionHolds(c, read));
  if ('any' in condition && Array.isArray(condition.any))
    return (condition.any as Condition[]).some((c) => conditionHolds(c, read));
  if ('field' in condition && typeof condition.field === 'string') {
    const v = read(condition.field);
    if ('equals' in condition) return v === condition.equals;
    if ('notEquals' in condition) return v !== condition.notEquals;
    if ('in' in condition && Array.isArray(condition.in)) return condition.in.includes(v);
    if ('truthy' in condition) return Boolean(v) === condition.truthy;
    return Boolean(v);
  }
  return Object.entries(condition).every(([field, expected]) => {
    const v = read(field);
    return Array.isArray(expected) ? expected.includes(v) : v === expected;
  });
};

export const shown = (schema: UiSchema, root: unknown, parentPath: string) => {
  const condition = schema['x-showIf'];
  if (!condition || !isRecord(condition)) return true;
  const read = (field: string) => {
    const sibling = parentPath ? `${parentPath}.${field}` : field;
    const near = getAt(root, sibling);
    return near === undefined ? getAt(root, field) : near;
  };
  return conditionHolds(condition, read);
};

export interface FieldNode {
  path: string;
  name: string;
  schema: UiSchema;
  required: boolean;
  order: number;
  group: Text | undefined;
}

export const childrenOf = (schema: UiSchema, parentPath = ''): FieldNode[] => {
  const s = nonNull(schema);
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {})
    .filter(([, p]) => p.const === undefined)
    .map(([name, p], index) => ({
      path: parentPath ? `${parentPath}.${name}` : name,
      name,
      schema: p,
      required: required.has(name),
      order: typeof p['x-order'] === 'number' ? p['x-order'] : 1000 + index,
      group: p['x-group'],
    }))
    .sort((a, b) => a.order - b.order);
};

export interface Section {
  key: string;
  label: Text | undefined;
  fields: FieldNode[];
}

const groupKey = (group: Text | undefined) =>
  group === undefined ? '' : typeof group === 'string' ? group : JSON.stringify(group);

export const sectionsOf = (fields: FieldNode[]): Section[] => {
  const sections: Section[] = [];
  for (const field of fields) {
    const key = groupKey(field.group);
    const found = sections.find((s) => s.key === key);
    if (found) found.fields.push(field);
    else sections.push({ key, label: field.group, fields: [field] });
  }
  return sections.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : 0));
};

export const labelOf = (field: FieldNode, locale: Locale) =>
  resolveText(field.schema['x-label'], locale) ?? field.schema.title ?? field.name;

export const helpOf = (schema: UiSchema, locale: Locale) =>
  resolveText(schema['x-help'], locale) ?? schema.description;

export const defaultsOf = (schema: UiSchema): Value => {
  let out: Value = {};
  const walk = (s: UiSchema, path: string) => {
    for (const field of childrenOf(s, path)) {
      const own = nonNull(field.schema);
      if (own.default !== undefined && !own['x-sensitive'])
        out = setAt(out, field.path, structuredClone(own.default));
      else if (isGroup(own)) walk(own, field.path);
    }
  };
  walk(schema, '');
  return out;
};

export interface Variants {
  discriminator: string;
  options: { value: string; schema: UiSchema }[];
}

export const variantsOf = (schema: UiSchema): Variants | undefined => {
  const list = (schema.oneOf ?? schema.anyOf)?.filter((v) => v.type !== 'null');
  if (!list || list.length < 2 || !list.every((v) => isRecord(v.properties))) return undefined;
  const first = list[0]?.properties ?? {};
  const discriminator = Object.keys(first).find((key) =>
    list.every((v) => v.properties?.[key]?.const !== undefined),
  );
  if (!discriminator) return undefined;
  return {
    discriminator,
    options: list.map((v) => ({ value: String(v.properties?.[discriminator]?.const), schema: v })),
  };
};

export const chosenVariant = (variants: Variants, value: unknown) => {
  const picked = isRecord(value) ? value[variants.discriminator] : undefined;
  return variants.options.find((o) => o.value === picked);
};

export const withoutProperty = (schema: UiSchema, name: string): UiSchema => {
  const properties = omit(schema.properties ?? {}, name);
  return { ...schema, properties, required: (schema.required ?? []).filter((r) => r !== name) };
};

export const discriminatorField = (variants: Variants): UiSchema => {
  const first = variants.options[0]?.schema.properties?.[variants.discriminator] ?? {};
  const labels: Record<string, Text> = {};
  for (const o of variants.options) {
    const own = o.schema.properties?.[variants.discriminator];
    const named = own?.['x-enumLabels']?.[o.value] ?? o.schema['x-label'] ?? o.schema.title;
    if (named !== undefined) labels[o.value] = named;
  }
  const field: UiSchema = {
    ...first,
    type: 'string',
    enum: variants.options.map((o) => o.value),
    'x-widget': 'select',
    'x-enumLabels': labels,
  };
  delete field.const;
  return field;
};
