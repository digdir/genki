import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const css = read('settings.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
const page = read('../../../../docs/components/settings.html');

/** Every `var(--genai-…, fallback)` in the sheet, with its fallback. */
const uses = [...css.matchAll(/var\((--genai-[a-z-]+), ?(var\(--[a-z0-9-]+\)|[^()]+)\)/g)].map(
  ([whole, name = '', fallback = '']) => ({ whole, name, fallback }),
);
/** What is left once every use of a block variable is taken out. */
const outside = uses.reduce((rest, use) => rest.replace(use.whole, ''), css);

describe('the Settings styles', () => {
  it('sit in one layer after Designsystemet’s, so a host’s own CSS wins', () => {
    expect(
      css.trim().startsWith('@layer ds.theme, ds.base, ds.components, genai.components;'),
    ).toBe(true);
    expect(css.match(/@layer\s+[\w.]+\s*\{/g)).toEqual(['@layer genai.components {']);
  });

  it('hold no literal colour, only Designsystemet tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
  });

  it('read every token through a --genai-settings- variable, with the token as the fallback', () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use.name).toMatch(/^--genai-settings-[a-z]+(?:-[a-z]+)*$/);
      expect(use.fallback).toMatch(
        /^(?:var\(--ds-[a-z0-9-]+\)|\d*\.?\d+(?:px|rem|em|r?lh|ch|%)?)$/,
      );
    }
    expect(outside.match(/var\(--ds-[a-z0-9-]+\)/g) ?? []).toEqual([]);
  });

  it('hold no literal size or weight outside a variable', () => {
    expect(
      outside.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|[dsl]?vh|vw|ch|%)(?![\w-])/g) ?? [],
    ).toEqual([]);
    expect(css.match(/font-weight:\s*\d/g) ?? []).toEqual([]);
  });

  it('never set a --genai- variable, which is the host’s to set', () => {
    expect(css).not.toMatch(/--genai-[a-z-]+\s*:/);
  });

  it('follow the host’s data-color, but for the note, pinned to neutral so it reads as no link', () => {
    const family = /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/;
    expect(uses.filter((use) => family.test(use.fallback)).map((use) => use.whole)).toEqual([
      'var(--genai-settings-note-color, var(--ds-color-neutral-text-subtle))',
    ]);
  });

  it('are each listed on the component page', () => {
    const names = [...new Set(uses.map((use) => use.name))];
    expect(names.filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});
