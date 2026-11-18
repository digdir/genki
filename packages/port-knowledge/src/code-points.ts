/**
 * Offsets into a conversion's text count Unicode code points over NFC text (ADR 0055, "The part"),
 * not the UTF-16 units `String.prototype.length` and `slice` count. Nothing else reads an offset.
 */

/** The text in the form every offset is counted over. */
export const nfc = (text: string) => text.normalize('NFC');

export const codePointLength = (text: string) => [...text].length;

/** The code points from `start` to `end`, end exclusive, as a part's `start` and `end` give them. */
export const codePointSlice = (text: string, start: number, end?: number) => {
  let index = 0;
  let from = text.length;
  let to = text.length;
  let unit = 0;
  for (const point of text) {
    if (index === start) from = unit;
    if (end !== undefined && index === end) {
      to = unit;
      break;
    }
    index += 1;
    unit += point.length;
  }
  return end !== undefined && end <= start ? '' : text.slice(from, to);
};
