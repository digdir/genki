import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const flatten = (css: string) =>
  css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');

// Every block's own stylesheet, branded the Designsystemet way. ui-blocks.css still
// holds Approach, which joins when it moves into a folder of its own.
const sheets = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.css') && path.includes('/'))
  .sort()
  .map((path) => {
    const css = strip(read(path));
    return { path, css, flat: flatten(css) };
  });
const pagesDir = '../../../docs/components';
const pages = readdirSync(`${import.meta.dirname}/${pagesDir}`)
  .filter((file) => file.endsWith('.html'))
  .map((file) => read(`${pagesDir}/${file}`))
  .join('\n');

const genaiUses = (text: string) => {
  const uses: { name: string; fallback: string; start: number; end: number }[] = [];
  for (let start = text.indexOf('var(--genai-'); start >= 0;) {
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')' && --depth === 0) break;
    }
    const inner = text.slice(start + 4, end);
    const comma = inner.indexOf(',');
    uses.push({
      name: comma < 0 ? inner : inner.slice(0, comma),
      fallback: comma < 0 ? '' : inner.slice(comma + 1).trim(),
      start,
      end: end + 1,
    });
    start = text.indexOf('var(--genai-', end + 1);
  }
  return uses;
};

// A value no token has, such as a width or a line count, is allowed as the fallback of a block's
// own variable, so a host can still change it.
const literal = /^(?:\d*\.?\d+(?:px|rem|em|r?lh|ch|%)?)$/;
const isLiteralFallback = (use: { fallback: string }) => literal.test(use.fallback);

// Pinned to a colour family on purpose, each with a comment in the CSS.
const accentPins = [
  '--genai-sources-toggle-color',
  '--genai-sources-excerpt-active-background',
  '--genai-sources-excerpt-active-marker-color',
];
const warningPins = [
  '--genai-sources-mark-background',
  '--genai-sources-mark-color',
  '--genai-sources-mark-current-background',
  '--genai-sources-mark-current-color',
];

describe.each(sheets)('the styles in $path', ({ css, flat }) => {
  it('hold no literal colour, only Designsystemet tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
    expect(
      css.match(/:\s*(?:white|black|red|blue|green|gr[ae]y|orange|yellow|purple)\b/gi) ?? [],
    ).toEqual([]);
  });

  it('hold no literal size or weight outside a --genai- fallback, but the container query', () => {
    let rest = flat;
    for (const use of genaiUses(flat).filter(isLiteralFallback).reverse())
      rest = rest.slice(0, use.start) + rest.slice(use.end);
    const sizes = rest
      .replace(/@container [^{]+\{/g, '')
      .match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|vh|vw|vmin|vmax|pt|ch|ex|cm|mm|in)\b/g);
    expect(sizes ?? []).toEqual([]);
    expect(css.match(/font-weight:\s*\d/g) ?? []).toEqual([]);
  });

  it('read every token through a --genai- variable, with the token as the fallback', () => {
    let outside = flat;
    for (const use of genaiUses(flat).reverse())
      outside = outside.slice(0, use.start) + outside.slice(use.end);
    const holders = outside.match(/--_[a-z-]+: [^;]+;/g) ?? [];
    for (const holder of holders) {
      expect(holder).toMatch(/^--_[a-z-]+: (?:var\(--ds-[a-z0-9-]+\) ?)+;$/);
      outside = outside.replace(holder, '');
    }
    expect(outside.match(/var\(--(?:ds-|_)[a-z0-9-]+\)/g) ?? []).toEqual([]);
    const read = genaiUses(flat).map((use) => use.fallback);
    for (const name of new Set(holders.map((h) => h.slice(0, h.indexOf(':')))))
      expect(read).toContain(`var(${name})`);
    for (const use of genaiUses(flat).filter((u) => !isLiteralFallback(u)))
      expect(`${use.name} ${use.fallback}`).toMatch(
        /^--genai-[a-z-]+ (?:var\(--(?:ds-[a-z0-9-]+|_[a-z-]+)\) ?)+$/,
      );
  });

  it('never set a --genai- variable, which is the host’s to set', () => {
    expect(css).not.toMatch(/--genai-[a-z-]+\s*:/);
  });

  it('sit in one layer after Designsystemet’s, so a host’s own CSS wins', () => {
    expect(
      css.trim().startsWith('@layer ds.theme, ds.base, ds.components, genai.components;'),
    ).toBe(true);
    expect(css.match(/@layer\s+[\w.]+\s*\{/g)).toEqual(['@layer genai.components {']);
  });

  it('take a literal only as a single value behind a --genai- variable', () => {
    for (const use of genaiUses(flat).filter(isLiteralFallback))
      expect(use.name).toMatch(/^--genai-[a-z]+(?:-[a-z]+)+$/);
  });

  it('are each listed on a component page', () => {
    const names = new Set(genaiUses(flat).map((use) => use.name));
    expect([...names].filter((name) => !pages.includes(`<code>${name}</code>`))).toEqual([]);
  });
});

describe('the lint', () => {
  it('reads every block stylesheet, Sources and the shared Markdown among them', () => {
    expect(sheets.map((sheet) => sheet.path)).toEqual(
      expect.arrayContaining(['markdown/markdown.css', 'sources/sources.css']),
    );
  });

  it('accepts a literal width behind a variable, and refuses the same width bare', () => {
    const behind = flatten('a { inline-size: var(--genai-picker-list-width, 24rem); }');
    const bare = flatten('a { inline-size: 24rem; }');
    expect(genaiUses(behind).every(isLiteralFallback)).toBe(true);
    expect(genaiUses(bare)).toEqual([]);
    expect(bare.match(/\d+rem/)).not.toBeNull();
  });
});

describe('the Sources styles', () => {
  const flat = sheets.find((sheet) => sheet.path === 'sources/sources.css')?.flat ?? '';

  it('follow the host’s colour family, but for the seven deliberate pins', () => {
    const uses = genaiUses(flat);
    const pinned = uses
      .filter((use) =>
        /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.fallback),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual([...accentPins, ...warningPins].sort());
    for (const name of accentPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-accent-/);
    for (const name of warningPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-warning-/);
  });

  it('say that a closed card’s body is hidden, which the layer would otherwise undo', () => {
    expect(flat).toContain('.uib-sources-document-body[hidden] { display: none; }');
  });
});
