import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import { BlobError, checkPath } from './blob.js';

export type Settings = { readonly [key: string]: unknown };

export interface NativeOutputKey {
  sha256: string;
  converter: string;
  version: string;
  settings: Settings;
}

export interface NativeOutputMeta {
  converter: string;
  version: string;
  settings: Settings;
  pages: number;
  when: string;
}

export interface NativeOutputEntry {
  sha256: string;
  converter: string;
  version: string;
  settingsHash: string;
  path: string;
  metaPath: string;
}

export interface StoredNativeOutput {
  entry: NativeOutputEntry;
  output: Uint8Array;
  meta: NativeOutputMeta;
}

/** A blob container with no tenant: paths are the whole key. */
export interface NativeOutputContainer {
  write(path: string, body: Uint8Array, contentType: string): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
  remove(path: string): Promise<boolean>;
}

export interface NativeOutputStore {
  /** `when` is when the converter finished, the time of the put by default; `bytes` is the gzipped size. */
  put(
    key: NativeOutputKey,
    output: Uint8Array,
    pages: number,
    when?: string,
  ): Promise<NativeOutputEntry & { bytes: number }>;
  get(key: NativeOutputKey): Promise<StoredNativeOutput | undefined>;
  list(sha256: string): Promise<NativeOutputEntry[]>;
  /** The outputs of every file whose sha256 starts with `prefix`, 1 to 64 hex characters. */
  files(prefix: string): Promise<NativeOutputEntry[]>;
  /** An output by its listed entry, when it and its meta are both there. */
  read(entry: NativeOutputEntry): Promise<StoredNativeOutput | undefined>;
  delete(key: NativeOutputKey): Promise<boolean>;
}

const gzipAsync = promisify(gzip);

const sha256Pattern = /^[0-9a-f]{64}$/;
const outputSuffix = '.json.gz';
const metaSuffix = '.meta.json';

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
};

export const canonicalJson = (value: unknown) => JSON.stringify(canonical(value));

export const settingsHash = (settings: Settings) =>
  createHash('sha256').update(canonicalJson(settings)).digest('hex');

const checkSha256 = (sha256: string) => {
  if (!sha256Pattern.test(sha256))
    throw new BlobError('bad_key', 'a file sha256 is 64 lowercase hex characters');
};

export const nativeOutputEntry = (key: NativeOutputKey): NativeOutputEntry => {
  checkSha256(key.sha256);
  for (const segment of [key.converter, key.version]) {
    if (segment.includes('/')) throw new BlobError('bad_key', `not a path segment: ${segment}`);
    checkPath(segment);
  }
  const folder = `${key.sha256}/${key.converter}/${key.version}`;
  const hash = settingsHash(key.settings);
  return {
    sha256: key.sha256,
    converter: key.converter,
    version: key.version,
    settingsHash: hash,
    path: `${folder}/${hash}${outputSuffix}`,
    metaPath: `${folder}/${hash}${metaSuffix}`,
  };
};

const entryFromPath = (path: string): NativeOutputEntry | undefined => {
  const [sha256, converter, version, file, ...rest] = path.split('/');
  if (rest.length || !sha256 || !converter || !version || !file?.endsWith(outputSuffix)) return;
  const hash = file.slice(0, -outputSuffix.length);
  const folder = `${sha256}/${converter}/${version}`;
  return {
    sha256,
    converter,
    version,
    settingsHash: hash,
    path,
    metaPath: `${folder}/${hash}${metaSuffix}`,
  };
};

const readEntry = async (
  container: NativeOutputContainer,
  entry: NativeOutputEntry,
): Promise<StoredNativeOutput | undefined> => {
  const [zipped, meta] = await Promise.all([
    container.read(entry.path),
    container.read(entry.metaPath),
  ]);
  if (!zipped || !meta) return undefined;
  return {
    entry,
    output: new Uint8Array(gunzipSync(zipped)),
    meta: JSON.parse(new TextDecoder().decode(meta)) as NativeOutputMeta,
  };
};

export const nativeOutputStore = (
  container: NativeOutputContainer,
  now: () => Date = () => new Date(),
): NativeOutputStore => ({
  put: async (key, output, pages, when) => {
    const entry = nativeOutputEntry(key);
    const meta: NativeOutputMeta = {
      converter: key.converter,
      version: key.version,
      settings: canonical(key.settings) as Settings,
      pages,
      when: when ?? now().toISOString(),
    };
    // The meta goes first, so a listed output always has its meta beside it.
    await container.write(
      entry.metaPath,
      new TextEncoder().encode(JSON.stringify(meta)),
      'application/json',
    );
    const zipped = await gzipAsync(output);
    await container.write(entry.path, zipped, 'application/gzip');
    return { ...entry, bytes: zipped.byteLength };
  },
  get: (key) => readEntry(container, nativeOutputEntry(key)),
  list: async (sha256) => {
    checkSha256(sha256);
    return (await container.list(`${sha256}/`))
      .map(entryFromPath)
      .filter((e): e is NativeOutputEntry => e !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
  },
  files: async (prefix) => {
    if (!/^[0-9a-f]{1,64}$/.test(prefix))
      throw new BlobError('bad_key', 'a sha256 prefix is 1 to 64 lowercase hex characters');
    return (await container.list(prefix))
      .map(entryFromPath)
      .filter((e): e is NativeOutputEntry => e !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
  },
  read: (entry) => readEntry(container, entry),
  delete: async (key) => {
    const entry = nativeOutputEntry(key);
    const removed = await container.remove(entry.path);
    await container.remove(entry.metaPath);
    return removed;
  },
});

export class InMemoryNativeOutputContainer implements NativeOutputContainer {
  readonly blobs = new Map<string, { body: Uint8Array; contentType: string }>();

  async write(path: string, body: Uint8Array, contentType: string) {
    this.blobs.set(path, { body: new Uint8Array(body), contentType });
  }

  async read(path: string) {
    const found = this.blobs.get(path);
    return found && new Uint8Array(found.body);
  }

  async list(prefix: string) {
    return [...this.blobs.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  async remove(path: string) {
    return this.blobs.delete(path);
  }
}

export class FileSystemNativeOutputContainer implements NativeOutputContainer {
  constructor(private readonly root: string) {}

  #file(path: string) {
    checkPath(path);
    return join(this.root, ...path.split('/'));
  }

  async write(path: string, body: Uint8Array) {
    const file = this.#file(path);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, file);
  }

  async read(path: string) {
    try {
      return new Uint8Array(await readFile(this.#file(path)));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(prefix: string) {
    checkPath(prefix, { folder: true });
    const walk = async (dir: string, at: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return [];
        throw error;
      }
      const nested = await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name), `${at}${e.name}/`)
            : Promise.resolve(e.name.endsWith('.tmp') ? [] : [`${at}${e.name}`]),
        ),
      );
      return nested.flat();
    };
    // A prefix that is not a whole folder name matches as Blob does: by the start of the path.
    const folder = prefix.endsWith('/')
      ? prefix.slice(0, -1)
      : prefix.split('/').slice(0, -1).join('/');
    const start = folder ? join(this.root, ...folder.split('/')) : this.root;
    return (await walk(start, folder ? `${folder}/` : ''))
      .filter((path) => path.startsWith(prefix))
      .sort();
  }

  async remove(path: string) {
    const file = this.#file(path);
    const existed = await stat(file).then(
      () => true,
      () => false,
    );
    await rm(file, { force: true });
    return existed;
  }
}
