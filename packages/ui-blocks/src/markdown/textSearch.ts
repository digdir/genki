// Text search over what a part has already drawn: texts with ids in, match positions out. It
// fetches nothing and asks the host for nothing — it is a filter over the words on screen.
// Ported from KA's src/components/textSearch.ts, which the sources panel has used since #70.

export interface SearchableItem {
  /** The same id as the thing the text came from, so a hit can be pointed back at it. */
  id: string;
  text: string;
}

/** One match: which piece of text, and where in it. */
export interface SearchHit {
  itemId: string;
  /** Index of the first character of the match in the item's text. */
  start: number;
  /** Index one past the last character. */
  end: number;
}

/** Shortest query we act on. One character matches nearly everything. */
export const MIN_QUERY_LENGTH = 2;

const RAISED = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';
const PLAIN = '0123456789+-=()';
const raisedChar = new RegExp(`[${RAISED}]`, 'g');

/**
 * Case-insensitive, and superscripts fold to plain, since a keyboard has no «²». `toLowerCase()`
 * keeps the length of æ ø å and each superscript is one UTF-16 unit like its plain twin, so an
 * offset found in the folded copy is valid in the original.
 */
const fold = (text: string) =>
  text.toLocaleLowerCase('nb').replace(raisedChar, (char) => PLAIN[RAISED.indexOf(char)] ?? char);

/** Every match in reading order. Matches never overlap. */
export const findHits = (items: readonly SearchableItem[], query: string): SearchHit[] => {
  const needle = fold(query.trim());
  if (needle.length < MIN_QUERY_LENGTH) return [];

  const hits: SearchHit[] = [];
  for (const item of items) {
    const haystack = fold(item.text);
    for (let from = 0; ;) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) break;
      hits.push({ itemId: item.id, start, end: start + needle.length });
      from = start + needle.length;
    }
  }
  return hits;
};

/** The hits inside one piece of text, for rendering. */
export const hitsFor = (hits: readonly SearchHit[], itemId: string): SearchHit[] =>
  hits.filter((hit) => hit.itemId === itemId);

/**
 * Move one hit, and stop at the ends rather than wrap: a wrapping «Forrige» on the first hit looks
 * usable and says nothing about where it lands. The buttons that call this are `aria-disabled`
 * when they would be no-ops.
 */
export const stepHit = (total: number, current: number, step: 1 | -1): number =>
  total === 0 ? 0 : Math.min(Math.max(current + step, 0), total - 1);

/** A run of text, either plain or part of a match. */
export interface TextRun {
  text: string;
  hit?: SearchHit;
}

/**
 * Split a text into plain and matched runs, so the caller can wrap the matched ones in `<mark>`.
 * The runs cover the whole text exactly once, in order.
 */
export const splitByHits = (text: string, hits: readonly SearchHit[]): TextRun[] => {
  if (hits.length === 0) return [{ text }];

  const runs: TextRun[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) runs.push({ text: text.slice(cursor, hit.start) });
    runs.push({ text: text.slice(hit.start, hit.end), hit });
    cursor = hit.end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
};

/**
 * The runs of one leaf of rendered output, given where that leaf starts in the flat text the hits
 * were found in. A hit that spans two leaves — a query that runs over the end of a `<strong>` — is
 * one hit, and comes back here clipped to each leaf it covers, which is what the browser's own
 * find-in-page draws.
 */
export const runsIn = (text: string, offset: number, hits: readonly SearchHit[]): TextRun[] => {
  const end = offset + text.length;
  const inside = hits
    .filter((hit) => hit.start < end && hit.end > offset)
    .map((hit) => ({
      hit,
      start: Math.max(hit.start, offset) - offset,
      stop: Math.min(hit.end, end) - offset,
    }));
  if (inside.length === 0) return [{ text }];

  const runs: TextRun[] = [];
  let cursor = 0;
  for (const { hit, start, stop } of inside) {
    if (start > cursor) runs.push({ text: text.slice(cursor, start) });
    runs.push({ text: text.slice(start, stop), hit });
    cursor = stop;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
};
