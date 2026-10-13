import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { documentConverterFrom } from './document-converter.js';

const secrets = envSecrets({});

describe('the document converter setting', () => {
  it('uses the local converter for PDF and DOCX by default', () => {
    const converter = documentConverterFrom({}, secrets);

    expect(converter?.extensions).toEqual(expect.arrayContaining(['.pdf', '.docx']));
  });

  it('turns conversion off with none and refuses unknown or incomplete choices', () => {
    expect(documentConverterFrom({ DOCUMENT_CONVERTER: 'none' }, secrets)).toBeUndefined();
    expect(() => documentConverterFrom({ DOCUMENT_CONVERTER: 'marker' }, secrets)).toThrow(
      /MARKER_URL/,
    );
    expect(() => documentConverterFrom({ DOCUMENT_CONVERTER: 'ocr' }, secrets)).toThrow(/ocr/);
    expect(
      documentConverterFrom(
        { DOCUMENT_CONVERTER: 'marker', MARKER_URL: 'https://marker.example.no/convert' },
        secrets,
      ),
    ).toBeDefined();
  });
});
