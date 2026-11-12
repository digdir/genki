import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  checkEqual,
  checkFailsWith,
  type ContractSuite,
  type ContractTarget,
} from '@genai/plugins';
import { gunzipSync } from 'node:zlib';
import { sha256, type BlobStore } from './blob.js';
import {
  nativeOutputStore,
  FileSystemNativeOutputContainer,
  InMemoryNativeOutputContainer,
  settingsHash,
  type NativeOutputContainer,
} from './native-output.js';
import { FileSystemBlobStore } from './filesystem.js';
import { InMemoryBlobStore } from './memory.js';

export const blobContractVersion = 'blob@1';

const tenant = '991825827';
const other = '889640782';
const text = (value: string) => new TextEncoder().encode(value);
const read = (body: Uint8Array | undefined) => (body ? new TextDecoder().decode(body) : undefined);

let runs = 0;
const folder = () => `kontrakt-${(runs += 1)}-${Date.now()}`;

export const blobContract: ContractSuite<BlobStore> = {
  contract: blobContractVersion,
  checks: [
    {
      name: 'put then get returns the bytes, type, size and checksum',
      run: async (store) => {
        const key = { tenant, path: `${folder()}/notat.txt` };
        const body = text('Søknad om tilskudd');
        const info = await store.put(key, body, 'text/plain');
        checkEqual(info.size, body.byteLength, 'size');
        checkEqual(info.sha256, sha256(body), 'checksum');
        const found = await store.get(key);
        checkEqual(read(found?.body), 'Søknad om tilskudd', 'body');
        checkEqual(found?.info.contentType, 'text/plain', 'content type');
        checkEqual((await store.head(key))?.size, body.byteLength, 'head size');
      },
    },
    {
      name: 'put on an existing path replaces it',
      run: async (store) => {
        const key = { tenant, path: `${folder()}/a.txt` };
        await store.put(key, text('først'), 'text/plain');
        await store.put(key, text('sist'), 'text/markdown');
        const found = await store.get(key);
        checkEqual(read(found?.body), 'sist', 'body');
        checkEqual(found?.info.contentType, 'text/markdown', 'content type');
      },
    },
    {
      name: 'list returns the blobs under a prefix and nothing outside it',
      run: async (store) => {
        const base = folder();
        await store.put({ tenant, path: `${base}/inne/b.txt` }, text('b'), 'text/plain');
        await store.put({ tenant, path: `${base}/inne/a.txt` }, text('a'), 'text/plain');
        await store.put({ tenant, path: `${base}/ute.txt` }, text('c'), 'text/plain');
        const listed = (await store.list(tenant, `${base}/inne/`)).map((b) => b.path).sort();
        checkEqual(listed, [`${base}/inne/a.txt`, `${base}/inne/b.txt`], 'listed paths');
      },
    },
    {
      name: 'delete removes a blob once and reports whether it existed',
      run: async (store) => {
        const key = { tenant, path: `${folder()}/slett.txt` };
        await store.put(key, text('x'), 'text/plain');
        checkEqual(await store.delete(key), true, 'first delete');
        checkEqual(await store.delete(key), false, 'second delete');
        checkEqual(await store.get(key), undefined, 'get after delete');
      },
    },
    {
      name: 'tenants never see each other',
      run: async (store) => {
        const path = `${folder()}/hemmelig.txt`;
        await store.put({ tenant, path }, text('x'), 'text/plain');
        checkEqual(await store.get({ tenant: other, path }), undefined, 'other tenant get');
        check(
          (await store.list(other)).every((b) => b.path !== path),
          'the other tenant does not list it',
        );
      },
    },
    {
      name: 'paths that escape the folder fail as bad_key',
      run: async (store) => {
        for (const path of ['../ut.txt', 'a/../../b.txt', '/abs.txt', ''])
          await checkFailsWith(
            () => store.put({ tenant, path }, text('x'), 'text/plain'),
            'bad_key',
            `path "${path}"`,
          );
        await checkFailsWith(
          () => store.put({ tenant: 'ikke-et-orgnr', path: 'a.txt' }, text('x'), 'text/plain'),
          'bad_key',
          'tenant',
        );
      },
    },
  ],
};

export const memoryBlobContractTarget = async (): Promise<ContractTarget<BlobStore>> => ({
  subject: new InMemoryBlobStore(),
});

export const fileSystemBlobContractTarget = async (): Promise<ContractTarget<BlobStore>> => {
  const root = await mkdtemp(join(tmpdir(), 'blob-contract-'));
  return {
    subject: new FileSystemBlobStore(root),
    close: () => rm(root, { recursive: true, force: true }),
  };
};

export const nativeOutputContractVersion = 'native-output@1';

const fileA = 'a'.repeat(64);
const fileB = 'b'.repeat(64);
const docling = (settings: Record<string, unknown>) => ({
  converter: 'docling',
  version: '2.123.1',
  settings,
});

let conversionRuns = 0;
const freshFile = (letter: string) => {
  conversionRuns += 1;
  return `${letter}${conversionRuns.toString(16).padStart(8, '0')}${Date.now().toString(16).padStart(16, '0')}`.padEnd(
    64,
    letter,
  );
};

