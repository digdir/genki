const plain = /^[A-Za-zÆØÅæøå0-9_./@-][A-Za-zÆØÅæøå0-9_ ./@:-]*$/;

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (
    plain.test(text) &&
    !/^(true|false|null|yes|no|\d[\d.]*)$/i.test(text) &&
    !text.endsWith(':') &&
    !text.endsWith(' ') &&
    !/: /.test(text)
  )
    return text;
  return `'${text.replace(/'/g, "''")}'`;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const blockLines = (text: string, indent: string) =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => (l ? `${indent}${l}` : ''));

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
        return [`${indent}- |`, ...blockLines(item, `${indent}  `)];
      return [`${indent}- ${scalar(item)}`];
    });
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    return entries.flatMap(([key, v]) => {
      if ((isObject(v) && Object.keys(v).length > 0) || (Array.isArray(v) && v.length > 0)) {
        return [`${indent}${key}:`, ...lines(v, `${indent}  `)];
      }
      if (typeof v === 'string' && v.includes('\n'))
        return [`${indent}${key}: |`, ...blockLines(v, `${indent}  `)];
      return [`${indent}${key}: ${isObject(v) ? '{}' : Array.isArray(v) ? '[]' : scalar(v)}`];
    });
  }
  return [`${indent}${scalar(value)}`];
};

export const toYaml = (value: unknown): string => `${lines(value, '').join('\n')}\n`;
