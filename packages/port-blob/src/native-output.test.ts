import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileSystemNativeOutputContainer,
  nativeOutputStore,
  InMemoryNativeOutputContainer,
  settingsHash,
  type NativeOutputContainer,
} from './native-output.js';

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

  const docling = (sha256: string) => ({
    sha256,
    converter: 'docling',
    version: '2.123.1',
    settings: { ocr: 'easyocr', languages: ['no', 'en'] },
  });
  const containers: [
    string,
    () => Promise<{ container: NativeOutputContainer; done(): Promise<void> }>,
  ][] = [
    [
      'in memory',
      async () => ({ container: new InMemoryNativeOutputContainer(), done: async () => {} }),
    ],
    [
      'in a folder',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'native-output-'));
        return {
          container: new FileSystemNativeOutputContainer(root),
          done: () => rm(root, { recursive: true, force: true }),
        };
      },
    ],
  ];

  for (const [where, open] of containers) {
    it(`lists the outputs of every file whose sha256 starts with a prefix, ${where}`, async () => {
      const { container, done } = await open();
      try {
        const store = nativeOutputStore(container);
        const bytes = new TextEncoder().encode('{}');
        for (const sha256 of ['3f'.padEnd(64, 'a'), '3f'.padEnd(64, 'b'), '40'.padEnd(64, 'a')])
          await store.put(docling(sha256), bytes, 1);

        expect((await store.files('3f')).map((e) => e.sha256)).toEqual([
          '3f'.padEnd(64, 'a'),
          '3f'.padEnd(64, 'b'),
        ]);
        expect(await store.files('4')).toHaveLength(1);
        await expect(store.files('3F')).rejects.toThrow('hex');
      } finally {
        await done();
      }
    });
  }

  it('reads an output by its listed entry, with its meta', async () => {
    const store = nativeOutputStore(new InMemoryNativeOutputContainer());
    const output = new TextEncoder().encode('{"schema_name":"DoclingDocument"}');
    await store.put(docling('c'.repeat(64)), output, 3);

    const [entry] = await store.files('cc');
    const found = entry && (await store.read(entry));
    expect(found?.output).toEqual(output);
    expect(found?.meta).toMatchObject({
      converter: 'docling',
      pages: 3,
      settings: docling('').settings,
    });
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
