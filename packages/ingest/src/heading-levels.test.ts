import type { PartBox } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import {
  headingLevels,
  type LevelledHeading,
  type OutlineEntry,
  type PdfTextRun,
} from './heading-levels.js';

const pageHeight = 800;

/** A heading on `page`, one line at `top` points from the page's top. */
const heading = (text: string, page: number, top = 100, lineHeight = 12): LevelledHeading => ({
  text,
  page,
  box: [0.1, top / pageHeight, 0.5, (top + lineHeight) / pageHeight] as PartBox,
  pageHeight,
});

/** The text layer's run inside a heading's box, at `size` points. */
const run = (h: LevelledHeading, size: number, bold = false): PdfTextRun => ({
  page: h.page as number,
  box: h.box as PartBox,
  size,
  bold,
  chars: h.text.replace(/\s/g, '').length,
});

const levels = (
  headings: LevelledHeading[],
  outline: OutlineEntry[],
  runs: PdfTextRun[] = [],
  options = {},
) => headingLevels(headings, { outline, runs }, options).map((r) => r.level);

describe('heading levels', () => {
  it("a heading in the PDF's outline takes the outline's level", () => {
    const headings = [heading('Tildeling av tilskudd', 1), heading('Krav til søknaden', 2)];
    const outline = [
      { title: 'Tildeling av tilskudd', level: 1, page: 1 },
      { title: 'Krav til søknaden', level: 3, page: 2 },
    ];
    expect(headingLevels(headings, { outline, runs: [] })).toEqual([
      { level: 1, source: 'outline' },
      { level: 3, source: 'outline' },
    ]);
  });

  it('an outline entry matches a heading on the page next to its own, by its text without the number', () => {
    const headings = [heading('Innledning', 1), heading('3.2 Søknad om støtte', 4)];
    const outline = [
      { title: 'Innledning', level: 1, page: 1 },
      { title: 'Søknad om støtte', level: 2, page: 3 },
    ];
    expect(levels(headings, outline)).toEqual([1, 2]);
  });

  it("a numbered heading not in the outline takes its number's depth", () => {
    const headings = [
      heading('1 Innledning', 1),
      heading('1.1 Bakgrunn', 1, 200),
      heading('1.1.2 Tidligere vedtak', 2),
    ];
    const outline = [{ title: 'Innledning', level: 1, page: 1 }];
    expect(headingLevels(headings, { outline, runs: [] }).slice(1)).toEqual([
      { level: 2, source: 'number' },
      { level: 3, source: 'number' },
    ]);
  });

  it('an outline entry with no page destination is skipped', () => {
    const headings = [heading('Vedlegg', 1), heading('Kilder', 6)];
    const outline = [
      { title: 'Vedlegg', level: 2, page: null },
      { title: 'Kilder', level: 1, page: 6 },
    ];
    const found = headingLevels(headings, { outline, runs: [] });
    expect(found[0]?.source).not.toBe('outline');
    expect(found[1]).toEqual({ level: 1, source: 'outline' });
  });

  it('an unnumbered heading the outline does not list goes one level below the outline heading before it', () => {
    const headings = [heading('Tildeling', 1), heading('Krav til søker', 2), heading('Frister', 3)];
    const outline = [
      { title: 'Tildeling', level: 2, page: 1 },
      { title: 'Frister', level: 1, page: 3 },
    ];
    expect(headingLevels(headings, { outline, runs: [] })[1]).toEqual({
      level: 3,
      source: 'below-outline',
    });
  });

  it('with the outline rung off, a heading the outline lists is levelled by the other rungs', () => {
    const headings = [heading('Tildeling', 1), heading('Krav til søker', 2)];
    const outline = [{ title: 'Krav til søker', level: 2, page: 2 }];
    const runs = [run(headings[0] as LevelledHeading, 16), run(headings[1] as LevelledHeading, 12)];
    expect(levels(headings, outline, runs, { outline: false })).toEqual([1, 2]);
  });

  it('without section numbers, the biggest text size is level 1 and the next level 2', () => {
    const headings = [
      heading('Del en', 1),
      heading('Om ordningen', 1, 200),
      heading('Del to', 2),
      heading('Om søkerne', 2, 200),
    ];
    const runs = headings.map((h, i) => run(h, i % 2 === 0 ? 18 : 13));
    expect(headingLevels(headings, { outline: [], runs })).toEqual([
      { level: 1, source: 'size-font' },
      { level: 2, source: 'size-font' },
      { level: 1, source: 'size-font' },
      { level: 2, source: 'size-font' },
    ]);
  });

  it('a size only one heading has joins the nearest size more headings have', () => {
    const headings = ['Del en', 'Om ordningen', 'Del to', 'Om søkerne', 'Merknad'].map((t, i) =>
      heading(t, i + 1),
    );
    const sizes = [18, 13, 18, 13, 13.5];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([1, 2, 1, 2, 2]);
  });

  it('bold counts as a little bigger, so a bold heading ranks above a regular one of the same size', () => {
    const headings = ['Del en', 'Om ordningen', 'Del to', 'Om søkerne'].map((t, i) =>
      heading(t, i + 1),
    );
    const runs = headings.map((h, i) => run(h, 12, i % 2 === 0));
    expect(levels(headings, [], runs)).toEqual([1, 2, 1, 2]);
  });

  it('a heading with no text layer in its box is levelled by its box height, as on a scan', () => {
    const headings = [
      heading('Del en', 1, 100, 24),
      heading('Om ordningen', 1, 200, 14),
      heading('Del to', 2, 100, 24),
      heading('Om søkerne', 2, 200, 14),
    ];
    expect(headingLevels(headings, { outline: [], runs: [] })).toEqual([
      { level: 1, source: 'size-box' },
      { level: 2, source: 'size-box' },
      { level: 1, source: 'size-box' },
      { level: 2, source: 'size-box' },
    ]);
  });

  it('in a numbered document, an unnumbered heading takes the numbered level nearest its size', () => {
    const headings = [
      heading('1 Innledning', 1),
      heading('1.1 Bakgrunn', 1, 200),
      heading('Om rapporten', 2),
      heading('2 Funn', 3),
    ];
    const sizes = [16, 12, 12.2, 16];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([1, 2, 2, 1]);
  });

  it('a year at the start of a heading is not a section number', () => {
    const headings = [heading('2025 Årsrapport', 1), heading('Innledning', 2)];
    const runs = [run(headings[0] as LevelledHeading, 12), run(headings[1] as LevelledHeading, 18)];
    expect(levels(headings, [], runs)).toEqual([2, 1]);
  });
});
