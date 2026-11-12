import type { TokenCredential } from '@azure/identity';
import type { ContainerClient } from '@azure/storage-blob';
import { join } from 'node:path';
import {
  nativeOutputStore,
  FileSystemNativeOutputContainer,
  type NativeOutputContainer,
  type NativeOutputStore,
} from '@genai/port-blob';

type Env = Record<string, string | undefined>;

export type BlobContainerClient = Pick<
  ContainerClient,
  'getBlockBlobClient' | 'getBlobClient' | 'listBlobsFlat'
>;

export class AzureNativeOutputContainer implements NativeOutputContainer {
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

export interface NativeOutputStoreDeps {
  credentialFor?: (clientId: string) => TokenCredential | Promise<TokenCredential>;
  clientFor?: (
    url: string,
    credential: TokenCredential,
  ) => BlobContainerClient | Promise<BlobContainerClient>;
}

export interface NativeOutputStoreSetup {
  store: NativeOutputStore;
  container: NativeOutputContainer;
}

const defaultCredential = async (clientId: string) => {
  const { DefaultAzureCredential } = await import('@azure/identity');
  return new DefaultAzureCredential({ managedIdentityClientId: clientId });
};

// Without it DefaultAzureCredential would fall back to the shared AZURE_CLIENT_ID.
const workerClientId = (env: Env) => {
  if (!env.KNOWLEDGE_AZURE_CLIENT_ID)
    throw new Error(
      'CONVERSIONS_BLOB_URL needs KNOWLEDGE_AZURE_CLIENT_ID, the knowledge worker identity',
    );
  return env.KNOWLEDGE_AZURE_CLIENT_ID;
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

export const nativeOutputStoreFromEnv = async (
  env: Env,
  dataDir: string,
  { credentialFor = defaultCredential, clientFor = defaultClient }: NativeOutputStoreDeps = {},
): Promise<NativeOutputStoreSetup> => {
  const blobUrl = env.CONVERSIONS_BLOB_URL;
  const container: NativeOutputContainer = blobUrl
    ? new AzureNativeOutputContainer(
        await clientFor(containerUrl(blobUrl), await credentialFor(workerClientId(env))),
      )
    : new FileSystemNativeOutputContainer(join(dataDir, 'conversions'));
  return { store: nativeOutputStore(container), container };
};
