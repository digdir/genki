import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyWrapper {
  wrap(key: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

export interface MasterKey {
  version: number;
  key: Buffer;
}

const IV = 12;
const TAG = 16;
const KEY = 32;
const MAGIC = [0x47, 0x4b];
const AES_256_GCM = 1;
const HEADER = 5;
const MAX_VERSION = 0xffff;
const LEGACY_WRAPPED = IV + TAG + KEY;
const TAGGED_WRAPPED = HEADER + LEGACY_WRAPPED;
const WRAP_AAD = 'content-key';
const ENV = 'CONTENT_MASTER_KEY';
const ACTIVE_ENV = `${ENV}_ACTIVE`;

const gcmSeal = (key: Buffer, plaintext: Buffer, aad: Buffer): Buffer => {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
};

const gcmOpen = (key: Buffer, sealed: Buffer, aad: Buffer): Buffer => {
  if (sealed.length < IV + TAG) throw new Error('the sealed value is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV), {
    authTagLength: TAG,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()]);
};

const header = (version: number) =>
  Buffer.from([...MAGIC, AES_256_GCM, version >> 8, version & 0xff]);

const taggedVersion = (value: Buffer): number | undefined =>
  value.length > HEADER &&
  value[0] === MAGIC[0] &&
  value[1] === MAGIC[1] &&
  value[2] === AES_256_GCM
    ? value.readUInt16BE(3)
    : undefined;

const isVersion = (version: number) =>
  Number.isInteger(version) && version >= 1 && version <= MAX_VERSION;

export const seal = (key: Buffer, plaintext: Buffer, aad: string): Buffer =>
  gcmSeal(key, plaintext, Buffer.from(aad));

export const sealTagged = (key: Buffer, version: number, plaintext: Buffer, aad: string) => {
  if (!isVersion(version)) throw new Error('a key version is a whole number from 1 to 65535');
  const tag = header(version);
  return Buffer.concat([tag, gcmSeal(key, plaintext, Buffer.concat([tag, Buffer.from(aad)]))]);
};

const openTagged = (key: Buffer, sealed: Buffer, aad: string) =>
  gcmOpen(
    key,
    sealed.subarray(HEADER),
    Buffer.concat([sealed.subarray(0, HEADER), Buffer.from(aad)]),
  );
export const open = (key: Buffer, sealed: Buffer, aad: string): Buffer => {
  if (taggedVersion(sealed) === undefined) return gcmOpen(key, sealed, Buffer.from(aad));
  try {
    return openTagged(key, sealed, aad);
  } catch (error) {
    try {
      return gcmOpen(key, sealed, Buffer.from(aad));
    } catch {
      throw error;
    }
  }
};

const decodedKey = (name: string, value: string) => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error(`${name} must be base64`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY) throw new Error(`${name} must be ${KEY} bytes in base64`);
  return key;
};

const versionFromName = (name: string) => {
  const suffix = name.slice(ENV.length + 1);
  const version = Number(suffix);
  if (String(version) !== suffix || !isVersion(version) || version === 1)
    throw new Error(
      `${name} is not a master key setting: version 1 is ${ENV}, later ones ${ENV}_2 to ${ENV}_${MAX_VERSION}`,
    );
  return version;
};

export class LocalKeyWrapper implements KeyWrapper {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly active: number;

  constructor(keys: Buffer | readonly MasterKey[], active?: number) {
    const list = Buffer.isBuffer(keys) ? [{ version: 1, key: keys }] : keys;
    if (list.length === 0) throw new Error(`${ENV} is not set`);
    const map = new Map<number, Buffer>();
    for (const { version, key } of list) {
      if (!isVersion(version))
        throw new Error('a master key version is a whole number from 1 to 65535');
      if (key.length !== KEY) throw new Error('the master key must be 32 bytes');
      if (map.has(version)) throw new Error(`master key version ${version} is set twice`);
      const same = [...map].find(([, other]) => other.equals(key));
      if (same)
        throw new Error(`master key version ${version} is the same key as version ${same[0]}`);
      map.set(version, Buffer.from(key));
    }
    this.#keys = map;
    this.active = active ?? Math.max(...map.keys());
    if (!map.has(this.active))
      throw new Error(`the active master key version ${this.active} is not set`);
  }
  static fromEnv(env: Readonly<Record<string, string | undefined>>) {
    const keys: MasterKey[] = [];
    for (const [name, raw] of Object.entries(env)) {
      const value = raw?.trim();
      if (!value || name === ACTIVE_ENV) continue;
      if (name === ENV) keys.push({ version: 1, key: decodedKey(name, value) });
      else if (name.startsWith(`${ENV}_`))
        keys.push({ version: versionFromName(name), key: decodedKey(name, value) });
    }
    const active = env[ACTIVE_ENV]?.trim();
    if (!active) return new LocalKeyWrapper(keys);
    const version = Number(active);
    if (String(version) !== active || !isVersion(version))
      throw new Error(`${ACTIVE_ENV} must be a master key version from 1 to ${MAX_VERSION}`);
    if (!keys.some((key) => key.version === version))
      throw new Error(`${ACTIVE_ENV} names version ${version}, whose key is not set`);
    return new LocalKeyWrapper(keys, version);
  }

  get versions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b);
  }
  get wrappedForm(): { length: number; prefix: Buffer } {
    return this.active === 1
      ? { length: LEGACY_WRAPPED, prefix: Buffer.alloc(0) }
      : { length: TAGGED_WRAPPED, prefix: header(this.active) };
  }

  versionOf(wrapped: Buffer): number {
    if (wrapped.length === LEGACY_WRAPPED) return 1;
    const version = wrapped.length === TAGGED_WRAPPED ? taggedVersion(wrapped) : undefined;
    if (version === undefined || version === 0)
      throw new Error('the value is not a wrapped content key');
    return version;
  }

  async wrap(key: Buffer) {
    if (key.length !== KEY) throw new Error('a content key must be 32 bytes');
    const kek = this.#keys.get(this.active) as Buffer;
    return this.active === 1
      ? seal(kek, key, WRAP_AAD)
      : sealTagged(kek, this.active, key, WRAP_AAD);
  }

  async unwrap(wrapped: Buffer) {
    const version = this.versionOf(wrapped);
    const kek = this.#keys.get(version);
    if (!kek)
      throw new Error(
        `the content key is wrapped with master key version ${version}, which is not set`,
      );
    const key =
      wrapped.length === LEGACY_WRAPPED
        ? gcmOpen(kek, wrapped, Buffer.from(WRAP_AAD))
        : openTagged(kek, wrapped, WRAP_AAD);
    if (key.length !== KEY) throw new Error('the unwrapped content key is not 32 bytes');
    return key;
  }
}
