import { createHash } from 'node:crypto';
import type { AcceptedConverter, StoredConversions } from '@genai/port-knowledge';
import { ConversionPending, type DocumentConverter } from './converter.js';

/**
 * The converter an index job reads with (ADR 0042, "Ingestion runs"): it never converts, but reads
 * the stored conversion of each file by its sha256, and throws `ConversionPending` for a file with
 * none, so the job makes its record wait and sends the convert job instead.
 */
export const storedConverter = (
  inner: Pick<DocumentConverter, 'extensions'>,
  conversions: Pick<StoredConversions, 'find'>,
  accepted: readonly AcceptedConverter[],
): DocumentConverter => {
  const stored: NonNullable<DocumentConverter['stored']> = async (file) => {
    const found = await conversions.find(file.sha256, accepted);
    if (!found) throw new ConversionPending([file]);
    return {
      pages: found.pages,
      converter: { name: found.converter, version: found.version, settings: found.settings },
    };
  };
  return {
    ...(inner.extensions ? { extensions: inner.extensions } : {}),
    stored,
    convert: (file) =>
      stored({ name: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex') }),
  };
};
