export type ImportNoteKind = 'converted' | 'dropped' | 'text' | 'data';

export const importNoteCodes = [
  'convertedDeclarative',
  'droppedScript',
  'droppedStylesheet',
  'droppedHandler',
  'droppedLink',
  'droppedBase',
  'droppedStyle',
  'droppedElement',
  'colours',
  'englishLeftOut',
  'buttonWithoutEvent',
  'linkAsText',
  'bindOutsideFields',
  'eachOutsideFields',
] as const;

export type ImportNoteCode = (typeof importNoteCodes)[number];

/** One thing the import did, by a stable code; the API words it in the caller's language. */
export interface ImportFinding {
  kind: ImportNoteKind;
  code: ImportNoteCode;
  where: string;
  values?: Record<string, string | number>;
}

const maxFindings = 50;

/** Collects findings once per kind and code, counting repeats, in the order first seen. */
export const findings = () => {
  const seen = new Map<string, ImportFinding & { values: Record<string, string | number> }>();
  return {
    add(
      kind: ImportNoteKind,
      code: ImportNoteCode,
      where: string,
      values: Record<string, string | number> = {},
    ) {
      const key = `${kind}:${code}`;
      const found = seen.get(key);
      if (found) {
        found.values.count = Number(found.values.count ?? 1) + 1;
        return;
      }
      if (seen.size >= maxFindings) return;
      seen.set(key, { kind, code, where, values: { ...values } });
    },
    list(): ImportFinding[] {
      return [...seen.values()].map(({ values, ...rest }) =>
        Object.keys(values).length > 0 ? { ...rest, values } : rest,
      );
    },
  };
};

export type Findings = ReturnType<typeof findings>;
