import { describe, expect, it } from 'vitest';
import { doc } from './docling-document.test-utils.js';
import { doclingParts } from './docling-parts.js';

/** Near the bottom edge of an 800-point page. */
const footer = 770;

/** The labels of a document with one page footer a page; null leaves the page without one. */
const labelsOf = (footers: (string | null)[]) =>
  doclingParts(
    doc(footers.length, (add) =>
      footers.forEach((text, i) => {
        add.text('text', `Brødtekst på side ${i + 1}.`, i + 1);
        if (text !== null) add.text('page_footer', text, i + 1, { top: footer });
      }),
    ),
  ).units.map((unit) => unit.label);

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('page labels', () => {
  it('a printed label is kept only when a neighbouring page agrees', () => {
    // Page 4's 9 is 5 ahead of its page; page 3's 5 is 2 ahead.
    expect(labelsOf(['3', '4', '5', '9'])).toEqual(['3', '4', '5', null]);
  });

  it('a label with no labelled page within 2 pages is dropped', () => {
    expect(labelsOf(['1', null, '3', null, null, '6'])).toEqual(['1', null, '3', null, null, null]);
  });

  it('a chapter number in a page header is not a page label', () => {
    const { units } = doclingParts(
      doc(5, (add) => {
        for (let page = 1; page <= 5; page += 1) {
          if (page === 3) add.text('page_header', '7', page, { top: 20 });
          add.text('text', `Brødtekst på side ${page}.`, page);
          add.text('page_footer', String(page + 9), page, { top: footer });
        }
      }),
    );
    expect(units.map((unit) => unit.label)).toEqual(['10', '11', null, '13', '14']);
  });

  it('side 3 av 9 gives the label 3', () => {
    expect(labelsOf(['Side 2 av 9', 'side 3 av 9', 'side  4\nav 9'])).toEqual(['2', '3', '4']);
  });

  it('a number in the body is never a label', () => {
    const { units } = doclingParts(
      doc(3, (add) => {
        for (let page = 1; page <= 3; page += 1)
          add.text('text', `side ${page} av 3`, page, { top: 400 });
      }),
    );
    expect(units.map((unit) => unit.label)).toEqual([null, null, null]);
  });

  it("a lone page number at the page's edge is a label", () => {
    const { units } = doclingParts(
      doc(3, (add) => {
        for (let page = 1; page <= 3; page += 1) {
          add.text('text', `Brødtekst på side ${page}.`, page);
          add.text('text', String(page + 4), page, { top: footer });
        }
      }),
    );
    expect(units.map((unit) => unit.label)).toEqual(['5', '6', '7']);
  });

  it('a label drops its leading zeros', () => {
    expect(labelsOf(['s. 007', 's. 008'])).toEqual(['7', '8']);
  });

  it('the pattern is linear on a long adversarial string', () => {
    const adversarial = [
      `s.${' 1'.repeat(50_000)}x`,
      `${'1 av '.repeat(40_000)}x`,
      `side${' '.repeat(100_000)}x`,
      `${'1'.repeat(100_000)}x`,
      `${'side'.repeat(50_000)}1`,
    ];
    expect(quickly(() => labelsOf(adversarial))).toBeLessThan(1000);
    expect(labelsOf(adversarial)).toEqual([null, null, null, null, null]);
  });
});
