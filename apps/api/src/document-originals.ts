import type { OriginalDocumentFile, RestAdapterOptions } from '@genai/adapter-rest';
import { uploadDocumentId, uploadPrefix } from '@genai/ingest';
import type { BlobStore } from '@genai/port-blob';

/** A document's uploaded original, only for a caller of the organisation that owns the dataset. */
export const documentOriginals =
  (
    blobs: BlobStore | undefined,
    ownerOf: (dataset: string) => string | undefined,
  ): NonNullable<RestAdapterOptions['originalFile']> =>
  async (principal, dataset, doc): Promise<OriginalDocumentFile | undefined> => {
    const owner = ownerOf(dataset);
    if (!blobs || !owner || owner !== (principal.confinedTo?.tenant ?? principal.tenant))
      return undefined;
    const prefix = uploadPrefix(dataset, owner);
    const kept = (await blobs.list(owner, prefix)).find(
      (b) => uploadDocumentId(owner, b.path) === doc,
    );
    const stored = kept && (await blobs.get({ tenant: owner, path: kept.path }));
    return kept && stored
      ? { name: kept.path.slice(prefix.length), type: kept.contentType, body: stored.body }
      : undefined;
  };
