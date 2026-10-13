import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PortContext } from '@genai/kernel';
import {
  BlobError,
  BlobPortProvider,
  FileSystemBlobStore,
  InMemoryBlobStore,
  blobFolderKind,
  blobKeyOf,
  blobPart,
  crc32,
  docxBytes,
  jsonArtifact,
  limited,
  observable,
  partText,
  pollFolder,
  sha256,
  type BlobStore,
} from './index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tenant = '991825827';
const other = '889640782';
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const stores: [string, () => Promise<BlobStore>][] = [
  ['memory', async () => new InMemoryBlobStore(() => new Date('2026-10-06T10:00:00Z'))],
  [
    'filesystem',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'blob-'));
      dirs.push(dir);
      return new FileSystemBlobStore(dir, () => new Date('2026-10-06T10:00:00Z'));
    },
  ],
];

describe.each(stores)('%s blob store', (_name, make) => {
  it('stores, reads, lists by prefix and deletes, with size and SHA-256', async () => {
    const store = await make();
    const body = encoder.encode('Vedtak om tilskudd');
    const info = await store.put({ tenant, path: 'innboks/brev-1.txt' }, body, 'text/plain');
    await store.put({ tenant, path: 'innboks/brev-2.txt' }, encoder.encode('To'), 'text/plain');
    await store.put(
      { tenant, path: 'resultater/a.json' },
      encoder.encode('{}'),
      'application/json',
    );

    expect(info).toMatchObject({
      size: body.byteLength,
      sha256: sha256(body),
      contentType: 'text/plain',
    });
    expect(decoder.decode((await store.get({ tenant, path: 'innboks/brev-1.txt' }))?.body)).toBe(
      'Vedtak om tilskudd',
    );
    expect((await store.list(tenant, 'innboks/')).map((i) => i.path)).toEqual([
      'innboks/brev-1.txt',
      'innboks/brev-2.txt',
    ]);
    expect(await store.delete({ tenant, path: 'innboks/brev-1.txt' })).toBe(true);
    expect(await store.get({ tenant, path: 'innboks/brev-1.txt' })).toBeUndefined();
    expect(await store.delete({ tenant, path: 'innboks/brev-1.txt' })).toBe(false);
  });

  it('keeps tenants apart', async () => {
    const store = await make();
    await store.put({ tenant, path: 'a.txt' }, encoder.encode('x'), 'text/plain');

    expect(await store.list(other)).toEqual([]);
    expect(await store.get({ tenant: other, path: 'a.txt' })).toBeUndefined();
  });

  it.each(['../escape.txt', '/abs.txt', 'a//b.txt', 'a/./b.txt', ''])(
    'refuses the path %j',
    async (path) => {
      const store = await make();
      await expect(
        store.put({ tenant, path }, encoder.encode('x'), 'text/plain'),
      ).rejects.toMatchObject({ code: 'bad_key' });
    },
  );
});

