import { codePointSlice, conversionText } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { textLayerParts } from './text-layer-parts.js';

describe('text-layer-parts', () => {
  it('text-layer-parts gives one text part a page, its region the whole page', () => {
    const units = textLayerParts(['  Årsrapport 2025\nForside ', '', 'Budsjettet 𝑥 økte.']);

    expect(units.map((u) => [u.unit, u.kind, u.width, u.height, u.unitTo])).toEqual([
      [1, 'page', null, null, 1],
      [2, 'page', null, null, 2],
      [3, 'page', null, null, 3],
    ]);
    const parts = units.flatMap((u) => u.parts);
    expect(parts.map((p) => [p.seq, p.kind, p.layer, p.text, p.regions])).toEqual([
      [
        0,
        'text',
        'body',
        'Årsrapport 2025\nForside',
        [{ unit: 1, box: [0, 0, 1, 1], start: 0, end: 23 }],
      ],
      [
        1,
        'text',
        'body',
        'Budsjettet 𝑥 økte.',
        [{ unit: 3, box: [0, 0, 1, 1], start: 25, end: 43 }],
      ],
    ]);
    // A blank page is a row with no parts.
    expect(units[1]).toMatchObject({
      seqFrom: 1,
      seqTo: 0,
      textStart: null,
      textEnd: null,
      parts: [],
    });
    // Offsets are code points of the conversion's text, rebuilt from the parts.
    const text = conversionText(parts);
    for (const part of parts)
      expect(codePointSlice(text, part.start as number, part.end as number)).toBe(part.text);
  });
});
