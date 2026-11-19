import { codePointSlice, conversionText } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { doc } from './docling-document.test-utils.js';
import { doclingParts } from './docling-parts.js';
import { NotDoclingDocument, readDoclingOutput } from './docling-output.js';
import { textLayerParts } from './text-layer-parts.js';

const slicesBack = (parts: { text: string; start: number | null; end: number | null }[]) => {
  const text = conversionText(parts as never);
  return parts.map((part) => codePointSlice(text, part.start as number, part.end as number));
};

describe('reading Docling output', () => {
  it('U+0000 is left out before offsets are counted', () => {
    const output = new TextEncoder().encode(
      JSON.stringify({
        schema_name: 'DoclingDocument',
        ...doc(1, (add) => {
          add.text('text', 'Lønn\u0000 og tilskudd.', 1);
          add.text('text', 'Neste\u0000 avsnitt.', 1);
        }),
      }),
    );

    const docling = doclingParts(readDoclingOutput(output)).units.flatMap((u) => u.parts);
    const textLayer = textLayerParts(['Lønn\u0000 og tilskudd.', 'Neste\u0000 side.']).flatMap(
      (u) => u.parts,
    );

    expect(docling.map((p) => p.text)).toEqual(['Lønn og tilskudd.', 'Neste avsnitt.']);
    expect(slicesBack(docling)).toEqual(docling.map((p) => p.text));
    expect(textLayer.map((p) => p.text)).toEqual(['Lønn og tilskudd.', 'Neste side.']);
    expect(slicesBack(textLayer)).toEqual(textLayer.map((p) => p.text));
  });

  it('output that is not JSON is not a DoclingDocument', () => {
    expect(() => readDoclingOutput(new TextEncoder().encode('{"half'))).toThrow(NotDoclingDocument);
  });
});
