import { createHash } from 'node:crypto';
import {
  blankPage,
  shortEnd,
  type AcceptedConverter,
  type StoredConversion,
  type StoredConversions,
} from '@genai/port-knowledge';
import { ConversionPending, ConversionRefused, type DocumentConverter } from './converter.js';

const isEmpty = (page: string) => blankPage.test(page);

/**
 * Where a conversion cut short ends: the number of pages up to its last page with text, when the
 * empty pages after it are more than 5 % of its pages, as `StoredConversions.short` counts them.
 */
const cutOf = (pages: readonly string[]) => {
  const kept = pages.findLastIndex((page) => !isEmpty(page)) + 1;
  return pages.length - kept > shortEnd * pages.length ? kept : undefined;
};

/**
 * The pages of a file's conversion, with the pages after its cut, when it was cut short, taken from
 * the file's conversion by a later accepted converter, when one is stored: the KUDOS export stopped
 * Docling at 900 s and the seed stored its pages after that empty, so the text layer fills them
 * (issue 749). An empty page before the cut stays empty: Docling leaves a page with only its page
 * number or a picture empty on purpose.
 */
const filledPages = async (
  found: StoredConversion,
  conversions: Pick<StoredConversions, 'find'>,
  accepted: readonly AcceptedConverter[],
) => {
  const cut = cutOf(found.pages);
  if (cut === undefined) return found.pages;
  const later = accepted.slice(accepted.findIndex((a) => a.converter === found.converter) + 1);
  if (later.length === 0) return found.pages;
  const filler = await conversions.find(found.sha256, later);
  if (!filler || filler.failure) return found.pages;
  return found.pages.map((page, i) => (i >= cut && filler.pages[i] ? filler.pages[i] : page));
};

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
    if (found.failure)
      throw new ConversionRefused(
        file.name,
        found.failure === 'too_large' ||
          found.failure === 'unsupported_type' ||
          found.failure === 'unreachable'
          ? found.failure
          : 'conversion_failed',
      );
    return {
      pages: await filledPages(found, conversions, accepted),
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
