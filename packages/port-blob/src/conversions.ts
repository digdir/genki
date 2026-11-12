import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BlobError, checkPath } from './blob.js';

export type Settings = { readonly [key: string]: unknown };

export interface ConversionKey {
  sha256: string;
  converter: string;
  version: string;
  settings: Settings;
}

export interface ConversionMeta {
  converter: string;
  version: string;
  settings: Settings;
  pages: number;
  when: string;
}

export interface ConversionEntry {
  sha256: string;
  converter: string;
  version: string;
  settingsHash: string;
  path: string;
  metaPath: string;
}

export interface StoredConversion {
  entry: ConversionEntry;
  output: Uint8Array;
  meta: ConversionMeta;
}

/** A blob container with no tenant: paths are the whole key. */
export interface ConversionContainer {
  write(path: string, body: Uint8Array, contentType: string): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
  remove(path: string): Promise<boolean>;
}

export interface ConversionStore {
  put(key: ConversionKey, output: Uint8Array, pages: number): Promise<ConversionEntry>;
  get(key: ConversionKey): Promise<StoredConversion | undefined>;
  list(sha256: string): Promise<ConversionEntry[]>;
  delete(key: ConversionKey): Promise<boolean>;
}

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

export const conversionEntry = (key: ConversionKey): ConversionEntry => {
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

const entryFromPath = (path: string): ConversionEntry | undefined => {
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

export const conversionStore = (
  container: ConversionContainer,
  now: () => Date = () => new Date(),
): ConversionStore => ({
  put: async (key, output, pages) => {
    const entry = conversionEntry(key);
    const meta: ConversionMeta = {
      converter: key.converter,
      version: key.version,
      settings: canonical(key.settings) as Settings,
      pages,
      when: now().toISOString(),
    };
    await container.write(entry.path, gzipSync(output), 'application/gzip');
    await container.write(
      entry.metaPath,
      new TextEncoder().encode(JSON.stringify(meta)),
      'application/json',
    );
    return entry;
  },
  get: async (key) => {
    const entry = conversionEntry(key);
    const [zipped, meta] = await Promise.all([
      container.read(entry.path),
      container.read(entry.metaPath),
    ]);
    if (!zipped || !meta) return undefined;
    return {
      entry,
      output: new Uint8Array(gunzipSync(zipped)),
      meta: JSON.parse(new TextDecoder().decode(meta)) as ConversionMeta,
    };
  },
  list: async (sha256) => {
    checkSha256(sha256);
    return (await container.list(`${sha256}/`))
      .map(entryFromPath)
      .filter((e): e is ConversionEntry => e !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
  },
  delete: async (key) => {
    const entry = conversionEntry(key);
    const removed = await container.remove(entry.path);
    await container.remove(entry.metaPath);
    return removed;
  },
});

export class InMemoryConversionContainer implements ConversionContainer {
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

export class FileSystemConversionContainer implements ConversionContainer {
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
    const folder = prefix.replace(/\/$/, '');
    const start = folder ? join(this.root, ...folder.split('/')) : this.root;
    return (await walk(start, folder ? `${folder}/` : '')).sort();
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
