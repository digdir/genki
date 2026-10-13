export type Evaluator = (system: string, user: string) => Promise<string>;

export class StructuredEvalError extends Error {
  constructor(
    readonly stage: 'json-parse' | 'enum-validation' | 'confidence-parse' | 'llm-call',
    message: string,
  ) {
    super(message);
    this.name = 'StructuredEvalError';
  }
}

export const stripCodeFences = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? (fenced[1] ?? '') : trimmed;
};

export const extractJsonObject = (text: string): string => {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
};

export const parseJsonResponse = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(extractJsonObject(text));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new StructuredEvalError(
      'json-parse',
      `Failed to parse LLM JSON response: ${(error as Error).message}`,
    );
  }
};

export const keywordLike = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim().toLowerCase().replaceAll('_', '-') : undefined;

export const validatedEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T => {
  const candidate = keywordLike(value);
  if (candidate === undefined || !(allowed as readonly string[]).includes(candidate))
    throw new StructuredEvalError('enum-validation', `Invalid ${field}`);
  return candidate as T;
};

export const resolveAliasOrNormalize = (
  value: unknown,
  aliases: Record<string, string>,
): string | undefined => {
  if (typeof value === 'string' && aliases[value] !== undefined) return aliases[value];
  return keywordLike(value);
};

export const clampConfidence = (value: unknown): number => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (Number.isNaN(n)) throw new StructuredEvalError('confidence-parse', 'Invalid confidence');
  return Math.min(1, Math.max(0, n));
};

export const structuredEvaluate = async <T>(options: {
  llm: Evaluator;
  system: string;
  user: string;
  normalize: (parsed: Record<string, unknown>) => T;
  fallback: (error: unknown) => T;
  signal: AbortSignal;
}): Promise<T> => {
  try {
    return options.normalize(parseJsonResponse(await options.llm(options.system, options.user)));
  } catch (error) {
    if (options.signal.aborted) throw error;
    return options.fallback(error);
  }
};

export const json = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (v === undefined ? null : v));
