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

describe('nativeOutputStore put', () => {
  const key = { sha256: 'b'.repeat(64), converter: 'docling', version: '2.123.1', settings: {} };

  it('a native output keeps the time its converter finished, when given', async () => {
    const store = nativeOutputStore(
      new InMemoryNativeOutputContainer(),
      () => new Date('2026-11-12T00:00:00Z'),
    );
    await store.put(key, new TextEncoder().encode('{}'), 9, '2026-08-28T17:47:10Z');
    expect((await store.get(key))?.meta.when).toBe('2026-08-28T17:47:10Z');
  });

  it('put reports the gzipped bytes it wrote', async () => {
    const container = new InMemoryNativeOutputContainer();
    const entry = await nativeOutputStore(container).put(
      key,
      new TextEncoder().encode('{"a":1}'.repeat(100)),
      1,
    );
    expect(entry.bytes).toBe((await container.read(entry.path))?.byteLength);
  });
});