describe('limits', () => {
  it('refuses a blob that is too large or of a type that is not accepted', async () => {
    const store = limited(new InMemoryBlobStore(), { maxBytes: 4, contentTypes: ['text/*'] });

    await expect(
      store.put({ tenant, path: 'a.txt' }, encoder.encode('12345'), 'text/plain'),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    await expect(
      store.put({ tenant, path: 'a.exe' }, encoder.encode('1'), 'application/octet-stream'),
    ).rejects.toMatchObject({
      code: 'bad_type',
    });
    await expect(
      store.put({ tenant, path: 'a.txt' }, encoder.encode('1234'), 'text/plain; charset=utf-8'),
    ).resolves.toBeDefined();
  });
});

const context = (forTenant = tenant): PortContext => ({
  tenant: forTenant,
  principal: { kind: 'agency-system', issuer: 'test', subject: 'worker', tenant: forTenant },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
});

describe('blob port', () => {
  it('confines a capability to its granted folder', async () => {
    const store = new InMemoryBlobStore();
    await store.put({ tenant, path: 'hemmelig/notat.txt' }, encoder.encode('x'), 'text/plain');
    const port = new BlobPortProvider(store).open(
      { kind: blobFolderKind, id: 'klarsprak', tenant },
      context(),
    );

    await port.put('innboks/brev.txt', encoder.encode('Hei'), 'text/plain');

    expect((await port.list()).map((i) => i.path)).toEqual(['innboks/brev.txt']);
    expect(await store.head({ tenant, path: 'klarsprak/innboks/brev.txt' })).toBeDefined();
    await expect(port.get('../hemmelig/notat.txt')).rejects.toBeInstanceOf(BlobError);
  });
});

describe('parts and artifacts', () => {
  it('turns an upload into a blob part and reads text back for the same tenant only', async () => {
    const store = new InMemoryBlobStore();
    const info = await store.put(
      { tenant, path: 'innboks/brev.txt' },
      encoder.encode('Søknad om støtte'),
      'text/plain',
    );
    const part = blobPart(info);

    expect(blobKeyOf(part)).toEqual({ tenant, path: 'innboks/brev.txt' });
    expect(await partText(store, part, tenant)).toBe('Søknad om støtte');
    await expect(partText(store, part, other)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('writes a JSON artifact and returns it as a part', async () => {
    const store = new InMemoryBlobStore();
    const part = await jsonArtifact(store, { tenant, path: 'resultater/r.json' }, { ok: true });

    expect(part.mime).toBe('application/json');
    expect(JSON.parse((await partText(store, part, tenant)) ?? '')).toEqual({ ok: true });
  });

  it('writes a DOCX whose zip entries and checksums are valid', () => {
    const zip = docxBytes(['Første avsnitt', 'Andre <avsnitt> & mer']);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries: Record<string, string> = {};
    let at = 0;
    while (view.getUint32(at, true) === 0x04034b50) {
      const crc = view.getUint32(at + 14, true);
      const size = view.getUint32(at + 18, true);
      const nameLength = view.getUint16(at + 26, true);
      const name = decoder.decode(zip.slice(at + 30, at + 30 + nameLength));
      const data = zip.slice(at + 30 + nameLength, at + 30 + nameLength + size);
      expect(crc32(data)).toBe(crc);
      entries[name] = decoder.decode(data);
      at += 30 + nameLength + size;
    }

    expect(Object.keys(entries)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    expect(entries['word/document.xml']).toContain('Andre &lt;avsnitt&gt; &amp; mer');
    expect(view.getUint32(zip.byteLength - 22, true)).toBe(0x06054b50);
  });
});

describe('watching a folder', () => {
  it('tells listeners about new blobs in their folder only', async () => {
    const store = observable(new InMemoryBlobStore());
    const seen: string[] = [];
    store.onPut(tenant, 'innboks/', (i) => {
      seen.push(i.path);
    });

    await store.put({ tenant, path: 'innboks/a.txt' }, encoder.encode('a'), 'text/plain');
    await store.put({ tenant, path: 'utboks/b.txt' }, encoder.encode('b'), 'text/plain');
    await store.put({ tenant: other, path: 'innboks/c.txt' }, encoder.encode('c'), 'text/plain');

    expect(seen).toEqual(['innboks/a.txt']);
  });

  it('finds files written behind its back by polling, once per content', async () => {
    const store = new InMemoryBlobStore();
    const seen: string[] = [];
    const watcher = pollFolder(
      store,
      tenant,
      'innboks/',
      (i) => {
        seen.push(i.path);
      },
      { timers: false },
    );

    await store.put({ tenant, path: 'innboks/a.txt' }, encoder.encode('a'), 'text/plain');
    await watcher.poll();
    await watcher.poll();
    await store.put({ tenant, path: 'innboks/a.txt' }, encoder.encode('changed'), 'text/plain');
    await watcher.poll();

    expect(seen).toEqual(['innboks/a.txt', 'innboks/a.txt']);
  });
});
