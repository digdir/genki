import { createHash } from 'node:crypto';

const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** What a publishing gate looks a service's eval runs up by: the spec they tested. */
export const definitionSubject = (spec: unknown) =>
  `spec:${createHash('sha256').update(stable(spec)).digest('hex').slice(0, 16)}`;
