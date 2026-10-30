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

/** What a run's result does not depend on: publish stamps the risk confirmation with its time. */
const untested = new Set(['riskConfirmation']);

/** What a publishing gate looks a service's eval runs up by: the spec they tested. */
export const definitionSubject = (spec: unknown) => {
  const tested =
    spec && typeof spec === 'object' && !Array.isArray(spec)
      ? Object.fromEntries(Object.entries(spec).filter(([k]) => !untested.has(k)))
      : spec;
  return `spec:${createHash('sha256').update(stable(tested)).digest('hex').slice(0, 16)}`;
};
