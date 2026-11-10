import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  unescapeUntrusted,
  untrustedData,
  untrustedDataNote,
  untrustedDataNotes,
} from './untrusted.js';

const closer = '</untrusted_data>';
const hostile = fc.oneof(
  fc.string(),
  fc.string({
    unit: fc.constantFrom(
      '<',
      '/',
      '>',
      'untrusted_data',
      'UNTRUSTED_DATA',
      '&',
      'amp;',
      'lt;',
      'LT;',
      '\\u003c',
      '"',
      ' ',
      '\n',
    ),
  }),
);

const bodyOf = (framed: string) => framed.slice(framed.indexOf('>\n') + 2, -closer.length - 1);

describe('untrusted data framing', () => {
  it('lets no text close the frame early, and keeps the text recoverable', () => {
    fc.assert(
      fc.property(hostile, hostile, (text, title) => {
        const framed = untrustedData('source', text, { title });
        expect(framed.match(/<\/untrusted_data/gi)).toHaveLength(1);
        expect(framed.endsWith(`\n${closer}`)).toBe(true);
        expect(framed.match(/<\/?untrusted_data/gi)).toHaveLength(2);
        expect(unescapeUntrusted(bodyOf(framed))).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it('leaves text without the tag unchanged', () => {
    const text = 'a < b && c > d, se <b>fet</b> &lt;';
    expect(untrustedData('source', text)).toBe(
      `<untrusted_data kind="source">\n${text}\n</untrusted_data>`,
    );
  });

  it('writes the id and title as attributes and leaves out empty ones', () => {
    expect(
      untrustedData('source', 'x', { id: 'doc-1', title: 'A "quoted" <title>', url: '' }),
    ).toBe(
      '<untrusted_data kind="source" id="doc-1" title="A &quot;quoted&quot; &lt;title>">\nx\n</untrusted_data>',
    );
  });

  it('says that framed text is data in the service language, bokmål unless English comes first', () => {
    expect(untrustedDataNote(['en', 'nb'])).toBe(untrustedDataNotes.en);
    expect(untrustedDataNote(['nb', 'en'])).toBe(untrustedDataNotes.nb);
    expect(untrustedDataNote(undefined)).toBe(untrustedDataNotes.nb);
    expect(untrustedDataNotes.nb).toMatch(/data, ikke instruksjoner/);
    expect(untrustedDataNotes.en).toMatch(/data, not instructions/);
  });
});
