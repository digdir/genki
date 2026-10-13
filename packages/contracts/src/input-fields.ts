export const inputFieldKinds = [
  'text',
  'long-text',
  'choice',
  'multi-choice',
  'number',
  'year',
  'date',
  'organisation',
] as const;

export type InputFieldKind = (typeof inputFieldKinds)[number];

export interface InputField {
  id: string;
  label: string;
  kind: InputFieldKind;
  required?: boolean | undefined;
  help?: string | undefined;
  options?: string[] | undefined;
  optionsFrom?:
    | {
        dataset: string;
        facet: string;
        min?: number | undefined;
        max?: number | undefined;
        pattern?: string | undefined;
      }
    | undefined;
  default?: InputValue | undefined;
  dependsOn?: string | undefined;
}

export type InputValue = string | number | string[];

export interface InputFieldError {
  path: string;
  message: string;
}

export type CheckedInput =
  { ok: true; values: Record<string, InputValue> } | { ok: false; errors: InputFieldError[] };

export const inputFieldId = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export const reservedInputFieldIds = [
  'query',
  'user-query',
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
] as const;

export const textLimits = { text: 2000, 'long-text': 20000 } as const;

const choices = (field: InputField) => (field.options?.length ? field.options : undefined);

const fieldSchema = (field: InputField): Record<string, unknown> => {
  const about = {
    title: field.label,
    ...(field.help ? { description: field.help } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
  };
  const options = choices(field);
  switch (field.kind) {
    case 'text':
    case 'long-text':
      return { ...about, type: 'string', minLength: 1, maxLength: textLimits[field.kind] };
    case 'choice':
    case 'organisation':
      return { ...about, type: 'string', minLength: 1, ...(options ? { enum: options } : {}) };
    case 'multi-choice':
      return {
        ...about,
        type: 'array',
        items: { type: 'string', ...(options ? { enum: options } : {}) },
        uniqueItems: true,
      };
    case 'number':
      return { ...about, type: 'number' };
    case 'year':
      return { ...about, type: 'integer', minimum: 1800, maximum: 2200 };
    case 'date':
      return { ...about, type: 'string', format: 'date' };
  }
};

export const inputFieldsSchema = (fields: InputField[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    ...Object.fromEntries(fields.map((f) => [f.id, fieldSchema(f)])),
    query: { type: 'string', description: 'An optional free-text question or remark.' },
  },
  required: fields.filter((f) => f.required).map((f) => f.id),
});

const listed = (options: string[]) =>
  options.length > 8 ? `${options.slice(0, 8).join(', ')} …` : options.join(', ');

const blank = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const numeric = (value: unknown) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : undefined;

const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

type Checked = { value: InputValue } | { error: string };

const checkValue = (field: InputField, value: unknown): Checked => {
  const name = `«${field.label}»`;
  const fail = (error: string): Checked => ({ error });
  const ok = (v: InputValue): Checked => ({ value: v });
  const options = choices(field);
  switch (field.kind) {
    case 'text':
    case 'long-text': {
      if (typeof value !== 'string') return fail(`${name} må være tekst.`);
      const limit = textLimits[field.kind];
      return value.length > limit
        ? fail(`${name} kan være høyst ${limit} tegn.`)
        : ok(value.trim());
    }
    case 'choice':
    case 'organisation': {
      if (typeof value !== 'string') return fail(`${name} må være tekst.`);
      return options && !options.includes(value)
        ? fail(`${name} må være ett av valgene: ${listed(options)}.`)
        : ok(value.trim());
    }
    case 'multi-choice': {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string'))
        return fail(`${name} må være en liste med valg.`);
      const wrong = options ? list.filter((v) => !options.includes(v as string)) : [];
      return wrong.length > 0
        ? fail(
            `${name} har ukjente valg: ${wrong.join(', ')}. Gyldige valg: ${listed(options ?? [])}.`,
          )
        : ok([...new Set(list as string[])]);
    }
    case 'number': {
      const n = numeric(value);
      return n === undefined || !Number.isFinite(n) ? fail(`${name} må være et tall.`) : ok(n);
    }
    case 'year': {
      const n = numeric(value);
      return n === undefined || !Number.isInteger(n) || n < 1800 || n > 2200
        ? fail(`${name} må være et årstall, for eksempel 2025.`)
        : ok(n);
    }
    case 'date':
      return typeof value === 'string' && validDate(value.trim())
        ? ok(value.trim())
        : fail(`${name} må være en dato på formen ÅÅÅÅ-MM-DD.`);
  }
};

export const checkInputFields = (
  fields: InputField[],
  args: Record<string, unknown>,
): CheckedInput => {
  const values: Record<string, InputValue> = {};
  const errors: InputFieldError[] = [];
  for (const field of fields) {
    const given = args[field.id];
    const raw = blank(given) && field.default !== undefined ? field.default : given;
    if (blank(raw)) {
      if (field.required)
        errors.push({ path: field.id, message: `«${field.label}» må fylles ut.` });
      continue;
    }
    const checked = checkValue(field, raw);
    if ('error' in checked) errors.push({ path: field.id, message: checked.error });
    else values[field.id] = checked.value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
};

const shown = (value: InputValue) => (Array.isArray(value) ? value.join(', ') : String(value));

export const renderInputFields = (fields: InputField[], values: Record<string, InputValue>) =>
  fields
    .filter((f) => values[f.id] !== undefined)
    .map((f) => `${f.label}: ${shown(values[f.id] as InputValue)}`)
    .join('\n');

export const fieldsQuery = (
  fields: InputField[],
  values: Record<string, InputValue>,
  question: string | undefined,
) => {
  const lines = renderInputFields(fields, values);
  const asked = question?.trim() ?? '';
  return [lines, asked].filter((s) => s !== '').join('\n\n');
};

export const isPlausibleYear = (value: string, now: Date = new Date()) =>
  /^\d{4}$/.test(value) && Number(value) >= 1900 && Number(value) <= now.getFullYear() + 1;

export const plausibleYears = <V extends { value: string }>(values: V[], now: Date = new Date()) =>
  values
    .filter((v) => isPlausibleYear(v.value, now))
    .sort((a, b) => Number(b.value) - Number(a.value));
