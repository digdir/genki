/**
 * Pages from a `DoclingDocument`, derivation `docling-pages` 1 (ADR 0042, "Conversion"): the body
 * in reading order, grouped by the page of each item's first box, without furniture, empty items
 * and bare page numbers. Text inside a picture counts only on a page with almost no other text.
 */
import {
  pagesTakingPictureText,
  walkDocling,
  type DoclingDocument,
  type WalkEntry,
} from './docling-walk.js';

export type { DoclingDocument } from './docling-walk.js';

export const doclingPages = (document: DoclingDocument): string[] => {
  const walk = walkDocling(document);
  const takesPictureText = pagesTakingPictureText(walk);
  const pages: WalkEntry[][] = Array.from({ length: walk.pageCount }, () => []);
  for (const entry of walk.entries)
    if (entry.markdown !== undefined && entry.page !== undefined)
      pages[entry.page - 1]?.push(entry);
  return pages.map((page, i) => {
    const kept = takesPictureText.has(i + 1) ? page : page.filter((entry) => !entry.picture);
    return kept.reduce((markdown, entry, k) => {
      if (k === 0) return entry.markdown ?? '';
      const previous = kept[k - 1];
      const sameList = entry.list !== undefined && entry.list === previous?.list;
      return `${markdown}${sameList ? '\n' : '\n\n'}${entry.markdown ?? ''}`;
    }, '');
  });
};
