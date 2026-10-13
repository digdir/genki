const wordChar = /[\p{L}\p{Nd}_]/u;

export const javaBoundary =
  '(?:(?<=[\\p{L}\\p{Nd}_])(?![\\p{L}\\p{Nd}_])|(?<![\\p{L}\\p{Nd}_])(?=[\\p{L}\\p{Nd}_]))';

const isWord = (text: string, at: number) =>
  at >= 0 && at < text.length && wordChar.test(text[at] as string);

export const isBoundary = (text: string, at: number) => isWord(text, at - 1) !== isWord(text, at);

const yearPattern = new RegExp(
  `${javaBoundary}(19[0-9]{2}|20[0-9]{2}|21[0-9]{2})${javaBoundary}`,
  'gu',
);
const numberPattern = new RegExp(`${javaBoundary}[0-9][0-9 .,:]*${javaBoundary}`, 'gu');

export const tokenize = (text: unknown): Set<string> => {
  const s = text === undefined || text === null ? '' : String(text);
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.trim() !== ''),
  );
};

export const yearsIn = (text: string): Set<string> =>
  new Set([...text.matchAll(yearPattern)].map((m) => m[1] as string));

export const numbersIn = (text: string): string[] =>
  [...text.matchAll(numberPattern)].map((m) => m[0]);

export const intersect = <T>(a: Set<T>, b: Set<T>): Set<T> =>
  new Set([...a].filter((x) => b.has(x)));

export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const containsWord = (text: string, value: string): boolean => {
  const haystack = asciiLower(text);
  const needle = asciiLower(value);
  if (needle === '') return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (isBoundary(text, at) && isBoundary(text, end)) return true;
  }
  return false;
};

const isJavaSpace = (c: string) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\u000b' || c === '\f' || c === '\r';

const trimJava = (s: string) => {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start++;
  while (end > start && s.charCodeAt(end - 1) <= 32) end--;
  return s.slice(start, end);
};

export const collapseWhitespace = (s: string) => {
  let out = '';
  let inSpace = false;
  for (const c of s) {
    if (isJavaSpace(c)) {
      if (!inSpace) out += ' ';
      inSpace = true;
    } else {
      out += c;
      inSpace = false;
    }
  }
  return trimJava(out);
};

const windowStarts = (n: number, size: number): number[] => {
  const step = Math.max(1, Math.floor(size / 2));
  const end = Math.max(1, n - size);
  const starts: number[] = [];
  for (let s = 0; s < end; s += step) starts.push(s);
  starts.push(Math.max(0, n - size));
  return [...new Set(starts)];
};

interface Window {
  start: number;
  end: number;
  tokens: Set<string>;
}

const scoreWindow = (
  content: string,
  query: Set<string>,
  n: number,
  start: number,
  size: number,
): Window => {
  const end = Math.min(n, start + size);
  return { start, end, tokens: intersect(query, tokenize(content.slice(start, end))) };
};

