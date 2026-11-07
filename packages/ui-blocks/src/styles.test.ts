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

// A value no token has, such as a width, a viewport height or a line count, is allowed as the
// fallback of a block's own variable, so a host can still change it.
const literal = /^(?:\d*\.?\d+(?:px|rem|em|r?lh|ch|%|[dsl]?vh|vw)?)$/;
const isLiteralFallback = (use: { fallback: string }) => literal.test(use.fallback);

const literalSizes = (flat: string) => {
  let rest = flat;
  for (const use of genaiUses(flat).filter(isLiteralFallback).reverse())
    rest = rest.slice(0, use.start) + rest.slice(use.end);
  return (
    rest
      .replace(/@container [^{]+\{/g, '')
      .match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|[dsl]?v[hw]|vmin|vmax|pt|ch|ex|cm|mm|in)\b/g) ??
    []
  );
};

// Pinned to a colour family on purpose, each with a comment in the CSS.
const accentPins = [
  '--genai-sources-toggle-color',
  '--genai-sources-excerpt-active-background',
  '--genai-sources-excerpt-active-marker-color',
];
// The disclaimer is grey in kunnskapsassistenten whatever the host's family.
const neutralPins = ['--genai-sources-disclaimer-color'];
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
    expect(literalSizes(flat)).toEqual([]);
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

  it.each([
    ['inline-size', '24rem'],
    ['max-block-size', '30dvh'],
    ['max-block-size', '40svh'],
    ['block-size', '50vh'],
    ['inline-size', '80vw'],
  ])('accepts %s: %s behind a variable, and refuses it bare', (property, value) => {
    const behind = flatten(`a { ${property}: var(--genai-block-${property}, ${value}); }`);
    const bare = flatten(`a { ${property}: ${value}; }`);
    expect(literalSizes(behind)).toEqual([]);
    expect(literalSizes(bare)).toEqual([value]);
  });
});

describe('the Sources styles', () => {
  const flat = sheets.find((sheet) => sheet.path === 'sources/sources.css')?.flat ?? '';

  it('follow the host’s colour family, but for the eight deliberate pins', () => {
    const uses = genaiUses(flat);
    const pinned = uses
      .filter((use) =>
        /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.fallback),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual(
      [...accentPins, ...warningPins, ...neutralPins].sort(),
    );
    for (const name of accentPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-accent-/);
    for (const name of warningPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-warning-/);
    for (const name of neutralPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-neutral-/);
  });

  it('say that a closed card’s body is hidden, which the layer would otherwise undo', () => {
    expect(flat).toContain('.uib-sources-document-body[hidden] { display: none; }');
  });

  it('give a document’s title the card’s whole width, with its controls under it', () => {
    const head = flat.match(/\.uib-sources-document-head \{([^}]*)\}/)?.[1] ?? '';
    expect(head).toContain('flex-direction: column');
  });

  it('keep each link back at least 24 px both ways, which a size token under data-size="sm" is not', () => {
    const rule = flat.match(/\.uib-sources-use \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('min-inline-size: var(--genai-sources-use-min-size, 24px)');
    expect(rule).toContain('min-block-size: var(--genai-sources-use-min-size, 24px)');
  });

  it('draw «Utdrag N» two steps larger and bolder than the links back beside it', () => {
    const title = flat.match(/\.uib-sources-excerpt-number \{([^}]*)\}/)?.[1] ?? '';
    const uses = flat.match(/\.uib-sources-uses \{([^}]*)\}/)?.[1] ?? '';
    expect(title).toContain(
      'var(--genai-sources-excerpt-number-font-size, var(--ds-body-md-font-size))',
    );
    expect(title).toContain(
      'var(--genai-sources-excerpt-number-font-weight, var(--ds-font-weight-semibold))',
    );
    expect(uses).toContain('var(--genai-sources-uses-font-size, var(--ds-body-xs-font-size))');
    expect(uses).toContain('var(--genai-sources-uses-font-weight, var(--ds-font-weight-regular))');
  });
});

describe('the shared footnote mark', () => {
  const flat = sheets.find((sheet) => sheet.path === 'footnote/footnote.css')?.flat ?? '';
  const uses = genaiUses(flat);
  const pins = [
    '--genai-footnote-background',
    '--genai-footnote-border-color',
    '--genai-footnote-color',
    '--genai-footnote-hover-background',
    '--genai-footnote-hover-color',
  ];

  it('follows the host’s colour family, but for its five accent pins', () => {
    const pinned = uses
      .filter((use) =>
        /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.fallback),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual(pins.sort());
    for (const name of pins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-accent-/);
  });

  it('is drawn in one size wherever it stands, whatever data-size a table sets around it', () => {
    // Designsystemet's size tokens shrink under data-size="sm": 11 px marks in tables, 12 in text.
    const mark = flat.match(/\.uib-footnote-mark \{([^}]*)\}/)?.[1] ?? '';
    for (const name of ['size', 'padding', 'font-size'])
      expect(mark).toMatch(new RegExp(`var\\(--genai-footnote-${name}, [\\d.]+rem\\)`));
    expect(mark).not.toMatch(/--ds-(?:size|font-size)-/);
    const raised = flat.match(/\.uib-footnote-mark\[data-raised\] \{([^}]*)\}/)?.[1] ?? '';
    for (const name of ['gap', 'raise'])
      expect(raised).toMatch(new RegExp(`var\\(--genai-footnote-${name}, [\\d.]+rem\\)`));
  });

  it('sets the circle apart from the card with a strong ring, not the fill alone', () => {
    // The tinted fill is 1.2:1 on the card; a border-strong ring is over 3:1 in both themes.
    expect(uses.find((use) => use.name === '--genai-footnote-border-color')?.fallback).toBe(
      'var(--ds-color-accent-border-strong)',
    );
    // Off while focused, so Designsystemet's two focus rings stay whole.
    expect(flat).toMatch(
      /\.uib-footnote-mark:not\(:focus-visible\) \{ box-shadow: inset 0 0 0 var\(/,
    );
  });
});
