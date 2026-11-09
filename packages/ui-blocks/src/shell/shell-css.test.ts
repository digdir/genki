import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const css = read('shell.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\( /g, '(')
  .replace(/,? \)/g, ')');
const page = read('../../../../docs/components/shell.html');

/** Every `var(--genai-…, fallback)`, with its fallback, which may itself be a `var()`. */
const uses = (() => {
  const found: { whole: string; name: string; fallback: string }[] = [];
  for (let start = css.indexOf('var(--genai-'); start >= 0;) {
    let depth = 0;
    let end = start;
    for (; end < css.length; end += 1) {
      if (css[end] === '(') depth += 1;
      if (css[end] === ')' && --depth === 0) break;
    }
    const whole = css.slice(start, end + 1);
    const inner = whole.slice(4, -1);
    const comma = inner.indexOf(',');
    found.push({ whole, name: inner.slice(0, comma), fallback: inner.slice(comma + 1).trim() });
    start = css.indexOf('var(--genai-', end + 1);
  }
  return found;
})();
/** What is left once every use of a block variable is taken out. */
const outside = uses.reduce((rest, use) => rest.replace(use.whole, ''), css);
/** A size no token has, allowed only as the single fallback of a named variable. */
const literal = /^\d*\.?\d+(?:px|rem|em|r?lh|ch|%|[dsl]?vh|vw)$/;

// The chrome is neutral on purpose, as kunnskapsassistenten's shell: the page, the panels, the
// rails, the bar and the borders stay grey whatever data-color the host sets.
const neutralPins = [
  '--genai-shell-background',
  '--genai-shell-bar-background',
  '--genai-shell-border-color',
  '--genai-shell-drawer-background',
  '--genai-shell-primary-background',
  '--genai-shell-rail-background',
  // The secondary panel's tool tabs are its own chrome, grey as the design draws them.
  '--genai-shell-tools-tab-color',
  '--genai-shell-tools-tab-hover-background',
  '--genai-shell-tools-tab-selected-background',
  '--genai-shell-tools-tabs-background',
];

describe('the Shell styles', () => {
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

  it('read every token through a --genai-shell- variable, with the token as the fallback', () => {
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use.name).toMatch(/^--genai-shell-[a-z]+(?:-[a-z]+)*$/);
      expect(use.fallback).toMatch(
        /^(?:var\(--(?:ds-[a-z0-9-]+|_shell-region)\)|\d*\.?\d+[a-z%]*)$/,
      );
    }
    expect(outside.match(/var\(--(?:ds-|_)[a-z0-9-]+\)/g) ?? []).toEqual([]);
  });

  it('hold no literal size or weight outside a variable, and a literal only behind one', () => {
    expect(
      outside.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|[dsl]?v[hw]|vmin|vmax|pt|ch|ex)\b/g) ??
        [],
    ).toEqual([]);
    expect(css.match(/font-weight:\s*\d/g) ?? []).toEqual([]);
    for (const use of uses.filter((u) => literal.test(u.fallback)))
      expect(use.name).toMatch(/^--genai-shell-[a-z]+(?:-[a-z]+)+$/);
  });

  it('take the widths from the shell’s own sums, never from a host variable', () => {
    const sums = [...new Set(css.match(/--uib-shell-[a-z-]+/g) ?? [])].sort();
    expect(sums).toEqual([
      '--uib-shell-main-max-width',
      '--uib-shell-main-min-width',
      '--uib-shell-primary-drawer-width',
      '--uib-shell-primary-min-width',
      '--uib-shell-primary-width',
      '--uib-shell-secondary-drawer-width',
      '--uib-shell-secondary-min-width',
      '--uib-shell-secondary-width',
    ]);
    expect(css).not.toMatch(/--uib-shell-[a-z-]+\s*:/);
  });

  it('never set a --genai- variable, which is the host’s to set', () => {
    expect(css).not.toMatch(/--genai-[a-z-]+\s*:/);
  });

  it('pin only the chrome to the neutral family, each pin by name', () => {
    const family = /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/;
    const pinned = [...new Set(uses.filter((use) => family.test(use.fallback)).map((u) => u.name))];
    expect(pinned.sort()).toEqual(neutralPins);
    for (const name of neutralPins)
      for (const use of uses.filter((u) => u.name === name))
        expect(use.fallback).toMatch(/^var\(--ds-color-neutral-/);
  });

  it('give the separator’s line the accent role without a family, since it is interactive', () => {
    expect(uses.find((use) => use.name === '--genai-shell-separator-line-color')?.fallback).toBe(
      'var(--ds-color-base-default)',
    );
  });

  it('hide what React hides, which the layer would otherwise show', () => {
    expect(css).toContain('.uib-shell-content[hidden] { display: none; }');
    expect(css).toContain('.uib-shell-drawer[open] { display: flex;');
  });

  it('are each listed on the component page', () => {
    const names = [...new Set(uses.map((use) => use.name))];
    expect(names.filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});

// A `data-color` written into the markup is a pin a host's `color` cannot reach (V2-0009 §3):
// each is named here and justified by the comment on the line above it.
describe('the Shell markup', () => {
  it('pins to neutral only the panel buttons kunnskapsassistenten draws neutral, with the reason', () => {
    const lines = readFileSync(`${import.meta.dirname}/Shell.tsx`, 'utf8').split('\n');
    const at = lines.flatMap((line, index) =>
      line.includes('data-color="neutral"') ? [index] : [],
    );
    expect(at).toHaveLength(1);
    for (const index of at) {
      expect(lines[index - 1]?.trim()).toMatch(/^\/\/ Pinned to neutral, as kunnskapsassistenten/);
      expect(lines[index - 2]).toContain('uib-shell-toggle');
    }
  });
});