const maxBy = <T>(items: T[], key: (t: T) => number): T => {
  let best = items[0] as T;
  let bestKey = key(best);
  for (const item of items.slice(1)) {
    const k = key(item);
    if (k >= bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
};

export const bestContentWindow = (
  contentIn: string | undefined,
  query: string,
  budgetIn: number,
): string => {
  const content = contentIn ?? '';
  const budget = Math.max(1, budgetIn);
  if (content.length <= budget) return content;
  const qtokens = tokenize(query);
  if (qtokens.size === 0) return content.slice(0, budget);
  const n = content.length;
  let best: { score: number; start: number } | undefined;
  for (const s of windowStarts(n, budget)) {
    const score = scoreWindow(content, qtokens, n, s, budget).tokens.size;
    if (best === undefined || score > best.score) best = { score, start: s };
  }
  return best && best.score > 0
    ? content.slice(best.start, Math.min(n, best.start + budget))
    : content.slice(0, budget);
};

export const bestContentWindows = (
  contentIn: string | undefined,
  query: string,
  budgetIn: number,
): string => {
  const content = contentIn ?? '';
  const budget = Math.max(1, budgetIn);
  if (content.length <= budget) return content;
  const qtokens = tokenize(query);
  const single = () => bestContentWindow(content, query, budget);
  if (qtokens.size === 0) return single();
  const n = content.length;
  const unit = Math.max(1, Math.floor(budget / 2));
  const wins = windowStarts(n, unit).map((s) => scoreWindow(content, qtokens, n, s, unit));
  const w1 = maxBy(wins, (w) => w.tokens.size);
  const nonOverlapping = wins.filter((w) => !(w.start < w1.end && w.end > w1.start));
  const w2 =
    nonOverlapping.length > 0
      ? maxBy(nonOverlapping, (w) => [...w.tokens].filter((t) => !w1.tokens.has(t)).length)
      : undefined;
  const newCoverage = w2 ? [...w2.tokens].filter((t) => !w1.tokens.has(t)).length : 0;
  if (w2 && newCoverage > 0 && w1.tokens.size > 0) {
    const [a, b] = [w1, w2].sort((x, y) => x.start - y.start) as [Window, Window];
    return `${content.slice(a.start, a.end)}\n...\n${content.slice(b.start, b.end)}`;
  }
  return single();
};

export const contentSnippet = (
  content: string | undefined,
  query: string,
  budget = 220,
): string => {
  const collapsed = collapseWhitespace(bestContentWindow(content ?? '', query, budget));
  return collapsed.length > budget ? collapseWhitespace(collapsed.slice(0, budget)) : collapsed;
};

export const truncateHeadTail = (sIn: string | undefined, maxLenIn: number): string => {
  const s = sIn ?? '';
  const maxLen = Math.max(0, maxLenIn);
  if (s.length <= maxLen) return s;
  const marker = '\n...\n';
  if (maxLen <= marker.length + 2) return s.slice(0, maxLen);
  const budget = maxLen - marker.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${s.slice(0, head)}${marker}${s.slice(s.length - tail)}`;
};

type Edn = string | number | boolean | null | Edn[] | Map<string, Edn>;

const ednReader = (src: string) => {
  let i = 0;
  const skip = () => {
    while (i < src.length) {
      const c = src[i] as string;
      if (c === ';') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (/[\s,]/.test(c)) i++;
      else break;
    }
  };
  const readString = (): string => {
    i++;
    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        const n = src[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : (n ?? '');
        i += 2;
      } else out += src[i++];
    }
    if (src[i] !== '"') throw new Error('unterminated string');
    i++;
    return out;
  };
  const readSeq = (close: string): Edn[] => {
    const items: Edn[] = [];
    for (;;) {
      skip();
      if (i >= src.length) throw new Error('unterminated collection');
      if (src[i] === close) {
        i++;
        return items;
      }
      items.push(read());
    }
  };
  const read = (): Edn => {
    skip();
    const c = src[i];
    if (c === undefined) throw new Error('unexpected end');
    if (c === '"') return readString();
    if (c === '{') {
      i++;
      const items = readSeq('}');
      const map = new Map<string, Edn>();
      for (let k = 0; k + 1 < items.length; k += 2) map.set(String(items[k]), items[k + 1] as Edn);
      return map;
    }
    if (c === '[') {
      i++;
      return readSeq(']');
    }
    if (c === '(') {
      i++;
      return readSeq(')');
    }
    if (c === '#' && src[i + 1] === '{') {
      i += 2;
      return readSeq('}');
    }
    const start = i;
    while (i < src.length && !/[\s,{}[\]()"]/.test(src[i] as string)) i++;
    const token = src.slice(start, i);
    if (token === 'nil') return null;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return Number(token);
    return token.startsWith(':') ? token.slice(1) : token;
  };
  return read;
};

export const readEdn = (src: string): Edn | undefined => {
  try {
    return ednReader(src)();
  } catch {
    return undefined;
  }
};

export const metadataMap = (metadata: unknown): Map<string, Edn> | undefined => {
  if (metadata instanceof Map) return metadata as Map<string, Edn>;
  if (typeof metadata !== 'string') return undefined;
  const first = readEdn(metadata);
  const parsed = typeof first === 'string' ? readEdn(first) : first;
  return parsed instanceof Map ? parsed : undefined;
};

export const formatMetadataHeaders = (metadata: unknown): string | undefined => {
  const map = metadataMap(metadata);
  if (!map) return undefined;
  const entries: [number, string][] = [];
  for (const [key, value] of map) {
    const match = /^Header (\d+)$/.exec(key);
    if (!match) continue;
    const level = Number(match[1]);
    if (level > 0) entries.push([Math.min(4, 2 + level), String(value)]);
  }
  if (entries.length === 0) return undefined;
  return entries
    .sort((a, b) => a[0] - b[0])
    .map(([level, text]) => `${'#'.repeat(level)} ${text}`)
    .join('\n');
};

export const metadataHeaders = (metadata: unknown): string[] => {
  const map = metadataMap(metadata);
  if (!map) return [];
  const entries: [number, string][] = [];
  for (const [key, value] of map) {
    const match = /^Header (\d+)$/.exec(key);
    if (match && Number(match[1]) > 0) entries.push([Number(match[1]), String(value)]);
  }
  return entries.sort((a, b) => a[0] - b[0]).map(([, text]) => text);
};
