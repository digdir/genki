import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const moduleLimits = {
  maxBytes: 128 * 1024,
  maxModules: 2,
  timeoutMs: 250,
  memoryPages: 16,
  startPages: 2,
  maxInputBytes: 1024 * 1024,
  maxEmits: 8,
  maxEmitBytes: 512,
  maxDerivedKeys: 8,
  maxKeyPrefixBytes: 64,
} as const;

export const hostFunctions = [
  'input_read',
  'sha256',
  'hmac_sha256',
  'hmac_sha256_derive',
  'hex_encode',
  'hex_decode',
  'base64_encode',
  'base64_decode',
  'emit',
] as const;

export class ModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleError';
  }
}

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const sectionIds = { memory: 5 } as const;

const readLeb = (bytes: Uint8Array, at: number): [number, number] => {
  let result = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift < 35; i += 1) {
    const byte = bytes[i] as number;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, i + 1];
    shift += 7;
  }
  throw new ModuleError('the module is not a valid WebAssembly binary');
};

/** What is wrong with a module before it ever runs: its size, its imports, and a memory of its own. */
export const moduleProblems = (bytes: Uint8Array): string[] => {
  if (bytes.byteLength > moduleLimits.maxBytes)
    return [`a module is at most ${moduleLimits.maxBytes / 1024} KiB`];
  const problems: string[] = [];
  try {
    if (
      bytes.byteLength < 8 ||
      bytes[0] !== 0 ||
      bytes[1] !== 0x61 ||
      bytes[2] !== 0x73 ||
      bytes[3] !== 0x6d
    )
      return ['the module is not a WebAssembly binary'];
    let at = 8;
    while (at < bytes.length) {
      const id = bytes[at] as number;
      const [size, next] = readLeb(bytes, at + 1);
      if (id === sectionIds.memory)
        problems.push('the module defines its own memory; it imports the memory the host gives it');
      at = next + size;
    }
    const compiled = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
    for (const entry of WebAssembly.Module.imports(compiled)) {
      const name = `${entry.module}.${entry.name}`;
      const allowed =
        entry.module === 'genki' &&
        ((entry.kind === 'function' && (hostFunctions as readonly string[]).includes(entry.name)) ||
          (entry.kind === 'memory' && entry.name === 'memory'));
      if (!allowed) problems.push(`the module imports ${name}, which the host does not offer`);
    }
    if (
      !WebAssembly.Module.exports(compiled).some((e) => e.name === 'run' && e.kind === 'function')
    )
      problems.push('the module exports no run function');
  } catch (error) {
    problems.push(
      error instanceof ModuleError
        ? error.message
        : `the module does not compile: ${(error as Error).message}`,
    );
  }
  return problems;
};

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const { bytes, inputs, keys, startPages, memoryPages, maxEmits, maxEmitBytes, maxDerivedKeys, maxKeyPrefixBytes } = workerData;
const store = new Map(Object.entries(keys).map(([name, key]) => [name, Buffer.from(key, 'utf8')]));
let derived = 0;
const memory = new WebAssembly.Memory({ initial: startPages, maximum: memoryPages });
const emits = [];
const view = () => new Uint8Array(memory.buffer);
const slice = (ptr, len) => {
  if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0 || ptr + len > memory.buffer.byteLength)
    throw new Error('the module reached outside its memory');
  return view().subarray(ptr, ptr + len);
};
const text = (ptr, len) => Buffer.from(slice(ptr, len)).toString('utf8');
const put = (ptr, cap, data) => {
  if (data.length > cap) return -1;
  slice(ptr, data.length).set(data);
  return data.length;
};
const host = {
  memory,
  input_read: (namePtr, nameLen, dst, cap) => {
    const value = inputs[text(namePtr, nameLen)];
    return value === undefined ? -1 : put(dst, cap, value);
  },
  sha256: (src, len, dst) => {
    put(dst, 32, crypto.createHash('sha256').update(slice(src, len)).digest());
  },
  hmac_sha256: (keyPtr, keyLen, src, len, dst) => {
    const key = store.get(text(keyPtr, keyLen));
    if (key === undefined) return -1;
    return put(dst, 32, crypto.createHmac('sha256', key).update(slice(src, len)).digest());
  },
  hmac_sha256_derive: (keyPtr, keyLen, prefixPtr, prefixLen, src, len, namePtr, nameLen) => {
    const key = store.get(text(keyPtr, keyLen));
    const name = text(namePtr, nameLen);
    if (key === undefined || store.has(name) || prefixLen > maxKeyPrefixBytes) return -1;
    if (derived >= maxDerivedKeys) throw new Error('the module derived too many keys');
    derived += 1;
    const prefixed = Buffer.concat([Buffer.from(slice(prefixPtr, prefixLen)), key]);
    store.set(name, crypto.createHmac('sha256', prefixed).update(slice(src, len)).digest());
    return 0;
  },
  hex_encode: (src, len, dst, cap) => put(dst, cap, Buffer.from(Buffer.from(slice(src, len)).toString('hex'))),
  hex_decode: (src, len, dst, cap) => {
    const hex = text(src, len);
    return /^([0-9a-f]{2})*$/i.test(hex) ? put(dst, cap, Buffer.from(hex, 'hex')) : -1;
  },
  base64_encode: (src, len, dst, cap) => put(dst, cap, Buffer.from(Buffer.from(slice(src, len)).toString('base64'))),
  base64_decode: (src, len, dst, cap) => {
    const b64 = text(src, len);
    return /^[A-Za-z0-9+/]*={0,2}$/.test(b64) ? put(dst, cap, Buffer.from(b64, 'base64')) : -1;
  },
  emit: (namePtr, nameLen, valPtr, valLen) => {
    if (emits.length >= maxEmits) throw new Error('the module emitted too many values');
    if (valLen > maxEmitBytes) throw new Error('the module emitted a value that is too long');
    emits.push([text(namePtr, nameLen), text(valPtr, valLen)]);
    return 0;
  },
};
try {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { genki: host });
  instance.exports.run();
  parentPort.postMessage({ emits });
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message ? error.message : error) });
}
`;

export interface ModuleRun {
  bytes: Uint8Array;
  inputs: Record<string, Uint8Array>;
  keys: Record<string, string>;
}

/** Runs a module's `run` in its own thread with a time and memory limit, and returns what it emitted. */
export const runModule = async (run: ModuleRun): Promise<[string, string][]> => {
  const inputBytes = Object.values(run.inputs).reduce((n, v) => n + v.byteLength, 0);
  if (inputBytes > moduleLimits.maxInputBytes)
    throw new ModuleError(`the module's input is over ${moduleLimits.maxInputBytes} bytes`);
  const worker = new Worker(workerSource, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    workerData: {
      bytes: run.bytes,
      inputs: run.inputs,
      keys: run.keys,
      startPages: moduleLimits.startPages,
      memoryPages: moduleLimits.memoryPages,
      maxEmits: moduleLimits.maxEmits,
      maxEmitBytes: moduleLimits.maxEmitBytes,
      maxDerivedKeys: moduleLimits.maxDerivedKeys,
      maxKeyPrefixBytes: moduleLimits.maxKeyPrefixBytes,
    },
  });
  try {
    const message = await new Promise<{ emits?: [string, string][]; error?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new ModuleError(`the module ran over ${moduleLimits.timeoutMs} ms`)),
          moduleLimits.timeoutMs,
        );
        worker.once('message', (m) => {
          clearTimeout(timer);
          resolve(m as { emits?: [string, string][]; error?: string });
        });
        worker.once('error', (e: Error) => {
          clearTimeout(timer);
          reject(new ModuleError(`the module failed: ${e.message}`));
        });
      },
    );
    if (message.error) throw new ModuleError(`the module failed: ${message.error}`);
    return message.emits ?? [];
  } finally {
    await worker.terminate();
  }
};
