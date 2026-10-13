import { parse, parseDocument } from 'yaml';

const plain = /^[A-Za-zÆØÅæøå0-9_./@-][A-Za-zÆØÅæøå0-9_ ./@:-]*$/;

const readsBack = (text: string) => {
  try {
    return (parse(`v: ${text}`) as { v: unknown } | null)?.v === text;
  } catch {
    return false;
  }
};

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (plain.test(text) && !/^(yes|no)$/i.test(text) && !text.endsWith(' ') && readsBack(text))
    return text;
  return `'${text.replace(/'/g, "''")}'`;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const multiline = (head: string, text: string, indent: string): string[] => {
  if (/^\s/.test(text) || /\n\n$/.test(text) || /[ \t]$/m.test(text))
    return [`${head} ${JSON.stringify(text)}`];
  const body = text.replace(/\n$/, '').split('\n');
  return [
    `${head} ${text.endsWith('\n') ? '|' : '|-'}`,
    ...body.map((l) => (l ? `${indent}${l}` : '')),
  ];
};

const lines = (value: unknown, indent: string): string[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    return value.flatMap((item) => {
      const nested = lines(item, `${indent}  `);
      if (isObject(item) || Array.isArray(item)) {
        const [first, ...rest] = nested;
        return [`${indent}- ${(first ?? '').trimStart()}`, ...rest];
      }
      if (typeof item === 'string' && item.includes('\n'))
        return multiline(`${indent}-`, item, `${indent}  `);
      return [`${indent}- ${scalar(item)}`];
    });
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    return entries.flatMap(([key, v]) => {
      if ((isObject(v) && Object.keys(v).length > 0) || (Array.isArray(v) && v.length > 0)) {
        return [`${indent}${scalar(key)}:`, ...lines(v, `${indent}  `)];
      }
      if (typeof v === 'string' && v.includes('\n'))
        return multiline(`${indent}${scalar(key)}:`, v, `${indent}  `);
      return [
        `${indent}${scalar(key)}: ${isObject(v) ? '{}' : Array.isArray(v) ? '[]' : scalar(v)}`,
      ];
    });
  }
  return [`${indent}${scalar(value)}`];
};

export const toYaml = (value: unknown): string => `${lines(value, '').join('\n')}\n`;

export class YamlError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`Linje ${line}: ${message}`);
    this.name = 'YamlError';
  }
}

export const parseYaml = (text: string): unknown => {
  const tab = text.split('\n').findIndex((l) => /^\s*\t/.test(l));
  if (tab >= 0) throw new YamlError(tab + 1, 'bruk mellomrom, ikke tabulator.');
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const [error] = doc.errors;
  if (error) {
    const line = error.linePos?.[0]?.line ?? lineAt(text, error.pos[0]);
    throw new YamlError(line, describe(error.code));
  }
  return doc.toJS({ maxAliasCount: 50 }) ?? {};
};

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

const messages: Partial<Record<string, string>> = {
  DUPLICATE_KEY: 'samme navn står to ganger.',
  BAD_INDENT: 'feil innrykk.',
  MISSING_CHAR: 'mangler et tegn, for eksempel «]» eller «}».',
  MULTILINE_IMPLICIT_KEY: 'forventet «navn: verdi».',
  BAD_SCALAR_START: 'ugyldig verdi.',
};

const describe = (code: string) => messages[code] ?? 'ugyldig YAML.';
