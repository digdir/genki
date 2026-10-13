import type { T } from '../../i18n';
import type { JsonSchema, KnowledgeEngine } from '../../types';

export type FieldKind = 'text' | 'url' | 'integer' | 'number' | 'boolean' | 'enum' | 'secret';

export interface FormField {
  key: string;
  id: string;
  title: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  schema: JsonSchema;
  options: { value: string; label: string }[];
  rule: (t: T) => string;
}

export type FormValues = Record<string, string | boolean>;

export const fieldId = (key: string) => `f-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export const formSchemaOf = (engine: KnowledgeEngine): JsonSchema =>
  engine.endpoint ??
  (engine.endpointOptions
    ? { type: 'object', properties: { options: engine.endpointOptions } }
    : { type: 'object', properties: {} });

const variantsOf = (p: JsonSchema) => {
  const list = p.oneOf ?? p.anyOf;
  return list?.length && list.every((v) => v.properties?.kind?.const !== undefined)
    ? list
    : undefined;
};

const kindOf = (p: JsonSchema): FieldKind => {
  if (p['x-secret']) return 'secret';
  if (p.enum) return 'enum';
  if (p.type === 'boolean') return 'boolean';
  if (p.type === 'integer') return 'integer';
  if (p.type === 'number') return 'number';
  if (p.format === 'uri') return 'url';
  return 'text';
};

const requiredText = (required: boolean, t: T) =>
  t(required ? 'searchEngines.ruleRequired' : 'searchEngines.ruleOptional');

const ruleOf = (p: JsonSchema, required: boolean) => (t: T) =>
  [
    `${p.type ?? 'string'}${p.format ? ` (${p.format})` : ''}`,
    requiredText(required, t),
    p.pattern ? t('searchEngines.rulePattern', { pattern: p.pattern }) : '',
    p.minimum !== undefined || p.maximum !== undefined
      ? `${p.minimum ?? ''}–${p.maximum ?? ''}`
      : '',
    p['x-secret'] ? t('searchEngines.ruleSecret') : '',
  ]
    .filter(Boolean)
    .join(' · ');

export const fieldsOf = (schema: JsonSchema, values: FormValues, prefix = ''): FormField[] =>
  Object.entries(schema.properties ?? {}).flatMap(([name, p]): FormField[] => {
    const key = `${prefix}${name}`;
    const required = (schema.required ?? []).includes(name);
    if (p.const !== undefined) return [];
    const variants = variantsOf(p);
    if (variants) {
      const kindKey = `${key}.kind`;
      const chosen =
        variants.find((v) => v.properties?.kind?.const === values[kindKey]) ?? variants[0];
      const options = variants.map((v) => {
        const value = String(v.properties?.kind?.const);
        return { value, label: v.title ?? value };
      });
      return [
        {
          key: kindKey,
          id: fieldId(kindKey),
          title: p.title ?? name,
          ...(p.description ? { description: p.description } : {}),
          kind: 'enum',
          required,
          schema: { type: 'string', enum: options.map((o) => o.value) },
          options,
          rule: (t) =>
            `string · ${requiredText(required, t)} · ${options.map((o) => o.value).join(' | ')}`,
        },
        ...(chosen ? fieldsOf(chosen, values, `${key}.`) : []),
      ];
    }
    if (p.type === 'object' && p.properties) return fieldsOf(p, values, `${key}.`);
    const kind = kindOf(p);
    return [
      {
        key,
        id: fieldId(key),
        title: p.title ?? name,
        ...(p.description ? { description: p.description } : {}),
        kind,
        required,
        schema: p,
        options:
          kind === 'enum'
            ? (p.enum ?? []).map((v, i) => ({
                value: String(v),
                label: p.enumTitles?.[i] ?? String(v),
              }))
            : [],
        rule: ruleOf(p, required),
      },
    ];
  });

const isEmpty = (v: string | boolean | undefined) =>
  v === undefined || (typeof v === 'string' && v.trim() === '');

export const validate = (fields: FormField[], values: FormValues, t: T) => {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === 'boolean') continue;
    if (isEmpty(v)) {
      if (f.required) errors[f.key] = t('searchEngines.errorRequired');
      continue;
    }
    const text = String(v).trim();
    const p = f.schema;
    if (f.kind === 'integer' || f.kind === 'number') {
      const n = Number(text.replace(/\s/g, '').replace(',', '.'));
      if (Number.isNaN(n) || (f.kind === 'integer' && !Number.isInteger(n)))
        errors[f.key] =
          f.kind === 'integer' ? t('searchEngines.errorInteger') : t('searchEngines.errorNumber');
      else if (
        (p.minimum !== undefined && n < p.minimum) ||
        (p.maximum !== undefined && n > p.maximum)
      )
        errors[f.key] = t('searchEngines.errorRange', {
          min: p.minimum ?? '–',
          max: p.maximum ?? '–',
        });
      continue;
    }
    if (f.kind === 'url' && !/^https:\/\/[^\s/$.?#][^\s]*$/.test(text)) {
      errors[f.key] = t('searchEngines.errorUrl');
      continue;
    }
    if (p.pattern && f.kind !== 'secret' && !new RegExp(p.pattern).test(text))
      errors[f.key] = t('searchEngines.errorPattern', { pattern: p.pattern });
  }
  return errors;
};

export const flatten = (value: unknown, prefix = '', out: FormValues = {}): FormValues => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (typeof value === 'boolean') out[prefix] = value;
  else if (value !== undefined && value !== null) out[prefix] = String(value);
  return out;
};

const defaultsOf = (fields: FormField[]) =>
  Object.fromEntries(
    fields.flatMap((f): [string, string | boolean][] => {
      if (f.schema.default !== undefined)
        return [
          [
            f.key,
            typeof f.schema.default === 'boolean' ? f.schema.default : String(f.schema.default),
          ],
        ];
      if (f.kind === 'boolean') return [[f.key, false]];
      if (f.key.endsWith('.kind') && f.options[0]) return [[f.key, f.options[0].value]];
      return [];
    }),
  );

export const initialValues = (engine: KnowledgeEngine, existing?: Record<string, unknown>) => {
  const schema = formSchemaOf(engine);
  const flat = flatten(existing ?? {});
  let values: FormValues = { ...defaultsOf(fieldsOf(schema, flat)), ...flat };
  values = { ...defaultsOf(fieldsOf(schema, values)), ...values };
  return values;
};

const setPath = (target: Record<string, unknown>, path: string[], value: unknown) => {
  const [head, ...rest] = path;
  if (!head) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const next = (target[head] as Record<string, unknown> | undefined) ?? {};
  target[head] = next;
  setPath(next, rest, value);
};

export const toSpec = (engine: KnowledgeEngine, fields: FormField[], values: FormValues) => {
  const spec: Record<string, unknown> = { engine: engine.engine };
  for (const f of fields) {
    const v = values[f.key];
    if (isEmpty(v)) continue;
    const value =
      f.kind === 'integer' || f.kind === 'number'
        ? Number(String(v).replace(/\s/g, '').replace(',', '.'))
        : f.kind === 'boolean'
          ? v === true
          : String(v).trim();
    setPath(spec, f.key.split('.'), value);
  }
  return spec;
};
