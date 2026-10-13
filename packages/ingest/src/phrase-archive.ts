import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  phraseIdentitySegments,
  type DeclaredPhraseArchive,
  type PhraseIdentity,
} from './phrases.js';

export type Edn =
  null | boolean | number | string | { keyword: string } | Edn[] | Map<Edn, Edn> | Set<Edn>;

const escapes: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  f: '\f',
  b: '\b',
  '"': '"',
  '\\': '\\',
};

export const readEdn = (text: string): Edn => {
  let at = 0;
  const skip = () => {
    for (;;) {
      const c = text[at];
      if (c === undefined) return;
      if (c === ';') {
        while (at < text.length && text[at] !== '\n') at += 1;
      } else if (c === ',' || /\s/.test(c)) at += 1;
      else if (c === '#' && text[at + 1] === '_') {
        at += 2;
        value();
      } else return;
    }
  };
  const collection = (close: string): Edn[] => {
    const items: Edn[] = [];
    for (;;) {
      skip();
      if (text[at] === close) {
        at += 1;
        return items;
      }
      if (at >= text.length) throw new Error(`EDN ends before ${close}`);
      items.push(value());
    }
  };
  const string = () => {
    let out = '';
    at += 1;
    for (;;) {
      const c = text[at];
      if (c === undefined) throw new Error('EDN ends inside a string');
      at += 1;
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[at] as string;
      at += 1;
      if (e === 'u') {
        out += String.fromCharCode(parseInt(text.slice(at, at + 4), 16));
        at += 4;
      } else out += escapes[e] ?? e;
    }
  };
  const value = (): Edn => {
    skip();
    const c = text[at];
    if (c === undefined) throw new Error('EDN ends where a value was expected');
    if (c === '"') return string();
    if (c === '{') {
      at += 1;
      const items = collection('}');
      const map = new Map<Edn, Edn>();
      for (let i = 0; i < items.length; i += 2) map.set(items[i] as Edn, items[i + 1] as Edn);
      return map;
    }
    if (c === '[' || c === '(') {
      at += 1;
      return collection(c === '[' ? ']' : ')');
    }
    if (c === '#' && text[at + 1] === '{') {
      at += 2;
      return new Set(collection('}'));
    }
    const token = /^[^\s,;()[\]{}"]+/.exec(text.slice(at))?.[0];
    if (!token) throw new Error(`EDN has an unexpected ${c} at ${at}`);
    at += token.length;
    if (token === 'nil') return null;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token.startsWith(':')) return { keyword: token.slice(1) };
    const number = Number(token.replace(/[NM]$/, ''));
    if (!Number.isNaN(number)) return number;
    return { keyword: token };
  };
  const result = value();
  skip();
  return result;
};

const keywordOrString = (value: Edn | undefined) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'keyword' in value
      ? value.keyword
      : undefined;

const field = (map: Map<Edn, Edn>, name: string) =>
  [...map].find(([k]) => keywordOrString(k) === name)?.[1];

export const readDeclaredIdentity = (edn: string): PhraseIdentity => {
  const declaration = readEdn(edn);
  if (!(declaration instanceof Map))
    throw new Error('the declared phrase-cache identity must be one map, not a collection');
  const provider = keywordOrString(field(declaration, 'provider'));
  const model = keywordOrString(field(declaration, 'model'));
  if (!provider || !model)
    throw new Error('the declared phrase-cache identity needs a provider and a model');
  return { provider, model };
};

export const shippedFourSegmentArchiveSha256 =
  '6317610796658c8df0c436eefbd4854fa92a6ffc634633e4e10e6813b608e80b';

export type PhraseArchiveLoad =
  | {
      action: 'loaded';
      archive: DeclaredPhraseArchive;
      entries: number;
      verified: ('configured-model' | 'provider' | 'model')[];
    }
  | { action: 'skipped'; reason: string };

const describedBy = (key: string, identity: PhraseIdentity) => {
  const parts = key.split('-');
  const [provider, model] = phraseIdentitySegments(identity);
  if (parts.length === 4) return parts[1] === model;
  if (parts.length === 5) return parts[1] === provider && parts[2] === model;
  return false;
};

export const loadPhraseArchive = (
  gzipped: Uint8Array,
  identityEdn: string,
  pinnedFourSegmentSha256 = shippedFourSegmentArchiveSha256,
): PhraseArchiveLoad => {
  try {
    const identity = readDeclaredIdentity(identityEdn);
    const content = gunzipSync(gzipped);
    const parsed = readEdn(content.toString('utf8'));
    if (!(parsed instanceof Map)) return { action: 'skipped', reason: 'not-a-map' };
    const entries = new Map<string, string[]>();
    for (const [k, v] of parsed)
      if (typeof k === 'string' && Array.isArray(v))
        entries.set(
          k,
          v.filter((p): p is string => typeof p === 'string'),
        );
    const shapes = new Set([...entries.keys()].map((k) => k.split('-').length));
    if (shapes.size > 1) return { action: 'skipped', reason: 'mixed-key-shapes' };
    if (
      shapes.has(4) &&
      createHash('sha256').update(content).digest('hex') !== pinnedFourSegmentSha256
    )
      return { action: 'skipped', reason: 'four-segment-archive-not-the-shipped-one' };
    if ([...entries.keys()].some((k) => !describedBy(k, identity)))
      return { action: 'skipped', reason: 'declaration-mismatch' };
    return {
      action: 'loaded',
      archive: { identity, entries },
      entries: entries.size,
      verified: shapes.has(4) ? ['configured-model'] : ['provider', 'model'],
    };
  } catch (error) {
    return {
      action: 'skipped',
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
