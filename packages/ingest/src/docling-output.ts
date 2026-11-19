import type { DoclingDocument } from './docling-walk.js';

/**
 * A converter's output that is not a `DoclingDocument`, or not JSON: the one error a parts derivation
 * stores as a refusal (ADR 0055). Any other error is a bug, tried again, never stored.
 */
export class NotDoclingDocument extends Error {
  override readonly name = 'NotDoclingDocument';
  constructor() {
    super('not a DoclingDocument');
  }
}

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
    throw new NotDoclingDocument();
  return document as DoclingDocument;
};

/**
 * Docling's output as JSON bytes, read with U+0000 left out of every string, which PostgreSQL
 * refuses in text (issue 532), so the parts' offsets count the text as it is stored.
 */
export const readDoclingOutput = (output: Uint8Array): DoclingDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(output), (_, value: unknown) =>
      typeof value === 'string' ? value.replaceAll('\u0000', '') : value,
    );
  } catch {
    throw new NotDoclingDocument();
  }
  return asDoclingDocument(parsed);
};
