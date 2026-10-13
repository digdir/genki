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

export class InMemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, StoredBlob>();

  constructor(private readonly now: () => Date = () => new Date()) {}

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
    this.#blobs.set(`${key.tenant}/${key.path}`, { info, body: new Uint8Array(body) });
    return { ...info };
  }

  async get(key: BlobKey): Promise<StoredBlob | undefined> {
    checkKey(key);
    const found = this.#blobs.get(`${key.tenant}/${key.path}`);
    return found && { info: { ...found.info }, body: new Uint8Array(found.body) };
  }

  async head(key: BlobKey): Promise<BlobInfo | undefined> {
    return (await this.get(key))?.info;
  }

  async list(tenant: string, prefix = ''): Promise<BlobInfo[]> {
    checkTenant(tenant);
    checkPath(prefix, { folder: true });
    return [...this.#blobs.values()]
      .map((b) => ({ ...b.info }))
      .filter((i) => i.tenant === tenant && i.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(key: BlobKey): Promise<boolean> {
    checkKey(key);
    return this.#blobs.delete(`${key.tenant}/${key.path}`);
  }
}
