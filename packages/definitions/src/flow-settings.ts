import { z } from 'zod';

const text = z.strictObject({ nb: z.string().trim().min(1), en: z.string().trim().min(1) });
const scalar = z.union([z.string(), z.number()]);

export const flowSettingName = /^[a-z][A-Za-z0-9_]{0,62}$/;

export const flowSettingWidgets = [
  'text',
  'textarea',
  'number',
  'toggle',
  'select',
  'multiselect',
  'list',
] as const;

const optionsRoute = z.strictObject({
  route: z.string().startsWith('/'),
  value: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  items: z.string().min(1).optional(),
});

const settingProperty = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  'x-label': text,
  'x-help': text.optional(),
  'x-widget': z.enum(flowSettingWidgets).optional(),
  'x-options': z
    .union([
      optionsRoute,
      z.array(z.strictObject({ value: z.string().min(1), label: text })).min(1),
    ])
    .optional(),
  'x-enumLabels': z.record(z.string(), text).optional(),
  'x-order': z.number().optional(),
  'x-advanced': z.boolean().optional(),
  enum: z.array(scalar).min(1).optional(),
  items: z
    .strictObject({
      type: z.enum(['string', 'number', 'integer']),
      enum: z.array(scalar).min(1).optional(),
    })
    .optional(),
  default: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().positive().optional(),
  maxLength: z.number().int().positive().optional(),
});

export type FlowSettingProperty = z.output<typeof settingProperty>;

export const flowSettingsSchema = z
  .strictObject({
    type: z.literal('object'),
    properties: z.record(
      z
        .string()
        .regex(flowSettingName, 'must start with a lowercase letter, then letters or digits'),
      settingProperty,
    ),
    required: z.array(z.string()).default([]),
  })
  .superRefine((schema, ctx) => {
    schema.required.forEach((name, i) => {
      if (!(name in schema.properties))
        ctx.addIssue({
          code: 'custom',
          path: ['required', i],
          message: `${name} is required but not declared`,
        });
    });
    for (const [name, property] of Object.entries(schema.properties)) {
      if (property.type === 'array' && !property.items)
        ctx.addIssue({
          code: 'custom',
          path: ['properties', name, 'items'],
          message: 'a list setting needs items',
        });
      if (property.default === undefined) continue;
      for (const problem of checkValue(name, property, property.default))
        ctx.addIssue({
          code: 'custom',
          path: ['properties', name, 'default'],
          message: problem.message,
        });
    }
  });

export type FlowSettingsSchema = z.output<typeof flowSettingsSchema>;

export interface FlowSettingProblem {
  path: string;
  message: string;
}

const typeOk = (type: string, value: unknown) =>
  type === 'string'
    ? typeof value === 'string'
    : type === 'boolean'
      ? typeof value === 'boolean'
      : type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : Array.isArray(value);

const allowedValues = (property: FlowSettingProperty): unknown[] | undefined => {
  const options = property['x-options'];
  if (Array.isArray(options)) return options.map((o) => o.value);
  return property.type === 'array' ? property.items?.enum : property.enum;
};

const checkValue = (
  name: string,
  property: FlowSettingProperty,
  value: unknown,
): FlowSettingProblem[] => {
  const problem = (message: string) => [{ path: name, message }];
  if (!typeOk(property.type, value)) return problem(`${name} must be ${property.type}`);
  const allowed = allowedValues(property);
  if (property.type === 'array') {
    const list = value as unknown[];
    const itemType = property.items?.type ?? 'string';
    if (list.some((v) => !typeOk(itemType, v)))
      return problem(`${name} must be a list of ${itemType}`);
    if (allowed && list.some((v) => !allowed.includes(v)))
      return problem(`${name} has a value that is not one of ${allowed.join(', ')}`);
    if (property.minItems !== undefined && list.length < property.minItems)
      return problem(`${name} needs at least ${property.minItems} values`);
    if (property.maxItems !== undefined && list.length > property.maxItems)
      return problem(`${name} takes at most ${property.maxItems} values`);
    if (new Set(list).size !== list.length) return problem(`${name} lists a value twice`);
    return [];
  }
  if (allowed && !allowed.includes(value))
    return problem(`${name} must be one of ${allowed.join(', ')}`);
  if (typeof value === 'number') {
    if (property.minimum !== undefined && value < property.minimum)
      return problem(`${name} must be at least ${property.minimum}`);
    if (property.maximum !== undefined && value > property.maximum)
      return problem(`${name} must be at most ${property.maximum}`);
  }
  if (
    typeof value === 'string' &&
    property.maxLength !== undefined &&
    value.length > property.maxLength
  )
    return problem(`${name} must be at most ${property.maxLength} characters`);
  return [];
};

export const checkFlowSettings = (
  schema: FlowSettingsSchema | undefined,
  values: unknown,
): FlowSettingProblem[] => {
  if (
    values !== undefined &&
    (typeof values !== 'object' || values === null || Array.isArray(values))
  )
    return [{ path: '', message: 'settings must be an object' }];
  const given = (values ?? {}) as Record<string, unknown>;
  if (!schema)
    return Object.keys(given).map((name) => ({
      path: name,
      message: `${name} is not a setting of this step flow; it has no settings`,
    }));
  const problems: FlowSettingProblem[] = [];
  for (const name of Object.keys(given))
    if (!(name in schema.properties))
      problems.push({ path: name, message: `${name} is not a setting of this step flow` });
  for (const name of schema.required)
    if (given[name] === undefined && schema.properties[name]?.default === undefined)
      problems.push({ path: name, message: `${name} is required` });
  for (const [name, property] of Object.entries(schema.properties))
    if (given[name] !== undefined) problems.push(...checkValue(name, property, given[name]));
  return problems;
};

export const flowSettingsWithDefaults = (
  schema: FlowSettingsSchema | undefined,
  values: Record<string, unknown> | undefined,
): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(schema?.properties ?? {})
      .filter(([, p]) => p.default !== undefined)
      .map(([name, p]) => [name, structuredClone(p.default)]),
  ),
  ...values,
});

const settingRef = /(?<![\w.])settings\.([A-Za-z_][A-Za-z0-9_]*)/g;

export const flowSettingRefs = (steps: unknown): string[] => [
  ...new Set([...JSON.stringify(steps).matchAll(settingRef)].map((m) => m[1] as string)),
];
