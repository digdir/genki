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
import { sha256, type BlobStore } from './blob.js';
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
