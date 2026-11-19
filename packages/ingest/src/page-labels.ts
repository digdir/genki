/**
 * A page's printed number as its unit's label (ADR 0055, "A unit's label"): the number in the first
 * furniture part on the page that reads as one, kept only when a neighbouring page agrees.
 */
import type { ConversionUnit } from '@genai/port-knowledge';

/** `12`, `s. 12`, `side 3 av 9`, `page 3 of 9`, `3/9`. Roman numerals are not read. */
const pageNumber = /^(?:s\.|side|page|sida)?\s*(\d{1,4})(?:\s*(?:av|of|\/)\s*\d{1,4})?$/i;
/** How many pages away a labelled neighbour may be. */
const reach = 2;

/**
 * Each unit's label, in the order of `units`: the printed number as a string, or null when the
 * page has none or its neighbours do not agree with it.
 */
export const pageLabels = (units: ConversionUnit[]): (string | null)[] => {
  // The units hold their parts in seq order, so the first match on a page wins. A part's text is
  // already whitespace-collapsed and trimmed (`textOf` in docling-walk).
  const printed = new Map<number, number>();
  for (const part of units.flatMap((unit) => unit.parts)) {
    const page = part.regions[0]?.unit;
    if (part.layer !== 'furniture' || page === undefined || printed.has(page)) continue;
    const match = pageNumber.exec(part.text);
    if (match?.[1]) printed.set(page, Number(match[1]));
  }

  const offset = (page: number) => {
    const number = printed.get(page);
    return number === undefined ? undefined : number - page;
  };
  /** Whether the nearest labelled page in `direction`, within reach, has the same offset. */
  const agrees = (page: number, direction: 1 | -1) => {
    for (let step = 1; step <= reach; step += 1) {
      const other = offset(page + direction * step);
      if (other !== undefined) return other === offset(page);
    }
    return false;
  };

  return units.map(({ unit }) => {
    const number = printed.get(unit);
    if (number === undefined) return null;
    return agrees(unit, -1) || agrees(unit, 1) ? String(number) : null;
  });
};
