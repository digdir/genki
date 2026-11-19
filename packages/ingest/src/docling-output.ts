import type { DoclingDocument } from './docling-walk.js';

/**
 * A converter's native output as a `DoclingDocument`, or an error `not a DoclingDocument`: the shape
 * the derivations need (ADR 0042, "Conversion"; ADR 0055).
 */
export const asDoclingDocument = (output: unknown): DoclingDocument => {
  const document = output as Partial<DoclingDocument> & { schema_name?: unknown };
  if (
    document?.schema_name !== 'DoclingDocument' ||
    !document.body ||
    !Array.isArray(document.texts) ||
    !document.pages
  )
    throw new Error('not a DoclingDocument');
  return document as DoclingDocument;
};

/**
 * Docling's output as JSON bytes, read with U+0000 left out of every string, which PostgreSQL
 * refuses in text (issue 532), so the parts' offsets count the text as it is stored.
 */
export const readDoclingOutput = (output: Uint8Array): DoclingDocument =>
  asDoclingDocument(
    JSON.parse(new TextDecoder().decode(output), (_, value: unknown) =>
      typeof value === 'string' ? value.replaceAll('\u0000', '') : value,
    ),
  );
