import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyWrapper {
  wrap(key: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

const IV = 12;
const TAG = 16;

export const seal = (key: Buffer, plaintext: Buffer, aad: string): Buffer => {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
};

export const open = (key: Buffer, sealed: Buffer, aad: string): Buffer => {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()]);
};

export class LocalKeyWrapper implements KeyWrapper {
  readonly #kek: Buffer;

  constructor(kek: Buffer) {
    if (kek.length !== 32) throw new Error('the master key must be 32 bytes');
    this.#kek = kek;
  }

  static fromBase64(value: string | undefined) {
    if (!value) throw new Error('CONTENT_MASTER_KEY is not set');
    return new LocalKeyWrapper(Buffer.from(value, 'base64'));
  }

  async wrap(key: Buffer) {
    return seal(this.#kek, key, 'content-key');
  }

  async unwrap(wrapped: Buffer) {
    return open(this.#kek, wrapped, 'content-key');
  }
}
