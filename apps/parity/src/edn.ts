import type { JsonValue } from './types.js';

const delimiters = new Set(['(', ')', '[', ']', '{', '}', '"', ';']);
const isSpace = (ch: string) => /[\s,]/.test(ch);

export const parseEdn = (text: string): JsonValue => {
  let i = 0;

  const skip = () => {
    while (i < text.length) {
      const ch = text[i] as string;
      if (isSpace(ch)) i += 1;
      else if (ch === ';') while (i < text.length && text[i] !== '\n') i += 1;
      else if (ch === '#' && text[i + 1] === '_') {
        i += 2;
        read();
      } else break;
    }
  };

  const token = () => {
    const start = i;
    while (i < text.length && !isSpace(text[i] as string) && !delimiters.has(text[i] as string))
      i += 1;
    return text.slice(start, i);
  };

  const string = () => {
    i += 1;
    let out = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const next = text[i + 1] as string;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
        i += 2;
      } else {
        out += text[i];
        i += 1;
      }
    }
    if (text[i] !== '"') throw new Error('unterminated EDN string');
    i += 1;
    return out;
  };

  const sequence = (close: string): JsonValue[] => {
    const items: JsonValue[] = [];
    for (;;) {
      skip();
      if (i >= text.length) throw new Error(`EDN collection is missing ${close}`);
      if (text[i] === close) {
        i += 1;
        return items;
      }
      items.push(read());
    }
  };

  const keyOf = (value: JsonValue) => (typeof value === 'string' ? value : JSON.stringify(value));

  const atom = (raw: string): JsonValue => {
    if (raw === 'nil') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw.startsWith(':')) return raw.slice(1);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?M?N?$/.test(raw)) return Number(raw.replace(/[MN]$/, ''));
    if (/^[+-]?\d+\/\d+$/.test(raw)) {
      const [n, d] = raw.split('/').map(Number) as [number, number];
      return n / d;
    }
    return raw;
  };

  const read = (): JsonValue => {
    skip();
    const ch = text[i];
    if (ch === undefined) throw new Error('unexpected end of EDN');
    if (ch === '"') return string();
    if (ch === '[') {
      i += 1;
      return sequence(']');
    }
    if (ch === '(') {
      i += 1;
      return sequence(')');
    }
    if (ch === '{') {
      i += 1;
      const items = sequence('}');
      const out: Record<string, JsonValue> = {};
      for (let k = 0; k + 1 < items.length; k += 2)
        out[keyOf(items[k] as JsonValue)] = items[k + 1] as JsonValue;
      return out;
    }
    if (ch === '#') {
      i += 1;
      if (text[i] === '{') {
        i += 1;
        return sequence('}');
      }
      token();
      return read();
    }
    if (ch === '\\') {
      i += 1;
      const start = i;
      i += 1;
      while (i < text.length && /[a-z]/.test(text[i] as string)) i += 1;
      const name = text.slice(start, i);
      return name.length === 1
        ? name
        : ({ newline: '\n', space: ' ', tab: '\t', return: '\r' }[name] ?? name);
    }
    return atom(token());
  };

  const value = read();
  skip();
  if (i < text.length) throw new Error('trailing data after EDN value');
  return value;
};
