import { parse as parseYaml } from 'yaml';
import { ApiError } from './api';
import type { PlainKey } from './i18n';
import type { DescriptorStatus, InputShape, Maturity } from './types';

export const statusLabel: Record<DescriptorStatus, PlainKey> = {
  review: 'modelOperations.statusReview',
  described: 'modelOperations.statusDescribed',
  typed: 'modelOperations.statusTyped',
};

export const statusColor: Record<DescriptorStatus, 'warning' | 'success' | 'info'> = {
  review: 'warning',
  described: 'success',
  typed: 'info',
};

export const maturityLabel: Record<Maturity, PlainKey> = {
  test: 'modelOperations.maturityTest',
  production: 'modelOperations.maturityProduction',
};

export type UploadField = 'id' | 'descriptor' | 'fixtures' | 'reason' | 'general';

/** The upload field an API error belongs next to, by its path. */
export const uploadFieldOf = (path: string | undefined): UploadField => {
  if (!path) return 'general';
  if (path === 'id') return 'id';
  if (path === 'change-reason') return 'reason';
  if (path === 'descriptor' || path.startsWith('descriptor.')) return 'descriptor';
  if (path === 'fixtures' || path.startsWith('fixtures.')) return 'fixtures';
  return 'general';
};

export const uploadErrors = (error: unknown): Partial<Record<UploadField, string[]>> => {
  if (!(error instanceof ApiError)) return {};
  const placed: Partial<Record<UploadField, string[]>> = {};
  for (const e of error.problem?.errors ?? []) {
    const field = uploadFieldOf(e.path);
    placed[field] = [...(placed[field] ?? []), e.message];
  }
  return placed;
};

/** The id a descriptor document names, so the operator need not type it twice. */
export const documentId = (text: string): string | undefined => {
  try {
    const doc = parseYaml(text) as unknown;
    return doc && typeof doc === 'object' && 'id' in doc && typeof doc.id === 'string'
      ? doc.id
      : undefined;
  } catch {
    return undefined;
  }
};

export const fixtureName = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type FieldKind = 'text' | 'line' | 'choice' | 'number' | 'yes-no' | 'lines' | 'json';

export interface FormField {
  path: string[];
  name: string;
  kind: FieldKind;
  optional: boolean;
  values?: string[];
}

const scalarKind = (shape: InputShape): FieldKind | undefined => {
  switch (shape.kind) {
    case 'text':
      return 'text';
    case 'plain':
    case 'ref':
      return 'line';
    case 'enum':
      return 'choice';
    case 'number':
      return 'number';
    case 'boolean':
      return 'yes-no';
    default:
      return undefined;
  }
};

const fieldOf = (shape: InputShape, path: string[], optional: boolean): FormField => {
  const name = path.at(-1) ?? 'input';
  if (shape.kind === 'optional') return fieldOf(shape.shape, path, true);
  const kind = scalarKind(shape);
  if (kind)
    return {
      path,
      name,
      kind,
      optional,
      ...(shape.kind === 'enum' ? { values: shape.values } : {}),
    };
  if (shape.kind === 'array' && scalarKind(shape.item) && shape.item.kind !== 'boolean')
    return { path, name, kind: 'lines', optional };
  return { path, name, kind: 'json', optional };
};

/** A form for a descriptor's typed input: one field per top-level input field. */
export const formFields = (shape: InputShape | undefined): FormField[] => {
  if (!shape) return [{ path: [], name: 'input', kind: 'json', optional: false }];
  if (shape.kind === 'object')
    return Object.entries(shape.fields).map(([key, field]) => fieldOf(field, [key], false));
  return [fieldOf(shape, [], false)];
};

const at = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined),
    value,
  );

/** Form values from an input, such as a recorded fixture's, to start a try from. */
export const formValues = (fields: FormField[], input: unknown): Record<string, string> =>
  Object.fromEntries(
    fields.map((f) => {
      const v = at(input, f.path);
      const key = f.path.join('.');
      if (v === undefined) return [key, ''];
      if (f.kind === 'lines' && Array.isArray(v)) return [key, v.map(String).join('\n')];
      if (f.kind === 'json') return [key, JSON.stringify(v, null, 2)];
      return [key, String(v)];
    }),
  );

export type FieldProblem = 'required' | 'number' | 'json' | 'choice';

const valueOf = (
  field: FormField,
  raw: string,
): { value?: unknown; problem?: FieldProblem } | undefined => {
  if (!raw.trim()) return field.optional ? undefined : { problem: 'required' };
  switch (field.kind) {
    case 'number': {
      const n = Number(raw.replace(',', '.'));
      return Number.isFinite(n) ? { value: n } : { problem: 'number' };
    }
    case 'yes-no':
      return { value: raw === 'true' };
    case 'choice':
      return field.values?.includes(raw) ? { value: raw } : { problem: 'choice' };
    case 'lines':
      return {
        value: raw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      };
    case 'json':
      try {
        return { value: JSON.parse(raw) as unknown };
      } catch {
        return { problem: 'json' };
      }
    default:
      return { value: raw };
  }
};

/** The typed input from the form, or a problem per field; an empty optional field is left out. */
export const inputOf = (
  fields: FormField[],
  values: Record<string, string>,
): { input: unknown } | { problems: Record<string, FieldProblem> } => {
  const problems: Record<string, FieldProblem> = {};
  let input: unknown = fields.length === 1 && fields[0]?.path.length === 0 ? undefined : {};
  for (const field of fields) {
    const key = field.path.join('.');
    const parsed = valueOf(field, values[key] ?? '');
    if (!parsed) continue;
    if (parsed.problem) {
      problems[key] = parsed.problem;
      continue;
    }
    if (field.path.length === 0) input = parsed.value;
    else input = { ...(input as Record<string, unknown>), [field.path[0] as string]: parsed.value };
  }
  return Object.keys(problems).length ? { problems } : { input };
};

export interface MediaItem {
  path: string;
  mediaType: string;
  bytes: number;
  src: string;
}

const isMediaRef = (v: unknown): v is { kind: 'media'; mediaType: string; bytes: number } =>
  Boolean(v) &&
  typeof v === 'object' &&
  (v as { kind?: unknown }).kind === 'media' &&
  typeof (v as { mediaType?: unknown }).mediaType === 'string';

/** The media in a try's answer, shown from the encoded bytes the exchange recorded. */
export const mediaIn = (result: unknown, encoded: unknown, path = ''): MediaItem[] => {
  if (isMediaRef(result))
    return typeof encoded === 'string'
      ? [
          {
            path,
            mediaType: result.mediaType,
            bytes: result.bytes,
            src: `data:${result.mediaType};base64,${encoded}`,
          },
        ]
      : [];
  if (Array.isArray(result))
    return result.flatMap((r, i) =>
      mediaIn(r, Array.isArray(encoded) ? encoded[i] : undefined, `${path}[${i}]`),
    );
  if (result && typeof result === 'object')
    return Object.entries(result).flatMap(([k, v]) =>
      mediaIn(
        v,
        encoded && typeof encoded === 'object'
          ? (encoded as Record<string, unknown>)[k]
          : undefined,
        path ? `${path}.${k}` : k,
      ),
    );
  return [];
};

/** A result with each media reference shown as its type and size, not its storage path. */
export const withoutMediaPaths = (result: unknown): unknown => {
  if (isMediaRef(result))
    return { kind: 'media', mediaType: result.mediaType, bytes: result.bytes };
  if (Array.isArray(result)) return result.map(withoutMediaPaths);
  if (result && typeof result === 'object')
    return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, withoutMediaPaths(v)]));
  return result;
};
