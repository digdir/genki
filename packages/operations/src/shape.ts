import { mediaTypesOf, shape, type Shape } from '@genai/kernel';

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescriptorError';
  }
}

const scalars: Record<string, Shape> = {
  text: shape.text,
  plain: shape.plain(),
  ref: shape.ref(),
  number: shape.number(),
  integer: shape.number({ integer: true }),
  boolean: shape.boolean,
  null: shape.nothing,
  json: shape.json,
  opaque: shape.opaque,
};

const mediaRule = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const limit = (value: unknown, at: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new DescriptorError(`${at}: must be a number`);
  return value;
};

const only = (spec: Record<string, unknown>, allowed: string[], at: string) => {
  const extra = Object.keys(spec).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new DescriptorError(`${at}: unknown key ${extra.join(', ')}`);
};

const fieldsOf = (spec: unknown, at: string): Record<string, Shape> => {
  if (!isRecord(spec)) throw new DescriptorError(`${at}: must be a map of fields`);
  return Object.fromEntries(
    Object.entries(spec).map(([key, value]) => {
      const optional = key.endsWith('?');
      const name = optional ? key.slice(0, -1) : key;
      if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\[\])?$/.test(name))
        throw new DescriptorError(`${at}.${key}: not a field name`);
      const field = shapeOf(value, `${at}.${name}`);
      return [name, optional ? shape.optional(field) : field];
    }),
  );
};

/** Reads a shape written in a descriptor into the closed payload shape of the kernel. */
export const shapeOf = (spec: unknown, at = 'shape'): Shape => {
  if (typeof spec === 'string') {
    const scalar = scalars[spec];
    if (!scalar) throw new DescriptorError(`${at}: unknown shape ${spec}`);
    return scalar;
  }
  if (Array.isArray(spec)) {
    if (spec.length !== 1) throw new DescriptorError(`${at}: a list shape has one item shape`);
    return shape.array(shapeOf(spec[0], `${at}[]`));
  }
  if (!isRecord(spec)) throw new DescriptorError(`${at}: not a shape`);
  if ('object' in spec) {
    only(spec, ['object'], at);
    return shape.object(fieldsOf(spec.object, at));
  }
  if ('array' in spec) {
    only(spec, ['array', 'min', 'max', 'unique'], at);
    if (spec.unique !== undefined && typeof spec.unique !== 'string')
      throw new DescriptorError(`${at}.unique: must be a field name`);
    const min = limit(spec.min, `${at}.min`);
    const max = limit(spec.max, `${at}.max`);
    return shape.array(shapeOf(spec.array, `${at}[]`), {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(spec.unique === undefined ? {} : { unique: spec.unique }),
    });
  }
  if ('optional' in spec) {
    only(spec, ['optional'], at);
    return shape.optional(shapeOf(spec.optional, at));
  }
  if ('enum' in spec) {
    only(spec, ['enum'], at);
    if (!Array.isArray(spec.enum) || spec.enum.some((v) => typeof v !== 'string'))
      throw new DescriptorError(`${at}.enum: must be a list of strings`);
    return shape.oneOf(...(spec.enum as string[]));
  }
  if ('either' in spec) {
    only(spec, ['either'], at);
    if (!Array.isArray(spec.either) || spec.either.length < 2)
      throw new DescriptorError(`${at}.either: must list at least two shapes`);
    return shape.either(...spec.either.map((s, i) => shapeOf(s, `${at}.either[${i}]`)));
  }
  if ('variant' in spec) {
    only(spec, ['variant', 'options'], at);
    if (typeof spec.variant !== 'string' || !isRecord(spec.options))
      throw new DescriptorError(`${at}: a variant names its key and its options`);
    return shape.variant(
      spec.variant,
      Object.fromEntries(
        Object.entries(spec.options).map(([tag, fields]) => [
          tag,
          fieldsOf(fields, `${at}.${tag}`),
        ]),
      ),
    );
  }
  if ('plain' in spec) {
    only(spec, ['plain'], at);
    const min = limit(isRecord(spec.plain) ? spec.plain.min : undefined, `${at}.plain.min`);
    return shape.plain(min);
  }
  if ('media' in spec) {
    only(spec, ['media'], at);
    const types = Array.isArray(spec.media) ? spec.media : [spec.media];
    if (
      types.length === 0 ||
      types.some((t) => typeof t !== 'string' || !mediaRule.test(t.toLowerCase()))
    )
      throw new DescriptorError(
        `${at}.media: must be a media type such as type/subtype, or a list of them`,
      );
    return shape.media(
      Array.isArray(spec.media)
        ? types.map((t) => String(t).toLowerCase())
        : String(spec.media).toLowerCase(),
    );
  }
  if ('issued' in spec) {
    only(spec, ['issued'], at);
    if (typeof spec.issued !== 'string')
      throw new DescriptorError(`${at}.issued: must be a pattern`);
    try {
      return shape.issued(new RegExp(spec.issued));
    } catch {
      throw new DescriptorError(`${at}.issued: not a valid pattern`);
    }
  }
  if ('ref' in spec) {
    only(spec, ['ref'], at);
    if (typeof spec.ref !== 'string') throw new DescriptorError(`${at}.ref: must be a pattern`);
    try {
      return shape.ref(new RegExp(spec.ref));
    } catch {
      throw new DescriptorError(`${at}.ref: not a valid pattern`);
    }
  }
  if ('number' in spec) {
    only(spec, ['number'], at);
    const n = isRecord(spec.number) ? spec.number : {};
    only(n, ['integer', 'min', 'max'], `${at}.number`);
    const min = limit(n.min, `${at}.number.min`);
    const max = limit(n.max, `${at}.number.max`);
    return shape.number({
      ...(n.integer === true ? { integer: true } : {}),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    });
  }
  throw new DescriptorError(`${at}: not a shape`);
};

