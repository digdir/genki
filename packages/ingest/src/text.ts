const javaWhitespace = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000,
]);

export const isJavaWhitespace = (unit: number) => javaWhitespace.has(unit);

export const clojureTrim = (s: string) => {
  let end = s.length;
  while (end > 0 && isJavaWhitespace(s.charCodeAt(end - 1))) end -= 1;
  if (end === 0) return '';
  let start = 0;
  while (isJavaWhitespace(s.charCodeAt(start))) start += 1;
  return s.slice(start, end);
};

export const isBlank = (s: string | null | undefined) =>
  s === null || s === undefined || [...s].every((c) => isJavaWhitespace(c.charCodeAt(0)));

export const javaSplit = (s: string, pattern: RegExp) => {
  const parts = s.split(pattern);
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 1 && parts[0] === '' && s.length > 0) return [];
  return parts;
};

export const splitLines = (s: string) => javaSplit(s, /\r?\n/);

export const capitalize = (s: string) =>
  s.length < 2 ? s.toUpperCase() : s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();

const escapes: Record<string, string> = {
  '\n': '\\n',
  '\t': '\\t',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
  '\f': '\\f',
  '\b': '\\b',
};

export const ednString = (s: string) =>
  `"${s.replace(/[\n\t\r"\\\f\b]/g, (c) => escapes[c] ?? c)}"`;

export const ednStringMap = (map: ReadonlyMap<string, string>) =>
  `{${[...map].map(([k, v]) => `${ednString(k)} ${ednString(v)}`).join(', ')}}`;
