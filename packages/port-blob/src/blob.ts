import { createHash } from 'node:crypto';

export interface BlobKey {
  tenant: string;
  path: string;
}

export interface BlobInfo extends BlobKey {
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface StoredBlob {
  info: BlobInfo;
  body: Uint8Array;
}

export interface BlobStore {
  put(key: BlobKey, body: Uint8Array, contentType: string): Promise<BlobInfo>;
  get(key: BlobKey): Promise<StoredBlob | undefined>;
  head(key: BlobKey): Promise<BlobInfo | undefined>;
  list(tenant: string, prefix?: string): Promise<BlobInfo[]>;
  delete(key: BlobKey): Promise<boolean>;
}

export type BlobErrorCode = 'bad_key' | 'too_large' | 'bad_type' | 'not_found' | 'forbidden';

export class BlobError extends Error {
  constructor(
    readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

const tenantPattern = /^\d{9}$/;
const segmentPattern = /^[A-Za-z0-9æøåÆØÅ][A-Za-z0-9æøåÆØÅ._-]*$/;

export const checkTenant = (tenant: string) => {
  if (!tenantPattern.test(tenant))
    throw new BlobError('bad_key', 'a tenant is a 9-digit org number');
};

export const checkPath = (path: string, { folder = false } = {}) => {
  const trimmed = folder ? path.replace(/\/$/, '') : path;
  if (trimmed === '' && folder) return;
  if (trimmed.length > 512) throw new BlobError('bad_key', 'a blob path is at most 512 characters');
  const segments = trimmed.split('/');
  if (segments.some((s) => !segmentPattern.test(s) || s === '.' || s === '..'))
    throw new BlobError('bad_key', `not a valid blob path: ${path}`);
};

export const checkKey = (key: BlobKey) => {
  checkTenant(key.tenant);
  checkPath(key.path);
};

export const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

export interface BlobLimits {
  maxBytes: number;
  contentTypes?: string[];
}

const typeAllowed = (contentType: string, allowed: string[]) =>
  allowed.some((a) =>
    a.endsWith('/*') ? contentType.startsWith(a.slice(0, -1)) : contentType.split(';')[0] === a,
  );

export const limited = (store: BlobStore, limits: BlobLimits): BlobStore => ({
  ...store,
  put: async (key, body, contentType) => {
    if (body.byteLength > limits.maxBytes)
      throw new BlobError('too_large', `blobs are limited to ${limits.maxBytes} bytes`);
    if (limits.contentTypes && !typeAllowed(contentType, limits.contentTypes))
      throw new BlobError('bad_type', `content type ${contentType} is not accepted`);
    return store.put(key, body, contentType);
  },
  get: (key) => store.get(key),
  head: (key) => store.head(key),
  list: (tenant, prefix) => store.list(tenant, prefix),
  delete: (key) => store.delete(key),
});
