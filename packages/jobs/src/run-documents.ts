import type { CompiledCapability, SettingsRegistry } from '@genai/definitions';
import type { BlobStore } from '@genai/port-blob';
import { retentionFor } from './retention-policy.js';

export const runDocumentsFolder = 'run-documents';

export const runDocumentFolder = (capability: string) =>
  `${runDocumentsFolder}/${capability.replace(/[^A-Za-z0-9._-]+/g, '.')}`;

const dayMs = 86_400_000;

export const purgeRunDocuments = async (input: {
  blobs: Pick<BlobStore, 'list' | 'delete'>;
  settings: SettingsRegistry;
  capabilities: CompiledCapability[];
  tenants: Iterable<string>;
  now: Date;
}): Promise<number> => {
  const byFolder = new Map(
    input.capabilities.map((c) => [runDocumentFolder(c.capability.descriptor.id), c]),
  );
  let deleted = 0;
  for (const tenant of input.tenants)
    for (const blob of await input.blobs.list(tenant, `${runDocumentsFolder}/`)) {
      const folder = blob.path.split('/').slice(0, 2).join('/');
      const policy = retentionFor(input.settings, tenant, byFolder.get(folder));
      if (new Date(blob.createdAt).getTime() >= input.now.getTime() - policy.payloadDays * dayMs)
        continue;
      if (await input.blobs.delete({ tenant, path: blob.path })) deleted += 1;
    }
  return deleted;
};
