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

  it('in a numbered document, a chapter word with a number is level 1', () => {
    const headings = [
      heading('Kapittel 1', 1),
      heading('1.1 Mandat', 1, 200),
      heading('1.2 Sammensetning', 2),
      heading('CHAPTER TWO: METHODS', 3),
      heading('2.1 Data', 3, 200),
    ];
    const sizes = [12, 12, 12, 12, 12];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([1, 2, 2, 1, 2]);
  });

  it('a chapter word does not count as a section number towards the numbered share', () => {
    const headings = [
      heading('Del en', 1),
      heading('Om ordningen', 1, 200),
      heading('Del to', 2),
      heading('Om søkerne', 2, 200),
      heading('1 Innledning', 3),
    ];
    const runs = headings.map((h, i) => run(h, i % 2 === 0 ? 18 : 13));
    // One numbered heading in five is under the share, so even «1 Innledning» is levelled by size.
    expect(headingLevels(headings, { outline: [], runs })[4]?.source).toBe('size-font');
  });

  it('a section number ending in zero parts counts without them, so «2.0» is depth 1', () => {
    const headings = [
      heading('1.0 Introduction', 1),
      heading('1.1 Scope', 1, 200),
      heading('2.0 Recommendations', 2),
      heading('2.1.0 Barriers', 2, 200),
    ];
    expect(levels(headings, [])).toEqual([1, 2, 1, 2]);
  });

  it('a section number with spaces around its dots counts every part', () => {
    const headings = [
      heading('3 Methods', 1),
      heading('3.1 Permanent changes', 1, 200),
      heading('3 .1. 1 Gene knockout', 2),
      heading('3 . 2 . 1 Knockdown', 2, 200),
    ];
    expect(levels(headings, [])).toEqual([1, 2, 3, 3]);
  });

  it('in a numbered document with parts, «Del II» is level 1 and the numbered chapters go one level down', () => {
    const headings = [
      heading('Del I Forvaltningen', 1),
      heading('1 Innledning', 1, 200),
      heading('1.1 Bakgrunn', 2),
      heading('Del II Avtalen', 3),
      heading('2 Hovedinnhold', 3, 200),
    ];
    expect(levels(headings, [])).toEqual([1, 2, 3, 1, 2]);
  });

  it('in a numbered document, an unnumbered heading smaller than the deepest numbered level goes one below it', () => {
    const headings = [
      heading('1 Innledning', 1),
      heading('1.1 Bakgrunn', 1, 200),
      heading('1.1.1 Tidligere vedtak', 2),
      heading('Lang sikt', 2, 200),
    ];
    const sizes = [16, 13, 12, 10];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([1, 2, 3, 4]);
  });

  it('without section numbers, a chapter word with a number is level 1 and the other headings rank below it', () => {
    const headings = [
      heading('Kapittel 2', 1),
      heading('Rettssystemet', 1, 200),
      heading('Tidligere anbefalinger', 2),
      heading('Kapittel 3', 3),
      heading('Rapporter', 3, 200),
      heading('Arrangementer', 4),
    ];
    // The chapter label is set smaller than the titles under it.
    const sizes = [10, 18, 14, 10, 18, 14];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('a numbered heading in a document with few numbers is levelled by its size, not below the outline heading', () => {
    const headings = [
      heading('Kapittel A', 1),
      heading('Bakgrunn', 1, 200),
      heading('Mer', 2),
      heading('Annet', 2, 200),
      heading('2.3.1 Detaljer', 3),
    ];
    const outline = [{ title: 'Kapittel A', level: 1, page: 1 }];
    const found = headingLevels(headings, { outline, runs: [] });
    expect(found[1]).toEqual({ level: 2, source: 'below-outline' });
    expect(found[4]?.source).not.toBe('below-outline');
  });

  it('a chapter word the outline does not list is level 1, not below the outline heading', () => {
    const headings = [
      heading('Innledning', 1),
      heading('Bakgrunn', 1, 200),
      heading('Kapittel 3', 2),
    ];
    const outline = [{ title: 'Innledning', level: 1, page: 1 }];
    expect(headingLevels(headings, { outline, runs: [] })[2]?.level).toBe(1);
  });

  it('a heading whose box gives no finite size is still level 1 or deeper', () => {
    const sized = heading('Tildeling', 1);
    const broken: LevelledHeading = {
      ...heading('Frister', 2),
      box: [0.1, NaN, 0.5, NaN] as PartBox,
    };
    expect(levels([sized, broken], [], [run(sized, 16)])).toEqual([1, 1]);
  });

  it('matches headings to an outline within a second on 500 titles that share every character', () => {
    // Every title is a different order of the same 200 characters, so none can be told apart by
    // counting characters, and each pair would need the full comparison.
    const letters = 'abcdefghijklmnopqrstuvwxyz'.repeat(8).slice(0, 200);
    const shuffled = (seed: number) => {
      const chars = [...letters];
      let state = seed + 1;
      for (let i = chars.length - 1; i > 0; i -= 1) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
      }
      return chars.join('');
    };
    const headings = Array.from({ length: 500 }, (_, i) => heading(shuffled(i), 2));
    const outline = Array.from({ length: 500 }, (_, i) => ({
      title: shuffled(1000 + i),
      level: 1,
      page: 2,
    }));
    const started = performance.now();
    headingLevels(headings, { outline, runs: [] });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('«Kap. 275 post 21» is a budget line, not a chapter', () => {
    const headings = [
      heading('Kap. 275 post 21', 1),
      heading('Tildeling', 1, 200),
      heading('KAP. 1400 POST 01', 2),
      heading('Frister', 2, 200),
      heading('Søknad', 3),
      heading('Krav', 3, 200),
    ];
    const sizes = [10, 18, 10, 14, 18, 14];
    const runs = headings.map((h, i) => run(h, sizes[i] as number));
    expect(levels(headings, [], runs)).toEqual([3, 1, 3, 2, 1, 2]);
  });

  it('reads section numbers and chapter words in linear time on long adversarial headings', () => {
    const texts = [
      `${'1 .'.repeat(50_000)}x`,
      `${'1. '.repeat(50_000)}x`,
      `Kapittel${' '.repeat(50_000)}${'I'.repeat(50_000)}`,
      `${' '.repeat(50_000)}Del${'\t'.repeat(50_000)}x`,
      `Kap. 275${' '.repeat(50_000)}postx`,
    ];
    const headings = texts.map((text, i) => heading(text, i + 1));
    const started = performance.now();
    headingLevels(headings, { outline: [], runs: [] });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