export const nativeOutputContract: ContractSuite<NativeOutputContainer> = {
  contract: nativeOutputContractVersion,
  checks: [
    {
      name: "a conversion's native output is written and read back by its converter and file sha256, with no tenant",
      run: async (container) => {
        const store = nativeOutputStore(container);
        const key = { sha256: freshFile('a'), ...docling({ ocr: 'tesseract', lang: 'nor' }) };
        await store.put(key, text('{"pages":[{"text":"Søknad"}]}'), 3);
        const found = await store.get(key);
        checkEqual(read(found?.output), '{"pages":[{"text":"Søknad"}]}', 'output');
        checkEqual(found?.meta.converter, 'docling', 'converter');
        checkEqual(found?.meta.version, '2.123.1', 'version');
        checkEqual(found?.meta.pages, 3, 'pages');
        checkEqual(found?.entry.path.startsWith(`${key.sha256}/docling/2.123.1/`), true, 'path');
        checkEqual(await store.get({ ...key, version: '2.124.0' }), undefined, 'other version');
      },
    },
    {
      name: "listing a file's sha256 finds every native output of it",
      run: async (container) => {
        const store = nativeOutputStore(container);
        const sha256 = freshFile('c');
        await store.put({ sha256, ...docling({ ocr: 'easyocr' }) }, text('{}'), 1);
        await store.put({ sha256, ...docling({ ocr: 'tesseract' }) }, text('{}'), 1);
        await store.put(
          { sha256, converter: 'text-layer', version: '1', settings: {} },
          text('{}'),
          1,
        );
        await store.put({ sha256: freshFile('d'), ...docling({ ocr: 'easyocr' }) }, text('{}'), 1);
        const found = await store.list(sha256);
        checkEqual(found.length, 3, 'outputs of the file');
        checkEqual(
          found.every((e) => e.sha256 === sha256),
          true,
          'only this file',
        );
        checkEqual(
          found.map((e) => `${e.converter}/${e.version}`).sort(),
          ['docling/2.123.1', 'docling/2.123.1', 'text-layer/1'],
          'converters',
        );
        checkEqual(await store.list(freshFile('e')), [], 'a file with none');
      },
    },
    {
      name: 'native output is stored gzipped, with its meta.json beside it',
      run: async (container) => {
        const store = nativeOutputStore(container, () => new Date('2026-11-12T10:00:00Z'));
        const key = { sha256: freshFile('f'), ...docling({ lang: ['no', 'en'], ocr: 'easyocr' }) };
        const entry = await store.put(key, text('{"pages":[]}'), 12);
        const hash = settingsHash(key.settings);
        checkEqual(entry.path, `${key.sha256}/docling/2.123.1/${hash}.json.gz`, 'output path');
        checkEqual(entry.metaPath, `${key.sha256}/docling/2.123.1/${hash}.meta.json`, 'meta path');
        const zipped = await container.read(entry.path);
        check(zipped !== undefined, 'the output blob exists');
        checkEqual(read(gunzipSync(zipped)), '{"pages":[]}', 'gunzipped output');
        checkEqual(
          JSON.parse(read(await container.read(entry.metaPath)) ?? 'null'),
          {
            converter: 'docling',
            version: '2.123.1',
            settings: { lang: ['no', 'en'], ocr: 'easyocr' },
            pages: 12,
            when: '2026-11-12T10:00:00.000Z',
          },
          'meta.json',
        );
      },
    },
    {
      name: 'a conversion key with a bad sha256 or path segment is refused',
      run: async (container) => {
        const store = nativeOutputStore(container);
        const ok = { sha256: fileA, ...docling({}) };
        await checkFailsWith(
          () => store.put({ ...ok, sha256: 'ABC' }, text('{}'), 1),
          'bad_key',
          'short sha256',
        );
        await checkFailsWith(
          () => store.put({ ...ok, sha256: fileB.toUpperCase() }, text('{}'), 1),
          'bad_key',
          'upper-case sha256',
        );
        await checkFailsWith(
          () => store.put({ ...ok, converter: '..' }, text('{}'), 1),
          'bad_key',
          'converter ..',
        );
        await checkFailsWith(
          () => store.put({ ...ok, version: '2/3' }, text('{}'), 1),
          'bad_key',
          'version with a slash',
        );
        await checkFailsWith(() => store.list('../x'), 'bad_key', 'listing a bad sha256');
      },
    },
  ],
};

export const memoryNativeOutputContractTarget = async (): Promise<
  ContractTarget<NativeOutputContainer>
> => ({
  subject: new InMemoryNativeOutputContainer(),
});

export const fileSystemNativeOutputContractTarget = async (): Promise<
  ContractTarget<NativeOutputContainer>
> => {
  const root = await mkdtemp(join(tmpdir(), 'conversion-contract-'));
  return {
    subject: new FileSystemNativeOutputContainer(root),
    close: () => rm(root, { recursive: true, force: true }),
  };
};
