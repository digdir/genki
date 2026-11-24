import { visibleText } from '../markdown/Markdown.js';
import type { SearchHit } from '../markdown/textSearch.js';
import { excerptMarkdown } from './excerptMarkdown.js';
import type { TextQuote } from './types.js';

const count = (text: string, part: string, before: number) => {
  let n = 0;
  for (let at = text.indexOf(part); at >= 0 && at < before; at = text.indexOf(part, at + 1)) n++;
  return n;
};

const nth = (text: string, part: string, n: number) => {
  let at = text.indexOf(part);
  for (let i = 0; i < n && at >= 0; i++) at = text.indexOf(part, at + 1);
  return at;
};

/**
 * Where a footnote's quote is in an excerpt as drawn: `flat` is the excerpt's visible text, `text`
 * its markdown. The quote is drawn on its own and found in the drawing; the prefix says which
 * copy when the words are there more than once. None when the words are not in the excerpt.
 */
export const citedRange = (
  text: string,
  flat: string,
  quote: TextQuote,
): { start: number; end: number } | undefined => {
  const exact = quote.exact.trim();
  if (!exact) return undefined;
  const placed = text.indexOf(quote.prefix + exact);
  const copy = placed < 0 ? 0 : count(text, exact, placed + quote.prefix.length);
  const drawn = visibleText(excerptMarkdown(exact), false).text.trim();
  if (!drawn) return undefined;
  const start = nth(flat, drawn, copy);
  const at = start >= 0 ? start : flat.indexOf(drawn);
  return at < 0 ? undefined : { start: at, end: at + drawn.length };
};

/** The cited range as marks, with the search's own hits cut out so both show. */
export const citedHits = (
  itemId: string,
  range: { start: number; end: number },
  search: readonly SearchHit[],
  className: string,
): SearchHit[] => {
  const pieces: SearchHit[] = [];
  let cursor = range.start;
  for (const hit of [...search].sort((a, b) => a.start - b.start)) {
    if (hit.end <= cursor || hit.start >= range.end) continue;
    if (hit.start > cursor) pieces.push({ itemId, start: cursor, end: hit.start, className });
    cursor = Math.max(cursor, hit.end);
  }
  if (cursor < range.end) pieces.push({ itemId, start: cursor, end: range.end, className });
  return pieces;
};
