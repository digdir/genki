import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenCredential } from '@azure/identity';
import { FileSystemNativeOutputContainer } from '@genai/port-blob';
import { nativeOutputContract } from '@genai/port-blob/contract';
import { describeContract } from '@genai/plugins/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    constructor(options?: unknown) {
      identity.options.push(options);
    }
    getToken = async () => null;
  },
  AzureCliCredential: class {
    getToken = async () => null;
  },
}));
import { AzureCliCredential } from '@azure/identity';
import { StorageSharedKeyCredential } from '@azure/storage-blob';
import {
  AzureNativeOutputContainer,
  operatorNativeOutputContainer,
  nativeOutputStoreFromEnv,
  type BlobContainerClient,
} from './container.js';

const notFound = () =>
  Object.assign(new Error('The specified blob does not exist.'), { statusCode: 404 });

const fakeContainerClient = () => {
  const blobs = new Map<string, Uint8Array>();
  const blob = (name: string) => ({
    uploadData: async (body: Uint8Array) => {
      blobs.set(name, new Uint8Array(body));
      return {};
    },
    downloadToBuffer: async () => {
      const found = blobs.get(name);
      if (!found) throw notFound();
      return Buffer.from(found);
    },
    deleteIfExists: async () => ({ succeeded: blobs.delete(name) }),
  });
  const client = {
    getBlockBlobClient: blob,
    getBlobClient: blob,
    listBlobsFlat: ({ prefix = '' }: { prefix?: string } = {}) =>
      (async function* () {
        for (const name of [...blobs.keys()].sort()) if (name.startsWith(prefix)) yield { name };
      })(),
  };
  return client as unknown as BlobContainerClient;
};

describeContract('azure (fake client)', nativeOutputContract, async () => ({
  subject: new AzureNativeOutputContainer(fakeContainerClient()),
}));

const fakeCredential = (): TokenCredential => ({ getToken: async () => null });
const blobUrl = 'https://genkitestdata.blob.core.windows.net/conversions';

describe('nativeOutputStoreFromEnv', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it("the Azure store authenticates with the worker's identity, never an account key", async () => {
    const asked: (string | undefined)[] = [];
    const credential = fakeCredential();
    const given: { url: string; credential: TokenCredential }[] = [];
    const deps = {
      credentialFor: (clientId: string | undefined) => {
        asked.push(clientId);
        return credential;
      },
      clientFor: (url: string, c: TokenCredential) => {
        given.push({ url, credential: c });
        return fakeContainerClient();
      },
    };
    await nativeOutputStoreFromEnv(
      {
        CONVERSIONS_BLOB_URL: blobUrl,
        AZURE_CLIENT_ID: 'shared-app',
        KNOWLEDGE_AZURE_CLIENT_ID: 'knowledge-worker',
      },
      '/unused',
      deps,
    );
    expect(asked).toEqual(['knowledge-worker']);
    expect(given).toEqual([{ url: blobUrl, credential }]);

    for (const url of [
      `${blobUrl}?sv=2024-11-04&sig=abc`,
      'DefaultEndpointsProtocol=https;AccountName=genkitestdata;AccountKey=a2V5;EndpointSuffix=core.windows.net',
      'http://genkitestdata.blob.core.windows.net/conversions',
    ])
      await expect(
        nativeOutputStoreFromEnv({ CONVERSIONS_BLOB_URL: url }, '/unused', deps),
      ).rejects.toThrow(/CONVERSIONS_BLOB_URL/);
    expect(given).toHaveLength(1);

    await expect(
      nativeOutputStoreFromEnv(
        { CONVERSIONS_BLOB_URL: blobUrl, AZURE_CLIENT_ID: 'shared-app' },
        '/unused',
        deps,
      ),
    ).rejects.toThrow(/KNOWLEDGE_AZURE_CLIENT_ID/);
    expect(asked).toEqual(['knowledge-worker']);

    identity.options.length = 0;
    await nativeOutputStoreFromEnv(
      { CONVERSIONS_BLOB_URL: blobUrl, KNOWLEDGE_AZURE_CLIENT_ID: 'knowledge-worker' },
      '/unused',
      { clientFor: () => fakeContainerClient() },
    );
    expect(identity.options).toEqual([{ managedIdentityClientId: 'knowledge-worker' }]);
  });

  it('nativeOutputStoreFromEnv picks the Azure store when CONVERSIONS_BLOB_URL is set and the folder store otherwise', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'conversions-env-'));
    roots.push(dataDir);
    const local = await nativeOutputStoreFromEnv({}, dataDir);
    expect(local.container).toBeInstanceOf(FileSystemNativeOutputContainer);
    await local.store.put(
      { sha256: 'c'.repeat(64), converter: 'docling', version: '2.123.1', settings: {} },
      new TextEncoder().encode('{}'),
      1,
    );
    expect(await readdir(join(dataDir, 'conversions'))).toEqual(['c'.repeat(64)]);

    const azure = await nativeOutputStoreFromEnv(
      { CONVERSIONS_BLOB_URL: blobUrl, KNOWLEDGE_AZURE_CLIENT_ID: 'knowledge-worker' },
      dataDir,
      {
        credentialFor: fakeCredential,
        clientFor: () => fakeContainerClient(),
      },
    );
    expect(azure.container).toBeInstanceOf(AzureNativeOutputContainer);
  });
});

describe('operatorNativeOutputContainer', () => {
  const url = 'https://genkitestdata.blob.core.windows.net/conversions';

  it("an operator's upload signs with the az CLI login, or with the account key only when given one", async () => {
    const login = await operatorNativeOutputContainer(url);
    expect((login.client as { credential?: unknown }).credential).toBeInstanceOf(
      AzureCliCredential,
    );
    const keyed = await operatorNativeOutputContainer(url, { key: 'a2V5' });
    expect((keyed.client as { credential?: unknown }).credential).toBeInstanceOf(
      StorageSharedKeyCredential,
    );
    await expect(operatorNativeOutputContainer(`${url}?sv=1&sig=abc`)).rejects.toThrow(
      /CONVERSIONS_BLOB_URL|SAS/,
    );
  });
});
