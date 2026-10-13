import {
  annotateSchema,
  inputFieldsSchema,
  type InputField,
  type PropertyMeta,
  type SchemaLabels,
  type UiText,
} from '@genai/contracts';
import type { ServiceDefinition } from '@genai/definitions';

type Json = Record<string, unknown>;

export type ServiceOutput = ServiceDefinition['spec']['output'];

export interface ServiceSchemaSource {
  id: string;
  title?: string | undefined;
  labels?: { nb: string; en: string } | undefined;
  datasets?: unknown[] | undefined;
  description?: string | undefined;
  inputFields?: InputField[] | undefined;
  output?: ServiceOutput | undefined;
}

const same = (text: string): UiText => ({ nb: text, en: text });

type Text = { label: string; help?: string } | { nb: string; en: string };

const catalogue = (entries: [string, Text, PropertyMeta][]) => {
  const labels: SchemaLabels = { nb: {}, en: {}, meta: {} };
  for (const [key, text, meta] of entries) {
    const one = 'label' in text;
    const help = one && text.help ? { help: text.help } : {};
    labels.nb[key] = { label: one ? text.label : text.nb, ...help };
    labels.en[key] = { label: one ? text.label : text.en, ...help };
    (labels.meta as Record<string, PropertyMeta>)[key] = meta;
  }
  return labels;
};

const fieldMeta = (field: InputField, order: number): PropertyMeta => ({
  'x-order': order,
  ...(field.kind === 'long-text' ? { 'x-widget': 'textarea' as const } : {}),
  ...(field.options?.length && (field.kind === 'choice' || field.kind === 'organisation')
    ? { 'x-widget': 'select' as const, 'x-options': { enum: field.options } }
    : {}),
  ...(field.options?.length && field.kind === 'multi-choice'
    ? { 'x-widget': 'multiselect' as const, 'x-options': { enum: field.options } }
    : {}),
});

const inputOf = (fields: InputField[]): Json => {
  const properties = {
    ...(inputFieldsSchema(fields) as { properties: Record<string, Json> }).properties,
  };
  delete properties.query;
  const required = fields.filter((f) => f.required).map((f) => f.id);
  const schema = {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    'x-label': { nb: 'Skjema', en: 'Form' },
  };
  return annotateSchema(schema, [
    catalogue(
      fields.map((f, i) => [
        f.id,
        { label: f.label, ...(f.help ? { help: f.help } : {}) },
        fieldMeta(f, i),
      ]),
    ),
  ]);
};

const columnSchema = (column: NonNullable<ServiceOutput['columns']>[number]): Json => ({
  type: 'object',
  required: ['value'],
  properties: {
    value:
      column.type === 'number'
        ? { type: ['number', 'null'] }
        : {
            type: ['string', 'null'],
            ...(column.type === 'enum' && column.values ? { enum: [...column.values, null] } : {}),
          },
    sources: { type: 'array', items: { type: 'object' } },
  },
});

const fieldType = (type: 'string' | 'number' | 'boolean' | 'date' | 'list'): Json =>
  type === 'list'
    ? { type: 'array', items: { type: 'string' } }
    : type === 'date'
      ? { type: 'string', format: 'date' }
      : { type };

const outputOf = (output: ServiceOutput | undefined): Json => {
  const kind = output?.kind ?? 'answer';
  if (kind === 'fields') {
    const fields = output?.fields ?? [];
    const labels = catalogue(
      fields.map((f, i) => [
        f.name,
        { label: f.label ?? f.name, help: f.description },
        { 'x-order': i },
      ]),
    );
    return annotateSchema(
      {
        type: 'object',
        properties: Object.fromEntries(
          fields.map((f) => [
            f.name,
            f.required === false
              ? { anyOf: [fieldType(f.type), { type: 'null' }] }
              : fieldType(f.type),
          ]),
        ),
        required: fields.filter((f) => f.required !== false).map((f) => f.name),
        'x-kind': 'fields',
        'x-carriedIn': 'choices[0].message.content (as JSON text)',
        'x-label': { nb: 'Resultat', en: 'Result' },
      },
      [labels],
    );
  }
  if (kind === 'table') {
    const columns = output?.columns ?? [];
    const labels = catalogue(
      columns.map((c, i) => [
        `rows.cells.${c.key}`,
        { label: c.name, ...(c.description ? { help: c.description } : {}) },
        { 'x-order': i },
      ]),
    );
    return annotateSchema(
      {
        type: 'object',
        required: ['columns', 'rows'],
        properties: {
          columns: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'label'],
              properties: { key: { type: 'string' }, label: { type: 'string' } },
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['cells'],
              properties: {
                document: { type: 'string' },
                cells: {
                  type: 'object',
                  properties: Object.fromEntries(columns.map((c) => [c.key, columnSchema(c)])),
                },
              },
            },
          },
        },
        'x-kind': 'table',
        'x-carriedIn': 'table',
        'x-label': { nb: 'Tabell', en: 'Table' },
      },
      [
        labels,
        catalogue([
          ['columns', { nb: 'Kolonner', en: 'Columns' }, {}],
          ['columns.key', { nb: 'Nøkkel', en: 'Key' }, {}],
          ['columns.label', { nb: 'Navn', en: 'Name' }, {}],
          ['rows', { nb: 'Rader', en: 'Rows' }, {}],
          ['document', { nb: 'Dokument', en: 'Document' }, {}],
          ['cells', { nb: 'Celler', en: 'Cells' }, {}],
          ['value', { nb: 'Verdi', en: 'Value' }, {}],
          ['sources', { nb: 'Kilder', en: 'Sources' }, {}],
        ]),
      ],
    );
  }
  return {
    type: 'string',
    'x-kind': kind,
    'x-carriedIn': 'choices[0].message.content',
    'x-label':
      kind === 'document' ? { nb: 'Dokument', en: 'Document' } : { nb: 'Svar', en: 'Answer' },
  };
};

export const serviceSchemaOf = (source: ServiceSchemaSource): Json => ({
  id: source.id,
  ...(source.title ? { title: source.title } : {}),
  ...(source.description ? { description: source.description } : {}),
  'x-label': source.labels ?? same(source.title ?? source.id),
  ...(source.datasets?.length ? { datasets: source.datasets } : {}),
  input: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...(source.inputFields?.length ? inputOf(source.inputFields) : emptyInput),
  },
  output: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...outputOf(source.output),
  },
});

const emptyInput: Json = {
  type: 'object',
  properties: {},
  'x-label': { nb: 'Skjema', en: 'Form' },
};
