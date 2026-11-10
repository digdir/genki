const uleb = (n: number): number[] => {
  const out: number[] = [];
  let value = n;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
};

const sleb = (n: number): number[] => {
  const out: number[] = [];
  let value = n;
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
};

const name = (text: string) => [...uleb(text.length), ...new TextEncoder().encode(text)];
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];

export const op = {
  i32: (n: number) => [0x41, ...sleb(n)],
  get: (i: number) => [0x20, i],
  set: (i: number) => [0x21, i],
  call: (i: number) => [0x10, i],
  add: [0x6a],
  drop: [0x1a],
  loopForever: [0x03, 0x40, 0x0c, 0x00, 0x0b],
  unreachable: [0x00],
  memoryGrow: [0x40, 0x00],
};

const i32 = 0x7f;
const typeOf = (params: number, results: number) => [
  0x60,
  ...vec(Array.from({ length: params }, () => [i32])),
  ...vec(Array.from({ length: results }, () => [i32])),
];

const hostSignatures: Record<string, [number, number]> = {
  input_read: [4, 1],
  sha256: [3, 0],
  hmac_sha256: [5, 1],
  hex_encode: [4, 1],
  hex_decode: [4, 1],
  base64_encode: [4, 1],
  base64_decode: [4, 1],
  emit: [4, 1],
};

export interface ModuleSpec {
  /** Host functions the module imports, in index order; the module's own `run` comes after them. */
  imports?: string[];
  /** Extra imports from another namespace, which the host does not offer. */
  foreign?: { module: string; name: string }[];
  locals?: number;
  body: number[];
  data?: { at: number; text: string }[];
  memory?: { min: number; max?: number } | 'own' | 'none';
  noRun?: boolean;
}

/** Assembles a small WebAssembly module whose `run` is the given instructions; for tests only. */
export const wasmModule = (spec: ModuleSpec): Uint8Array => {
  const hosts = spec.imports ?? [];
  const types = [
    ...hosts.map((h) => hostSignatures[h] as [number, number]),
    [0, 0] as [number, number],
  ];
  const foreign = spec.foreign ?? [];
  const memory = spec.memory ?? { min: 1 };
  const imports = [
    ...(memory === 'own' || memory === 'none'
      ? []
      : [
          [
            ...name('genki'),
            ...name('memory'),
            0x02,
            ...(memory.max === undefined
              ? [0x00, ...uleb(memory.min)]
              : [0x01, ...uleb(memory.min), ...uleb(memory.max)]),
          ],
        ]),
    ...hosts.map((h, i) => [...name('genki'), ...name(h), 0x00, ...uleb(i)]),
    ...foreign.map((f) => [...name(f.module), ...name(f.name), 0x00, ...uleb(types.length - 1)]),
  ];
  const runIndex = hosts.length + foreign.length;
  const code = [...(spec.locals ? vec([[...uleb(spec.locals), i32]]) : [0x00]), ...spec.body, 0x0b];
  const out = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, vec(types.map(([p, r]) => typeOf(p, r)))),
    ...section(2, vec(imports)),
    ...section(3, vec([[...uleb(types.length - 1)]])),
    ...(memory === 'own' ? section(5, vec([[0x00, 0x01]])) : []),
    ...section(7, vec(spec.noRun ? [] : [[...name('run'), 0x00, ...uleb(runIndex)]])),
    ...section(10, vec([[...uleb(code.length), ...code]])),
    ...(spec.data && memory !== 'own' && memory !== 'none'
      ? section(
          11,
          vec(
            spec.data.map((d) => [
              0x00,
              ...op.i32(d.at),
              0x0b,
              ...uleb(d.text.length),
              ...new TextEncoder().encode(d.text),
            ]),
          ),
        )
      : []),
  ];
  return new Uint8Array(out);
};

type Slot = 'body' | 'timestamp' | 'connection' | 'sig' | 'ts';
const at: Record<Slot, number> = {
  body: 0,
  timestamp: 4,
  connection: 13,
  sig: 23,
  ts: 26,
};
const table = [{ at: 0, text: 'bodytimestampconnectionsigts' }];
const str = (n: Slot) => [...op.i32(at[n]), ...op.i32(n.length)];

/** Signs body and timestamp with HMAC-SHA256 under the key named connection, and returns the hex signature and the timestamp. */
export const hmacSigner = (): Uint8Array =>
  wasmModule({
    imports: ['input_read', 'hmac_sha256', 'hex_encode', 'emit'],
    locals: 2,
    data: table,
    body: [
      ...str('body'),
      ...op.i32(1024),
      ...op.i32(8192),
      ...op.call(0),
      ...op.set(0),
      ...str('timestamp'),
      ...op.i32(1024),
      ...op.get(0),
      ...op.add,
      ...op.i32(64),
      ...op.call(0),
      ...op.set(1),
      ...str('connection'),
      ...op.i32(1024),
      ...op.get(0),
      ...op.get(1),
      ...op.add,
      ...op.i32(16384),
      ...op.call(1),
      ...op.drop,
      ...op.i32(16384),
      ...op.i32(32),
      ...op.i32(16512),
      ...op.i32(64),
      ...op.call(2),
      ...op.drop,
      ...str('sig'),
      ...op.i32(16512),
      ...op.i32(64),
      ...op.call(3),
      ...op.drop,
      ...str('ts'),
      ...op.i32(1024),
      ...op.get(0),
      ...op.add,
      ...op.get(1),
      ...op.call(3),
      ...op.drop,
    ],
  });

/** Emits one value under one name, both written into the module's data. */
export const emitting = (nameOf: string, value: string) =>
  wasmModule({
    imports: ['emit'],
    data: [
      { at: 0, text: nameOf },
      { at: 100, text: value },
    ],
    body: [
      ...op.i32(0),
      ...op.i32(nameOf.length),
      ...op.i32(100),
      ...op.i32(value.length),
      ...op.call(0),
      ...op.drop,
    ],
  });
