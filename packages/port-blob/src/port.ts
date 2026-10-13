import type { Ref } from '@genai/contracts';
import type { PortContext, PortProvider } from '@genai/kernel';
import { BlobError, checkPath, type BlobInfo, type BlobStore, type StoredBlob } from './blob.js';

export const blobFolderKind = 'blob-folder';

export interface BlobPort {
  folder(): { tenant: string; prefix: string };
  put(path: string, body: Uint8Array, contentType: string): Promise<BlobInfo>;
  get(path: string): Promise<StoredBlob | undefined>;
  list(subfolder?: string): Promise<BlobInfo[]>;
  delete(path: string): Promise<boolean>;
}

export class BlobPortProvider implements PortProvider<BlobPort> {
  constructor(private readonly store: BlobStore) {}

  open(ref: Ref, ctx: PortContext): BlobPort {
    if (ref.kind !== blobFolderKind)
      throw new BlobError('bad_key', `not a blob folder: ${ref.kind}`);
    const tenant = ref.tenant ?? ctx.tenant;
    const prefix = ref.id.endsWith('/') || ref.id === '' ? ref.id : `${ref.id}/`;
    checkPath(prefix, { folder: true });
    const inside = (path: string) => {
      checkPath(path);
      return { tenant, path: `${prefix}${path}` };
    };
    const strip = (info: BlobInfo): BlobInfo => ({ ...info, path: info.path.slice(prefix.length) });
    return {
      folder: () => ({ tenant, prefix }),
      put: async (path, body, contentType) =>
        strip(await this.store.put(inside(path), body, contentType)),
      get: async (path) => {
        const found = await this.store.get(inside(path));
        return found && { info: strip(found.info), body: found.body };
      },
      list: async (subfolder = '') => {
        if (subfolder) checkPath(subfolder, { folder: true });
        return (await this.store.list(tenant, `${prefix}${subfolder}`)).map(strip);
      },
      delete: (path) => this.store.delete(inside(path)),
    };
  }
}
