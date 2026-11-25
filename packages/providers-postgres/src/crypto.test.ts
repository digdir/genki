import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { LocalKeyWrapper, open, seal, sealTagged } from './crypto.js';

const first = Buffer.alloc(32, 1);
const second = Buffer.alloc(32, 2);
const third = Buffer.alloc(32, 3);
const b64 = (key: Buffer) => key.toString('base64');

const legacyWrap = (kek: Buffer, key: Buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from('content-key'));
  const body = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
};

describe('content master keys', () => {
  it('opens a content key wrapped before keys had versions, as version 1', async () => {
    const key = randomBytes(32);
    const wrapped = legacyWrap(first, key);
    const wrapper = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: b64(first),
      CONTENT_MASTER_KEY_2: b64(second),
    });
    expect(wrapper.versionOf(wrapped)).toBe(1);
    expect(await wrapper.unwrap(wrapped)).toEqual(key);
  });

  it('opens a value sealed before values had tags', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('row'));
    const body = Buffer.concat([cipher.update('hemmelig'), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]);
    expect(open(key, sealed, 'row').toString()).toBe('hemmelig');
  });

  it('wraps a new content key with the newest master key and tags it with that version', async () => {
    const wrapper = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: b64(first),
      CONTENT_MASTER_KEY_3: b64(third),
      CONTENT_MASTER_KEY_2: b64(second),
    });
    const wrapped = await wrapper.wrap(randomBytes(32));
    expect(wrapper.active).toBe(3);
    expect(wrapper.versionOf(wrapped)).toBe(3);
    expect(wrapped.subarray(0, 5)).toEqual(Buffer.from([0x47, 0x4b, 1, 0, 3]));
    const withoutThird = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: b64(first),
      CONTENT_MASTER_KEY_2: b64(second),
    });
    await expect(withoutThird.unwrap(wrapped)).rejects.toThrow('version 3');
  });

  it('wraps with version 1 in the untagged form, so a revision from before versions can still open it', async () => {
    const wrapper = new LocalKeyWrapper(first);
    const key = randomBytes(32);
    const wrapped = await wrapper.wrap(key);
    expect(wrapped).toHaveLength(60);
    const decipher = createDecipheriv('aes-256-gcm', first, wrapped.subarray(0, 12));
    decipher.setAAD(Buffer.from('content-key'));
    decipher.setAuthTag(wrapped.subarray(12, 28));
    expect(Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])).toEqual(key);
  });

  it('wraps with the version CONTENT_MASTER_KEY_ACTIVE names while a newer key is only for opening', async () => {
    const wrapper = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: b64(first),
      CONTENT_MASTER_KEY_2: b64(second),
      CONTENT_MASTER_KEY_ACTIVE: '1',
    });
    expect(wrapper.versionOf(await wrapper.wrap(randomBytes(32)))).toBe(1);
  });

  it('opens a content key with any listed master key', async () => {
    const key = randomBytes(32);
    const byTwo = await new LocalKeyWrapper([{ version: 2, key: second }]).wrap(key);
    const byOne = await new LocalKeyWrapper(first).wrap(key);
    const both = new LocalKeyWrapper([
      { version: 1, key: first },
      { version: 2, key: second },
    ]);
    expect(await both.unwrap(byTwo)).toEqual(key);
    expect(await both.unwrap(byOne)).toEqual(key);
  });

  it('refuses to open a content key whose master key was removed, naming the missing version', async () => {
    const wrapped = await new LocalKeyWrapper(first).wrap(randomBytes(32));
    const onlySecond = LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY_2: b64(second) });
    await expect(onlySecond.unwrap(wrapped)).rejects.toThrow(
      'the content key is wrapped with master key version 1, which is not set',
    );
  });

  it('fails closed when a wrapped key’s version tag is changed to another listed version', async () => {
    const both = new LocalKeyWrapper([
      { version: 1, key: first },
      { version: 2, key: second },
      { version: 3, key: third },
    ]);
    const wrapped = await new LocalKeyWrapper([{ version: 2, key: second }]).wrap(randomBytes(32));
    const relabelled = Buffer.from(wrapped);
    relabelled.writeUInt16BE(3, 3);
    await expect(both.unwrap(relabelled)).rejects.toThrow('unable to authenticate');
    const same = Buffer.from(wrapped);
    same.writeUInt16BE(1, 3);
    await expect(both.unwrap(same)).rejects.toThrow('unable to authenticate');
  });

  it('fails closed on a wrapped key with an unknown format or a broken tag', async () => {
    const wrapper = new LocalKeyWrapper([{ version: 2, key: second }]);
    const wrapped = await wrapper.wrap(randomBytes(32));
    const format = Buffer.from(wrapped);
    format[2] = 2;
    await expect(wrapper.unwrap(format)).rejects.toThrow('not a wrapped content key');
    const magic = Buffer.from(wrapped);
    magic[0] = 0;
    await expect(wrapper.unwrap(magic)).rejects.toThrow('not a wrapped content key');
    const zero = Buffer.from(wrapped);
    zero.writeUInt16BE(0, 3);
    await expect(wrapper.unwrap(zero)).rejects.toThrow('not a wrapped content key');
    await expect(wrapper.unwrap(wrapped.subarray(0, 64))).rejects.toThrow(
      'not a wrapped content key',
    );
    const body = Buffer.from(wrapped);
    body[40] = (body[40] ?? 0) ^ 1;
    await expect(wrapper.unwrap(body)).rejects.toThrow('unable to authenticate');
  });

  it('fails closed when a tagged value’s tag is changed', () => {
    const key = randomBytes(32);
    const sealed = sealTagged(key, 2, Buffer.from('hemmelig'), 'row');
    expect(open(key, sealed, 'row').toString()).toBe('hemmelig');
    const changed = Buffer.from(sealed);
    changed.writeUInt16BE(1, 3);
    expect(() => open(key, changed, 'row')).toThrow('unable to authenticate');
    expect(() => open(key, sealed, 'other row')).toThrow('unable to authenticate');
  });

  it('opens an untagged value whose first bytes happen to look like a tag', () => {
    const key = randomBytes(32);
    const iv = Buffer.concat([Buffer.from([0x47, 0x4b, 1]), randomBytes(9)]);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('row'));
    const body = Buffer.concat([cipher.update('hemmelig'), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]);
    expect(open(key, sealed, 'row').toString()).toBe('hemmelig');
  });

  it('refuses a value whose authentication tag is cut short', () => {
    const key = randomBytes(32);
    const sealed = seal(key, Buffer.alloc(0), 'row');
    expect(() => open(key, sealed.subarray(0, 20), 'row')).toThrow('too short');
  });

  it('refuses master keys that are not 32 bytes of base64, without echoing them', () => {
    const short = b64(Buffer.alloc(16, 7));
    expect(() => LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY: short })).toThrow(
      /^CONTENT_MASTER_KEY must be 32 bytes in base64$/,
    );
    expect(() => LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY_2: `${b64(first)}!` })).toThrow(
      /^CONTENT_MASTER_KEY_2 must be base64$/,
    );
    expect(() => new LocalKeyWrapper(Buffer.alloc(31))).toThrow('32 bytes');
  });

  it('refuses to wrap a content key that is not 32 bytes', async () => {
    await expect(new LocalKeyWrapper(first).wrap(randomBytes(16))).rejects.toThrow('32 bytes');
  });

  it('refuses to start without a master key', () => {
    expect(() => LocalKeyWrapper.fromEnv({})).toThrow('CONTENT_MASTER_KEY is not set');
    expect(() => LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY: ' ' })).toThrow(
      'CONTENT_MASTER_KEY is not set',
    );
  });

  it('refuses a master key setting whose name is not a version from 2 to 65535', () => {
    for (const name of [
      'CONTENT_MASTER_KEY_1',
      'CONTENT_MASTER_KEY_02',
      'CONTENT_MASTER_KEY_65536',
      'CONTENT_MASTER_KEY_NEW',
    ])
      expect(() => LocalKeyWrapper.fromEnv({ [name]: b64(first) })).toThrow(
        'is not a master key setting',
      );
    expect(LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY_65535: b64(first) }).active).toBe(65535);
  });

  it('refuses the same key under two versions', () => {
    expect(() =>
      LocalKeyWrapper.fromEnv({ CONTENT_MASTER_KEY: b64(first), CONTENT_MASTER_KEY_2: b64(first) }),
    ).toThrow('is the same key as version 1');
  });

  it('refuses CONTENT_MASTER_KEY_ACTIVE unless it names a version whose key is set', () => {
    const env = { CONTENT_MASTER_KEY: b64(first) };
    expect(() => LocalKeyWrapper.fromEnv({ ...env, CONTENT_MASTER_KEY_ACTIVE: '2' })).toThrow(
      'names version 2, whose key is not set',
    );
    expect(() => LocalKeyWrapper.fromEnv({ ...env, CONTENT_MASTER_KEY_ACTIVE: 'two' })).toThrow(
      'must be a master key version',
    );
  });

  it('never shows key material when the wrapper is printed, serialised or fails', async () => {
    const wrapper = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: b64(first),
      CONTENT_MASTER_KEY_2: b64(second),
    });
    const shown = [inspect(wrapper, { depth: 5, showHidden: true }), JSON.stringify(wrapper)];
    const foreign = await new LocalKeyWrapper([{ version: 9, key: third }]).wrap(randomBytes(32));
    const errors = await Promise.all(
      [foreign, Buffer.alloc(60), Buffer.alloc(7)].map((value) =>
        wrapper.unwrap(value).then(
          () => '',
          (error: unknown) => String(error),
        ),
      ),
    );
    for (const text of [...shown, ...errors])
      for (const key of [first, second, third]) {
        expect(text).not.toContain(b64(key));
        expect(text).not.toContain(key.toString('hex'));
      }
    expect(errors.every((text) => text.length > 0)).toBe(true);
  });
});
