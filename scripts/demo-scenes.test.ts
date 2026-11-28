import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  backdropOf,
  boardColumnX,
  chapterRows,
  cueTimes,
  definitionExcerpt,
  filmLayout,
  sectionLabel,
  softHyphen,
  tokens,
  wrapText,
} from './demo-scenes.ts';

describe('film scenes', () => {
  it('draws only colours from the Digdir theme the portal and console load', () => {
    const theme = readFileSync(
      new URL('../node_modules/@digdir/designsystemet-theme/brand/digdir.css', import.meta.url),
      'utf8',
    ).toLowerCase();
    for (const [name, colour] of Object.entries(tokens))
      expect(theme, `${name} ${colour}`).toContain(colour.toLowerCase());
  });

  it('frames the app at 120,200 in 1560 by 730, under the section label at 120,54 and the title at 120,104', () => {
    expect(filmLayout.frame).toEqual({ x: 120, y: 200, width: 1560, height: 730 });
    expect(filmLayout.eyebrow).toMatchObject({ x: 120, y: 54 });
    expect(filmLayout.title).toMatchObject({ x: 120, y: 104 });
    expect(filmLayout.narrator).toMatchObject({ x: 1716, y: 890 });
  });

  it('lays the board out in three columns 580 apart from the left margin', () => {
    expect([0, 1, 2].map(boardColumnX)).toEqual([120, 700, 1280]);
  });

  it('puts screens and boards on the light background, and titles, cards, code and the close on the dark one', () => {
    expect(backdropOf('screen')).toBe('light');
    expect(backdropOf('board')).toBe('light');
    expect(['title', 'chapter', 'code', 'close'].map((t) => backdropOf(t as 'title'))).toEqual([
      'dark',
      'dark',
      'dark',
      'dark',
    ]);
  });

  it('fits every chapter of a chapter card on the screen, however many there are', () => {
    for (let count = 1; count <= 12; count++) {
      const { top, gap, size } = chapterRows(count);
      expect(top + (count - 1) * gap + size * 1.33).toBeLessThan(1000);
    }
    expect(chapterRows(2).size).toBe(84);
  });

  it('labels a section with its part number and chapter in the language of the demo', () => {
    expect(sectionLabel(2, 'Hvor langt vi har kommet', 'nb-NO')).toBe(
      'Del 2 · Hvor langt vi har kommet',
    );
    expect(sectionLabel(1, 'The platform', 'en-GB')).toBe('Part 1 · The platform');
  });

  it('shows each item when its cue word is said, in order, and a missing cue just after the one before', () => {
    const words = ['Innlogging,', 'logging,', 'avtaler', 'og', 'drift.'].map((text, i) => ({
      text,
      at: 10 + i,
    }));
    expect(cueTimes(words, ['innlogging', 'logging', 'drift'], 9)).toEqual([10, 11, 14]);
    expect(cueTimes(words, ['logging', 'innlogging'], 9)).toEqual([11, 11.12]);
    expect(cueTimes(words, [undefined, 'avtaler'], 9)).toEqual([9, 12]);
  });

  it('breaks a title that is too wide at its soft hyphen', () => {
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = '600 72px sans-serif';
    const lines = wrapText(ctx, `Kunnskaps${softHyphen}assistenten`, 500);
    expect(lines).toEqual(['Kunnskaps-', 'assistenten']);
    expect(wrapText(ctx, `Kunnskaps${softHyphen}assistenten`, 5000)).toEqual([
      'Kunnskapsassistenten',
    ]);
  });

  it('quotes an example definition without its comments, and nothing outside the examples', () => {
    const excerpt = definitionExcerpt('kunnskapsassistenten', 13);
    expect(excerpt).toHaveLength(13);
    expect(excerpt.some((l) => l.trimStart().startsWith('#'))).toBe(false);
    expect(excerpt.every((l) => l.length <= 52)).toBe(true);
    expect(() => definitionExcerpt('../../package')).toThrow(/not an example/);
  });
});
