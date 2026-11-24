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

/** Where a footnote's quote is in the excerpt as drawn (`raw` is its text); the prefix picks the copy. */
export const citedRange = (
  raw: string,
  flat: string,
  quote: TextQuote,
): { start: number; end: number } | undefined => {
  const exact = quote.exact.trim();
  if (!exact) return undefined;
  const drawn = visibleText(excerptMarkdown(exact), false).text.trim();
  if (!drawn) return undefined;
  // Where the quote is in the excerpt's own text, and so how many drawn copies come before it.
  const placed = raw.indexOf(quote.prefix + exact);
  const at = placed < 0 ? raw.indexOf(exact) : placed + quote.prefix.length;
  const before = at > 0 ? visibleText(excerptMarkdown(raw.slice(0, at)), false).text : '';
  const start = nth(flat, drawn, at > 0 ? count(before, drawn, before.length) : 0);
  const found = start >= 0 ? start : flat.indexOf(drawn);
  return found < 0 ? undefined : { start: found, end: found + drawn.length };
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
