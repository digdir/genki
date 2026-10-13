import { describe, expect, it } from 'vitest';
import fixtures from './fixtures.json' with { type: 'json' };
import {
  char,
  double,
  keyword,
  longBytes,
  md5Hex,
  sha256Hex,
  shortHash,
  symbol,
  uuid,
  type Value,
} from './index.js';

const k = keyword;

const values: Record<string, Value> = {
  nil: null,
  '""': '',
  '"hello"': 'hello',
  '"Årsrapport æøå – 2025"': 'Årsrapport æøå – 2025',
  '"emoji 🙂"': 'emoji 🙂',
  ':a': k('a'),
  ':chunks/strategy': k('chunks/strategy'),
  "'sym": [symbol('quote'), symbol('sym')],
  "'ns/sym": [symbol('quote'), symbol('ns/sym')],
  '0': 0,
  '1': 1,
  '-1': -1,
  '127': 127,
  '128': 128,
  '255': 255,
  '256': 256,
  '-128': -128,
  '-129': -129,
  '65535': 65535,
  '9223372036854775807': 9223372036854775807n,
  '-9223372036854775808': -9223372036854775808n,
  '1.5': 1.5,
  '0.0': double(0),
  '-0.0': double(-0),
  '3.141592653589793': Math.PI,
  '1.0E300': double(1e300),
  true: true,
  false: false,
  '\\a': char('a'),
  '\\ø': char('ø'),
  '[]': [],
  '[1 2 3]': [1, 2, 3],
  '["a" ["b" nil]]': ['a', ['b', null]],
  "'(1 2)": [symbol('quote'), [1, 2]],
  '#{}': new Set(),
  '#{1 2 3}': new Set([3, 1, 2]),
  '#{"a" "b" "c"}': new Set(['c', 'a', 'b']),
  '#{:x :yy :zzz}': new Set([k('zzz'), k('x'), k('yy')]),
  '{}': {},
  '{:a 1}': { a: 1 },
  '{:a 1 :b 2}': { a: 1, b: 2 },
  '{:b 2 :a 1}': { b: 2, a: 1 },
  '{"k" [1 {:n nil}]}': new Map<Value, Value>([['k', [1, { n: null }]]]),
  '{:chunks/strategy "markdown" :chunks/hash-changer 2}': {
    'chunks/hash-changer': 2,
    'chunks/strategy': 'markdown',
  },
  '#uuid "00000000-0000-0000-0000-000000000001"': uuid('00000000-0000-0000-0000-000000000001'),
  '#uuid "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"': uuid('f81d4fae-7dec-11d0-a765-00a0c91e6bf6'),
  '#inst "2026-10-06T10:00:00.000Z"': new Date('2026-10-06T10:00:00.000Z'),
  '"d42|0|Tildelingsbrev for 2025"': 'd42|0|Tildelingsbrev for 2025',
  '"abc123def456|hva er tildelingsbrevet"': 'abc123def456|hva er tildelingsbrevet',
  '"https://kudos.dfo.no/dokument/123"': 'https://kudos.dfo.no/dokument/123',
};

describe('valuehash', () => {
  it('has a value for every fixture produced by the Clojure library', () => {
    expect(fixtures.map((f) => f.edn).sort()).toEqual(Object.keys(values).sort());
  });

  it.each(fixtures)('matches Clojure for $edn', ({ edn, sha256, md5 }) => {
    const value = values[edn] as Value;
    expect(sha256Hex(value)).toBe(sha256);
    expect(md5Hex(value)).toBe(md5);
  });

  it('gives the collection suffix headless-rag documents for an empty config', () => {
    expect(shortHash({})).toBe('ab897fbdedfa');
    expect(shortHash(new Map())).toBe('ab897fbdedfa');
  });

  it('encodes longs as minimal two-complement bytes like BigInteger.toByteArray', () => {
    expect([...longBytes(0)]).toEqual([0]);
    expect([...longBytes(127)]).toEqual([127]);
    expect([...longBytes(128)]).toEqual([0, 128]);
    expect([...longBytes(-1)]).toEqual([255]);
    expect([...longBytes(-129)]).toEqual([255, 127]);
  });

  it('refuses numbers it cannot represent exactly', () => {
    expect(() => sha256Hex(2 ** 60)).toThrow(/safe integer/);
    expect(() => sha256Hex(2n ** 64n)).toThrow(/does not fit/);
  });
});
