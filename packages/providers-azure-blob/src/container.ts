import type { TokenCredential } from '@azure/identity';
import type { ContainerClient } from '@azure/storage-blob';
import { join } from 'node:path';
import {
  conversionStore,
  FileSystemConversionContainer,
  type ConversionContainer,
  type ConversionStore,
} from '@genai/port-blob';

type Env = Record<string, string | undefined>;

export type BlobContainerClient = Pick<
  ContainerClient,
  'getBlockBlobClient' | 'getBlobClient' | 'listBlobsFlat'
>;

export class AzureConversionContainer implements ConversionContainer {
  constructor(readonly client: BlobContainerClient) {}

  async write(path: string, body: Uint8Array, contentType: string) {
    await this.client
      .getBlockBlobClient(path)
      .uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async read(path: string) {
    try {
      return new Uint8Array(await this.client.getBlobClient(path).downloadToBuffer());
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined;
      throw error;
    }
  }

  async list(prefix: string) {
    const names: string[] = [];
    for await (const blob of this.client.listBlobsFlat({ prefix })) names.push(blob.name);
    return names.sort();
  }

  async remove(path: string) {
    return (await this.client.getBlobClient(path).deleteIfExists()).succeeded;
  }
}

export interface ConversionStoreDeps {
  credentialFor?: (clientId: string | undefined) => TokenCredential | Promise<TokenCredential>;
  clientFor?: (
    url: string,
    credential: TokenCredential,
  ) => BlobContainerClient | Promise<BlobContainerClient>;
}

export interface ConversionStoreSetup {
  store: ConversionStore;
  container: ConversionContainer;
}

const defaultCredential = async (clientId: string | undefined) => {
  const { DefaultAzureCredential } = await import('@azure/identity');
  return clientId
    ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
    : new DefaultAzureCredential();
};

const defaultClient = async (url: string, credential: TokenCredential) => {
  const { ContainerClient } = await import('@azure/storage-blob');
  return new ContainerClient(url, credential);
};

const containerUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CONVERSIONS_BLOB_URL must be the container URL, not a connection string');
  }
  if (url.protocol !== 'https:') throw new Error('CONVERSIONS_BLOB_URL must use https');
  if (url.search) throw new Error('CONVERSIONS_BLOB_URL must carry no SAS token or other query');
  return url.toString();
};

export const conversionStoreFromEnv = async (
  env: Env,
  dataDir: string,
  { credentialFor = defaultCredential, clientFor = defaultClient }: ConversionStoreDeps = {},
): Promise<ConversionStoreSetup> => {
  const blobUrl = env.CONVERSIONS_BLOB_URL;
  const container: ConversionContainer = blobUrl
    ? new AzureConversionContainer(
        await clientFor(containerUrl(blobUrl), await credentialFor(env.KNOWLEDGE_AZURE_CLIENT_ID)),
      )
    : new FileSystemConversionContainer(join(dataDir, 'conversions'));
  return { store: conversionStore(container), container };
};
