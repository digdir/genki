import type { InputFieldSpec, InputKind } from './service-definition';
import { datasetRef } from './service-form';

export type { InputKind };

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface InputFormField {
  id: string;
  label: string;
  kind: InputKind;
  required: boolean;
  help: string;
  options: string;
  optionsFrom: {
    dataset: string;
    facet: string;
    min?: number;
    max?: number;
    pattern?: string;
  } | null;
  default?: string;
  dependsOn?: string;
}

export const inputKinds: [InputKind, string][] = [
  ['text', 'Kort tekst'],
  ['long-text', 'Lang tekst'],
  ['choice', 'Ett valg'],
  ['multi-choice', 'Flere valg'],
  ['organisation', 'Virksomhet'],
  ['number', 'Tall'],
  ['year', 'År'],
  ['date', 'Dato'],
];

export const takesOptions = (kind: InputKind) =>
  kind === 'choice' || kind === 'multi-choice' || kind === 'organisation';

export const takesOptionsFrom = (kind: InputKind) => takesOptions(kind) || kind === 'year';

const reservedInputIds = new Set([
  'query',
  'text',
  'history',
  'parts',
  'messages',
  'conversation_id',
  'overrides',
  'tenant',
  'dataset_config_key',
  'model',
  'temperature',
  'claim',
  'input',
]);

export const inputFieldId = (label: string, taken: string[]) => {
  const ascii = label
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 48);
  const base = ascii && !reservedInputIds.has(ascii) ? ascii : 'felt';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
};

export const fieldIds = (fields: InputFormField[]) => {
  const taken: string[] = [];
  return fields.map((f) => {
    const id = f.id || inputFieldId(f.label, taken);
    taken.push(id);
    return id;
  });
};

export const optionLines = (options: string) => [
  ...new Set(
    options
      .split('\n')
      .map((o) => o.trim())
      .filter(Boolean),
  ),
];

const defaultValue = (kind: InputKind, value: string) =>
  kind === 'year' || kind === 'number'
    ? Number(value)
    : kind === 'multi-choice'
      ? optionLines(value.replace(/,\s*/g, '\n'))
      : value;

export const inputFieldsOf = (fields: InputFormField[], tenant: string): InputFieldSpec[] => {
  const ids = fieldIds(fields);
  return fields.map((f, i) => {
    const id = ids[i] as string;
    const options = optionLines(f.options);
    const fallback = f.default?.trim() ?? '';
    return {
      id,
      label: f.label.trim() || id,
      kind: f.kind,
      required: f.required,
      ...(f.help.trim() ? { help: f.help.trim() } : {}),
      ...(fallback ? { default: defaultValue(f.kind, fallback) } : {}),
      ...(f.dependsOn ? { dependsOn: f.dependsOn } : {}),
      ...(takesOptionsFrom(f.kind) && f.optionsFrom
        ? {
            optionsFrom: {
              ...f.optionsFrom,
              dataset: datasetRef(f.optionsFrom.dataset, tenant),
              facet: f.optionsFrom.facet.trim(),
            },
          }
        : takesOptions(f.kind) && options.length
          ? { options }
          : {}),
    };
  });
};

const inputKindIds = new Set<string>(inputKinds.map(([id]) => id));

export const inputFieldsFrom = (input: Record<string, unknown>): InputFormField[] =>
  (Array.isArray(input.fields) ? input.fields : []).map(asRecord).map((f) => {
    const from = asRecord(f.optionsFrom);
    return {
      id: typeof f.id === 'string' ? f.id : '',
      label: typeof f.label === 'string' ? f.label : '',
      kind: inputKindIds.has(String(f.kind)) ? (f.kind as InputKind) : 'text',
      required: f.required === true,
      help: typeof f.help === 'string' ? f.help : '',
      options: Array.isArray(f.options) ? f.options.map(String).join('\n') : '',
      ...(f.default !== undefined
        ? { default: Array.isArray(f.default) ? f.default.join(', ') : String(f.default) }
        : {}),
      ...(typeof f.dependsOn === 'string' ? { dependsOn: f.dependsOn } : {}),
      optionsFrom:
        typeof from.dataset === 'string' && typeof from.facet === 'string'
          ? {
              dataset: from.dataset,
              facet: from.facet,
              ...(typeof from.min === 'number' ? { min: from.min } : {}),
              ...(typeof from.max === 'number' ? { max: from.max } : {}),
              ...(typeof from.pattern === 'string' ? { pattern: from.pattern } : {}),
            }
          : null,
    };
  });
