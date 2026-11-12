import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenCredential } from '@azure/identity';
import { FileSystemConversionContainer } from '@genai/port-blob';
import { conversionContract } from '@genai/port-blob/contract';
import { describeContract } from '@genai/plugins/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AzureConversionContainer,
  conversionStoreFromEnv,
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

describeContract('azure (fake client)', conversionContract, async () => ({
  subject: new AzureConversionContainer(fakeContainerClient()),
}));

const fakeCredential = (): TokenCredential => ({ getToken: async () => null });
const blobUrl = 'https://genkitestdata.blob.core.windows.net/conversions';

describe('conversionStoreFromEnv', () => {
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
    await conversionStoreFromEnv(
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
        conversionStoreFromEnv({ CONVERSIONS_BLOB_URL: url }, '/unused', deps),
      ).rejects.toThrow(/CONVERSIONS_BLOB_URL/);
    expect(given).toHaveLength(1);
  });

  it('the worker uses the Azure store when CONVERSIONS_BLOB_URL is set and the folder store otherwise', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'conversions-env-'));
    roots.push(dataDir);
    const local = await conversionStoreFromEnv({}, dataDir);
    expect(local.container).toBeInstanceOf(FileSystemConversionContainer);
    await local.store.put(
      { sha256: 'c'.repeat(64), converter: 'docling', version: '2.123.1', settings: {} },
      new TextEncoder().encode('{}'),
      1,
    );
    expect(await readdir(join(dataDir, 'conversions'))).toEqual(['c'.repeat(64)]);

    const azure = await conversionStoreFromEnv({ CONVERSIONS_BLOB_URL: blobUrl }, dataDir, {
      credentialFor: fakeCredential,
      clientFor: () => fakeContainerClient(),
    });
    expect(azure.container).toBeInstanceOf(AzureConversionContainer);
  });
});
