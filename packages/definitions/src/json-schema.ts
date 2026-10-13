import { z } from 'zod';

export interface JsonSchemaOptions {
  io?: 'input' | 'output';
  bare?: boolean;
}

export const jsonSchemaOf = (schema: z.ZodType, options: JsonSchemaOptions = {}) => {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: options.io ?? 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  if (options.bare) Reflect.deleteProperty(out, '$schema');
  return out;
};