export const fieldNames = (s: Shape): string[] => {
  switch (s.kind) {
    case 'object':
      return Object.entries(s.fields).flatMap(([k, v]) => [k, ...fieldNames(v)]);
    case 'array':
    case 'optional':
      return fieldNames(s.kind === 'array' ? s.item : s.shape);
    case 'variant':
      return Object.values(s.options).flatMap(fieldNames);
    case 'either':
      return s.options.flatMap(fieldNames);
    default:
      return [];
  }
};

export const holdsMedia = (s: Shape): boolean => mediaTypesOf(s).length > 0;

/** Whether a shape names one kind of value only, as a query parameter, header or form field must. */
export const isScalar = (s: Shape): boolean =>
  s.kind === 'optional'
    ? isScalar(s.shape)
    : ['text', 'plain', 'ref', 'issued', 'enum', 'number', 'boolean', 'opaque'].includes(s.kind);

export const unwrapped = (s: Shape): Shape => (s.kind === 'optional' ? unwrapped(s.shape) : s);

export const holdsKind = (s: Shape, kind: Shape['kind']): boolean => {
  if (s.kind === kind) return true;
  switch (s.kind) {
    case 'object':
      return Object.values(s.fields).some((f) => holdsKind(f, kind));
    case 'array':
      return holdsKind(s.item, kind);
    case 'optional':
      return holdsKind(s.shape, kind);
    case 'variant':
      return Object.values(s.options).some((o) => holdsKind(o, kind));
    case 'either':
      return s.options.some((o) => holdsKind(o, kind));
    default:
      return false;
  }
};

export const holdsJson = (s: Shape): boolean => holdsKind(s, 'json');

/** The shape at a path of field names and list indexes, or undefined when the path leaves the shape. */
export const shapeAtPath = (s: Shape, path: readonly string[]): Shape | undefined => {
  const [head, ...rest] = path;
  const here = unwrapped(s);
  if (head === undefined) return here;
  if (here.kind === 'object') {
    const field = here.fields[head];
    return field ? shapeAtPath(field, rest) : undefined;
  }
  if (here.kind === 'array' && /^\d+$/.test(head)) return shapeAtPath(here.item, rest);
  return undefined;
};

/** The shapes of every field with the given name, at any depth. */
export const shapesNamed = (s: Shape, name: string): Shape[] => {
  switch (s.kind) {
    case 'object':
      return Object.entries(s.fields).flatMap(([k, v]) => [
        ...(k === name ? [unwrapped(v)] : []),
        ...shapesNamed(v, name),
      ]);
    case 'array':
      return shapesNamed(s.item, name);
    case 'optional':
      return shapesNamed(s.shape, name);
    case 'variant':
      return Object.values(s.options).flatMap((o) => shapesNamed(o, name));
    case 'either':
      return s.options.flatMap((o) => shapesNamed(o, name));
    default:
      return [];
  }
};
