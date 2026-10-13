import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  checkKey,
  checkPath,
  checkTenant,
  sha256,
  type BlobInfo,
  type BlobKey,
  type BlobStore,
  type StoredBlob,
} from './blob.js';

export class FileSystemBlobStore implements BlobStore {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #data(key: BlobKey) {
    return join(this.root, key.tenant, 'data', ...key.path.split('/'));
  }

  #meta(key: BlobKey) {
    return join(this.root, key.tenant, 'meta', ...key.path.split('/')) + '.json';
  }

  async #atomic(file: string, body: Uint8Array | string) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, file);
  }

  async put(key: BlobKey, body: Uint8Array, contentType: string): Promise<BlobInfo> {
    checkKey(key);
    const info: BlobInfo = {
      tenant: key.tenant,
      path: key.path,
      contentType,
      size: body.byteLength,
      sha256: sha256(body),
      createdAt: this.now().toISOString(),
    };
    await this.#atomic(this.#data(key), body);
    await this.#atomic(this.#meta(key), JSON.stringify(info));
    return info;
  }

  async head(key: BlobKey): Promise<BlobInfo | undefined> {
    checkKey(key);
    try {
      return JSON.parse(await readFile(this.#meta(key), 'utf8')) as BlobInfo;
    } catch {
      return undefined;
    }
  }

  async get(key: BlobKey): Promise<StoredBlob | undefined> {
    const info = await this.head(key);
    if (!info) return undefined;
    try {
      return { info, body: new Uint8Array(await readFile(this.#data(key))) };
    } catch {
      return undefined;
    }
  }

  async list(tenant: string, prefix = ''): Promise<BlobInfo[]> {
    checkTenant(tenant);
    checkPath(prefix, { folder: true });
    const metaRoot = join(this.root, tenant, 'meta');
    const walk = async (dir: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const nested = await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name))
            : Promise.resolve(e.name.endsWith('.json') ? [join(dir, e.name)] : []),
        ),
      );
      return nested.flat();
    };
    const files = await walk(metaRoot);
    const infos = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(f, 'utf8')) as BlobInfo),
    );
    return infos
      .filter((i) => i.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(key: BlobKey): Promise<boolean> {
    checkKey(key);
    const existed = await stat(this.#meta(key)).then(
      () => true,
      () => false,
    );
    await rm(this.#data(key), { force: true });
    await rm(this.#meta(key), { force: true });
    return existed;
  }
}
