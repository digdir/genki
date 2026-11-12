import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nativeOutputStore, InMemoryNativeOutputContainer, settingsHash } from './native-output.js';

describe('settingsHash', () => {
  it('the settings hash is the sha256 of the settings as canonical JSON, whatever their key order', () => {
    const a = settingsHash({
      ocr: 'tesseract',
      lang: 'nor',
      table: { mode: 'accurate', cells: true },
    });
    const b = settingsHash({
      table: { cells: true, mode: 'accurate' },
      lang: 'nor',
      ocr: 'tesseract',
    });
    expect(a).toBe(b);
    expect(a).toBe(
      createHash('sha256')
        .update('{"lang":"nor","ocr":"tesseract","table":{"cells":true,"mode":"accurate"}}')
        .digest('hex'),
    );
    expect(settingsHash({ lang: ['no', 'en'] })).not.toBe(settingsHash({ lang: ['en', 'no'] }));
  });
});

describe('nativeOutputStore', () => {
  it('a native output whose meta.json could not be written is not listed', async () => {
    const inner = new InMemoryNativeOutputContainer();
    const failingMeta = {
      ...inner,
      write: async (path: string, body: Uint8Array, contentType: string) => {
        if (path.endsWith('.meta.json')) throw new Error('write failed');
        return inner.write(path, body, contentType);
      },
      read: (path: string) => inner.read(path),
      list: (prefix: string) => inner.list(prefix),
      remove: (path: string) => inner.remove(path),
    };
    const store = nativeOutputStore(failingMeta);
    const key = { sha256: 'a'.repeat(64), converter: 'docling', version: '2.123.1', settings: {} };
    await expect(store.put(key, new TextEncoder().encode('{}'), 1)).rejects.toThrow('write failed');
    expect(await store.list(key.sha256)).toEqual([]);
  });
});
