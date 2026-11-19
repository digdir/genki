/**
 * Parts from a PDF's stored text layer, derivation `text-layer-parts` 1 (ADR 0055, "Derivations"):
 * one `text` part a page, its region the whole page. The text layer keeps no page size, so a unit has
 * none. A page with no text is a unit with no parts.
 */
import {
  codePointLength,
  nfc,
  type ConversionPart,
  type ConversionUnit,
} from '@genai/port-knowledge';

export const textLayerParts = (pages: readonly string[]): ConversionUnit[] => {
  let length = 0;
  let seq = 0;
  return pages.map((page, i) => {
    const unit = i + 1;
    const text = nfc(page.replaceAll('\u0000', '').trim());
    const row = {
      unit,
      kind: 'page' as const,
      label: null,
      width: null,
      height: null,
      unitTo: unit,
    };
    if (text === '')
      return { ...row, textStart: null, textEnd: null, seqFrom: seq, seqTo: seq - 1, parts: [] };
    const start = length > 0 ? length + 2 : 0;
    const end = start + codePointLength(text);
    length = end;
    const part: ConversionPart = {
      seq,
      kind: 'text',
      layer: 'body',
      level: null,
      headingPath: [],
      text,
      start,
      end,
      regions: [{ unit, box: [0, 0, 1, 1], start, end }],
      native: `#/pages/${unit}`,
    };
    seq += 1;
    return {
      ...row,
      textStart: start,
      textEnd: end,
      seqFrom: part.seq,
      seqTo: part.seq,
      parts: [part],
    };
  });
};
