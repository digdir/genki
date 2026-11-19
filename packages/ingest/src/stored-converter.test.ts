import {
  acceptedConverters,
  doclingPagesDerivation,
  textLayerDerivation,
  type StoredConversion,
} from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { storedConverter } from './stored-converter.js';

const sha256 = 'a'.repeat(64);

const docling = (pages: string[]): StoredConversion => ({
  sha256,
  converter: 'docling',
  version: '2.123.1',
  settings: {},
  derivation: doclingPagesDerivation,
  pages,
});

const textLayer = (pages: string[]): StoredConversion => ({
  sha256,
  converter: 'text-layer',
  version: '1',
  settings: {},
  derivation: textLayerDerivation,
  pages,
});

/** Stored conversions as `find` answers: the first accepted converter with a conversion. */
const conversionsOf = (stored: StoredConversion[]) => ({
  find: async (sha: string, accepted: readonly { converter: string }[]) =>
    accepted
      .map((a) => stored.find((c) => c.sha256 === sha && c.converter === a.converter))
      .find((c) => c !== undefined),
});

const read = (stored: StoredConversion[]) =>
  storedConverter({ extensions: ['.pdf'] }, conversionsOf(stored), acceptedConverters).stored?.({
    name: 'rapport.pdf',
    sha256,
  });

describe('storedConverter', () => {
  it("a page after a short Docling conversion's cut takes the text layer's page", async () => {
    // The KUDOS export stopped Docling at 900 s: the pages after it were stored empty (issue 749).
    const conversion = await read([
      docling(['# Innledning', 'Drift', 'Tabell 3', '', '']),
      textLayer(['Innledning', 'Drift', 'Tabell 3', 'Annen rapportering', 'Vedlegg']),
    ]);

    expect(conversion?.pages).toEqual([
      '# Innledning',
      'Drift',
      'Tabell 3',
      'Annen rapportering',
      'Vedlegg',
    ]);
    expect(conversion?.converter.name).toBe('docling');
  });

  it('a page Docling left empty before its last page with text stays empty', async () => {
    // A page with only its page number or a picture: Docling leaves it empty on purpose.
    const conversion = await read([
      docling(['# Innledning', '', 'Tabell 3', '', '']),
      textLayer(['Innledning', '12', 'Tabell 3', 'Annen rapportering', 'Vedlegg']),
    ]);

    expect(conversion?.pages).toEqual([
      '# Innledning',
      '',
      'Tabell 3',
      'Annen rapportering',
      'Vedlegg',
    ]);
  });

  it('a Docling conversion whose empty end is 5 % of its pages or less is read as stored', async () => {
    // A blank back cover of a 20-page report.
    const pages = [...Array.from({ length: 19 }, (_, i) => `Side ${i + 1}`), ''];
    const conversion = await read([docling(pages), textLayer([...pages.slice(0, 19), 'Logo'])]);

    expect(conversion?.pages).toEqual(pages);
  });

  it('a page of only no-break spaces counts as empty', async () => {
    const conversion = await read([
      docling(['Innledning', 'Drift', '\u00a0', '\u00a0\ufeff']),
      textLayer(['Innledning', 'Drift', 'Annen rapportering', 'Vedlegg']),
    ]);

    expect(conversion?.pages).toEqual(['Innledning', 'Drift', 'Annen rapportering', 'Vedlegg']);
  });

  it("a file with no text-layer conversion keeps Docling's pages as stored", async () => {
    const conversion = await read([docling(['# Innledning', '', 'Tabell 3', ''])]);

    expect(conversion?.pages).toEqual(['# Innledning', '', 'Tabell 3', '']);
  });
});
