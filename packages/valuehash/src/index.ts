import { createHash } from 'node:crypto';

export class Keyword {
  constructor(readonly name: string) {}
}
export class Sym {
  constructor(readonly name: string) {}
}
export class Char {
  constructor(readonly value: string) {}
}
export class Double {
  constructor(readonly value: number) {}
}
export class Uuid {
  constructor(readonly value: string) {}
}

export const keyword = (name: string) => new Keyword(name);
export const symbol = (name: string) => new Sym(name);
export const char = (value: string) => new Char(value);
export const double = (value: number) => new Double(value);
export const uuid = (value: string) => new Uuid(value);

export type Value =
  | null
  | string
  | boolean
  | number
  | bigint
  | Keyword
  | Sym
  | Char
  | Double
  | Uuid
  | Date
  | readonly Value[]
  | ReadonlySet<Value>
  | ReadonlyMap<Value, Value>
  | { readonly [key: string]: Value };

const LIST_SEP = 42;
const SET_SEP = 21;
const MAP_SEP = 19;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

const utf8 = (s: string) => new TextEncoder().encode(s);

export const longBytes = (input: bigint | number): Uint8Array => {
  const v = BigInt(input);
  if (v < LONG_MIN || v > LONG_MAX) throw new RangeError(`${v} does not fit in a long`);
  let n = 1;
  while (v < -(2n ** BigInt(8 * n - 1)) || v >= 2n ** BigInt(8 * n - 1)) n++;
  let u = v < 0n ? v + 2n ** BigInt(8 * n) : v;
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(u & 0xffn);
    u >>= 8n;
  }
  return out;
};

const doubleBits = (d: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number.isNaN(d) ? NaN : d);
  return view.getBigInt64(0);
};

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const signed = (b: number) => (b > 127 ? b - 256 : b);

const compare = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = a.length - 1; i >= 0; i--) {
    const c = signed(a[i] as number) - signed(b[i] as number);
    if (c !== 0) return c;
  }
  return 0;
};

const sequence = (sep: number, items: Uint8Array[]) => {
  const parts: Uint8Array[] = [Uint8Array.of(sep)];
  items.forEach((item, i) => {
    if (i > 0) parts.push(Uint8Array.of(sep));
    parts.push(item);
  });
  return join(parts);
};

const uuidBytes = (value: string) => {
  const hex = value.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError(`not a UUID: ${value}`);
  const most = BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`));
  const least = BigInt.asIntN(64, BigInt(`0x${hex.slice(16)}`));
  return join([longBytes(most), longBytes(least)]);
};

const mapBytes = (entries: [Value, Value][]) =>
  join([
    Uint8Array.of(MAP_SEP),
    ...entries.map(([k, v]) => join([toBytes(k), toBytes(v)])).sort(compare),
  ]);

export const toBytes = (value: Value): Uint8Array => {
  if (value === null) return Uint8Array.of(0);
  if (typeof value === 'string') return utf8(value);
  if (typeof value === 'boolean') return Uint8Array.of(value ? 1 : 0);
  if (typeof value === 'bigint') return longBytes(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return longBytes(doubleBits(value));
    if (!Number.isSafeInteger(value))
      throw new RangeError(`${value} is not a safe integer; pass a bigint or double()`);
    return longBytes(value);
  }
  if (value instanceof Keyword) return utf8(`:${value.name}`);
  if (value instanceof Sym || value instanceof Char)
    return utf8(value instanceof Sym ? value.name : value.value);
  if (value instanceof Double) return longBytes(doubleBits(value.value));
  if (value instanceof Uuid) return uuidBytes(value.value);
  if (value instanceof Date) return longBytes(value.getTime());
  if (Array.isArray(value)) return sequence(LIST_SEP, value.map(toBytes));
  if (value instanceof Set) return sequence(SET_SEP, [...value].map(toBytes).sort(compare));
  if (value instanceof Map) return mapBytes([...value.entries()]);
  return mapBytes(Object.entries(value).map(([k, v]) => [keyword(k), v]));
};

const digest = (algorithm: string, value: Value) =>
  createHash(algorithm).update(toBytes(value)).digest('hex');

export const sha256Hex = (value: Value) => digest('sha256', value);
export const sha1Hex = (value: Value) => digest('sha1', value);
export const md5Hex = (value: Value) => digest('md5', value);

export const shortHash = (value: Value) => sha256Hex(value).slice(0, 12);
