import type { UiSchema } from '@genai/schema-forms';
import type { Locale, T } from '../i18n';
import type { BlockDef, ParamDef, ParamType } from './stepflows';

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  [key: string]: unknown;
};

export interface StepBlockSchema {
  ref: string;
  name: string;
  version: string;
  description: string;
  title: { nb: string; en: string };
  summary: { nb: string; en: string };
  input: JsonSchema;
  params: JsonSchema;
  output: JsonSchema;
}

const blockIcons: Record<string, string> = {
  model: 'Sm',
  extract: 'F',
  classify: 'K',
  retrieve: 'S',
  rerank: 'R',
  synthesize: 'Sv',
  'evidence-gate': '?',
  'overview-finalize': 'O',
  answer: 'Sv',
  template: 'Tk',
  route: 'Kø',
  approval: 'M',
  agent: 'Ag',
  documents: 'D',
  'read-document': 'Ld',
  tool: 'V',
  table: 'T',
};

const typeNames: Record<string, string> = {
  string: 'tekst',
  integer: 'tall',
  number: 'tall',
  boolean: 'ja/nei',
  array: 'liste',
  object: 'objekt',
};

const typeOf = (schema: JsonSchema | undefined): string => {
  if (!schema) return '';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== 'null') ?? '';
  const first = schema.anyOf?.map(typeOf).find((t) => t && t !== 'null');
  return first ?? '';
};

const typeName = (schema: JsonSchema | undefined) => {
  const types = schema?.anyOf
    ? schema.anyOf.map(typeOf).filter((t) => t !== 'null')
    : [typeOf(schema)];
  return [...new Set(types.map((t) => typeNames[t] ?? 'verdi'))].join(' eller ') || 'verdi';
};

const bound = (n: number | undefined) => (n === undefined || Math.abs(n) > 1e9 ? undefined : n);

const isColumns = (schema: JsonSchema) => {
  const item = schema.items?.properties;
  return typeOf(schema) === 'array' && !!item && ['key', 'label', 'from'].every((k) => k in item);
};

const paramType = (schema: JsonSchema): ParamType => {
  if (Array.isArray(schema.enum)) return 'enum';
  const type = typeOf(schema);
  if (type === 'integer') return 'int';
  if (type === 'number') return 'float';
  if (type === 'boolean') return 'bool';
  if (type === 'string') return 'text';
  if (isColumns(schema)) return 'columns';
  if (type === 'array' && typeOf(schema.items) === 'string') return 'list';
  return 'json';
};

const defaultText = (value: unknown) =>
  value === undefined
    ? undefined
    : `Standard: ${typeof value === 'boolean' ? (value ? 'ja' : 'nei') : typeof value === 'string' ? value : JSON.stringify(value)}.`;

const paramFrom = (
  name: string,
  schema: JsonSchema,
  required: boolean,
  label: string,
): ParamDef => {
  const type = paramType(schema);
  const min =
    schema.minimum ??
    (schema.exclusiveMinimum === undefined
      ? undefined
      : schema.exclusiveMinimum + (type === 'int' ? 1 : 0));
  const help = defaultText(schema.default);
  return {
    name,
    type,
    label,
    ...(bound(min) === undefined ? {} : { min: bound(min) as number }),
    ...(bound(schema.maximum) === undefined ? {} : { max: bound(schema.maximum) as number }),
    ...(type === 'float' ? { step: 0.05 } : {}),
    ...(type === 'enum' ? { options: (schema.enum ?? []).map(String) } : {}),
    ...(required ? { required: true } : {}),
    ...(help ? { help } : {}),
  };
};

const labelOf = (schema: JsonSchema, locale: Locale, fallback: string) => {
  const label = schema['x-label'];
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object') return (label as Record<Locale, string>)[locale];
  return fallback;
};

export const blockDefFromSchema = (s: StepBlockSchema, t?: T): BlockDef => {
  const locale: Locale = t?.locale ?? 'nb';
  const required = new Set(s.input.required ?? []);
  const requiredParams = new Set(s.params.required ?? []);
  const outputs = Object.entries(s.output.properties ?? {}).map(
    ([name, schema]): [string, string] => [name, typeName(schema)],
  );
  return {
    name: s.title[locale],
    desc: s.summary[locale],
    icon: blockIcons[s.name] ?? s.name.slice(0, 2).toUpperCase(),
    version: s.version,
    inputs: Object.entries(s.input.properties ?? {}).map(([name, schema]) => [
      name,
      typeName(schema),
      required.has(name),
    ]),
    outputs: outputs.length > 0 ? outputs : [['', 'resultat']],
    params: Object.entries(s.params.properties ?? {}).map(([name, schema]) =>
      paramFrom(name, schema, requiredParams.has(name), labelOf(schema, locale, name)),
    ),
    paramsSchema: s.params as UiSchema,
    schemaRef: `/schemas/${encodeURIComponent(`Block.${s.name}@${s.version}`)}`,
  };
};
