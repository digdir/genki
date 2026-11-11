import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The blocks' token lint (`ui-blocks/src/styles.test.ts`), held to the assembly's own sheet.
const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const css = read('ui-assembly.css').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');
const page = read('../../../docs/components/ui-assembly.html');

/** Each `var(--genai-…, fallback)` with where it stands, nested `var()`s and all. */
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
const literal = /^(?:\d*\.?\d+(?:px|rem|em|r?lh|ch|%|[dsl]?vh|vw)?)$/;
/** The sheet with every `var(--genai-…)` taken out, fallback and all. */
const outside = genaiUses(flat)
  .reverse()
  .reduce((rest, use) => rest.slice(0, use.start) + rest.slice(use.end), flat);

describe('the assembly’s styles', () => {
  it('hold no literal colour, only Designsystemet tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
    expect(
      css.match(/:\s*(?:white|black|red|blue|green|gr[ae]y|orange|yellow|purple)\b/gi) ?? [],
    ).toEqual([]);
  });

  it('hold no literal size outside a --genai- fallback', () => {
    expect(
      outside.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|[dsl]?v[hw]|vmin|vmax|pt|ch)\b/g) ?? [],
    ).toEqual([]);
    for (const use of genaiUses(flat).filter((u) => literal.test(u.fallback)))
      expect(use.name).toMatch(/^--genai-assembly-[a-z-]+$/);
  });

  it('read every token through a --genai- variable, with the token as the fallback', () => {
    expect(outside.match(/var\(--(?:ds-|uib-)[a-z0-9-]+\)/g) ?? []).toEqual([]);
    for (const use of genaiUses(flat).filter((u) => !literal.test(u.fallback)))
      expect(`${use.name} ${use.fallback}`).toMatch(
        /^--genai-[a-z-]+ (?:var\(--ds-[a-z0-9-]+\) ?)+$/,
      );
  });

  it('keep what they hold in `--_uia-` variables, and never set a --genai- one, which is the host’s', () => {
    expect(css).not.toMatch(/--genai-[a-z-]+\s*:/);
    expect(css.match(/--[a-z_-]+(?=\s*:)/g)?.every((name) => name.startsWith('--_uia-'))).toBe(
      true,
    );
  });

  it('style only the assembly’s own classes, so a block’s class can change under it', () => {
    const selectors = css.replace(/@layer[^;{]*[;{]/g, '');
    const classes = [...new Set(selectors.match(/\.[a-z][\w-]*/g) ?? [])];
    expect(classes.filter((name) => !name.startsWith('.uia-'))).toEqual([]);
  });

  it('sit in one layer after Designsystemet’s, so a host’s own CSS wins', () => {
    expect(
      css.trim().startsWith('@layer ds.theme, ds.base, ds.components, genai.components;'),
    ).toBe(true);
    expect(css.match(/@layer\s+[\w.]+\s*\{/g)).toEqual(['@layer genai.components {']);
  });

  it('read only their own variables and the shell’s end padding, each listed on the assembly’s page', () => {
    const names = [...new Set(genaiUses(flat).map((use) => use.name))];
    expect(
      names.filter(
        (name) =>
          !name.startsWith('--genai-assembly-') && name !== '--genai-shell-main-padding-block-end',
      ),
    ).toEqual([]);
    expect(names.filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});
