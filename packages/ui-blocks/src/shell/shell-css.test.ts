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

// The chrome stays neutral whatever data-color the host sets, as kunnskapsassistenten's.
const neutralPins = [
  '--genai-shell-background',
  '--genai-shell-bar-background',
  '--genai-shell-border-color',
  // The cards frame's grounds and lines, and the titles, grey as the design's dev-navbar draws them.
  '--genai-shell-card-background',
  // The companion column, on the card's ground, its subtitle grey as the design's (dev-filter-panel).
  '--genai-shell-companion-background',
  '--genai-shell-companion-subtitle-color',
  '--genai-shell-divider-color',
  '--genai-shell-drawer-background',
  '--genai-shell-primary-background',
  // The profile menu's top: the reader's name and organisation, the panel's own words.
  '--genai-shell-profile-organisation-color',
  '--genai-shell-profile-who-color',
  '--genai-shell-rail-background',
  '--genai-shell-title-color',
  // The secondary panel's tool tabs are its own chrome, grey as the design draws them.
  '--genai-shell-tools-tab-color',
  '--genai-shell-tools-tab-hover-background',
  '--genai-shell-tools-tab-selected-background',
  '--genai-shell-tools-tabs-background',
  // The tools' dropdown button: navigation, not the main action, so neutral in every state.
  '--genai-shell-tools-trigger-active-background',
  '--genai-shell-tools-trigger-background',
  '--genai-shell-tools-trigger-color',
  '--genai-shell-tools-trigger-hover-background',
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
      // The panel's own column beside a companion: its design width less the companion's.
      '--uib-shell-lead-width',
      '--uib-shell-main-max-width',
      '--uib-shell-main-min-width',
      '--uib-shell-primary-min-width',
      '--uib-shell-primary-width',
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
    expect(css).toContain('.uib-shell-content[hidden], .uib-shell-fill[hidden] { display: none; }');
  });

  it('fill the shell’s own box with an open panel in a narrow window, with no dialog or backdrop', () => {
    expect(css).toContain('.uib-shell[data-drawer] { position: relative; }');
    expect(css).toContain(
      '.uib-shell[data-drawer] > .uib-shell-side { position: static; container-type: normal; }',
    );
    expect(css).toContain(
      '.uib-shell-fill { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; container-type: inline-size;',
    );
    // The main column's own layers, such as its pinned head, stay under the panel.
    expect(css).toContain('.uib-shell[data-drawer] > .uib-shell-main { isolation: isolate; }');
    expect(css).not.toMatch(/::backdrop|dialog|uib-shell-drawer\b|drawer-width/);
    expect(css).toContain('.uib-shell-close { flex: 0 0 auto; margin-inline-start: auto; }');
  });

  it('never hide the main column, so it comes back as it was when the panel over it closes', () => {
    const rules = css.match(/[^{}]*\{[^{}]*\}/g) ?? [];
    const hiding = rules.filter(
      (rule) =>
        /\.uib-shell-main(?![\w-])[^{]*\{/.test(rule) &&
        /(?:display: none|visibility: hidden|content-visibility)/.test(rule),
    );
    expect(hiding).toEqual([]);
  });

  it('put the rails in one row at the top in the bar, and the main column under it in full', () => {
    expect(css).toContain(
      '.uib-shell[data-compact] { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: auto minmax(0, 1fr); }',
    );
    expect(css).toContain(
      ".uib-shell[data-compact] > .uib-shell-side[data-side='primary'] { grid-row: 1; grid-column: 1; }",
    );
    expect(css).toContain(
      ".uib-shell[data-compact] > .uib-shell-side[data-side='secondary'] { grid-row: 1; grid-column: 3; }",
    );
    expect(css).toContain(
      '.uib-shell[data-compact] > .uib-shell-main { grid-row: 2; grid-column: 1 / -1; }',
    );
  });

  it('stand both buttons in the bar on the main column’s text edge, the end one as the start one', () => {
    // A rail is its button plus the head's padding, so each button keeps that from its edge.
    expect(css).toContain(
      '.uib-shell[data-compact] > .uib-shell-side { container-type: normal; min-inline-size: 0; }',
    );
    const textEdge = /\.uib-shell-column \{[^}]*?padding-inline: (clamp\([^;]*\));/.exec(css)?.[1];
    expect(textEdge).toContain('--genai-shell-main-padding-inline-min');
    expect(css).toContain(
      `.uib-shell[data-compact] > .uib-shell-side > .uib-shell-box > .uib-shell-header { padding-inline: ${textEdge}; }`,
    );
    expect(css).toContain(
      '.uib-shell[data-compact] > .uib-shell-side > .uib-shell-box { padding-block: var(--genai-shell-bar-padding-block, var(--ds-size-2)); background: none; border-inline: 0; }',
    );
  });

  it('draw the cards frame from tokens: 16 from the window, 12 apart, a 44 button, out of the top row', () => {
    expect(css).toContain(
      ".uib-shell[data-frame='cards']:not([data-compact]) { box-sizing: border-box; padding: var(--genai-shell-inset, var(--ds-size-4)); }",
    );
    expect(css).toContain(
      ".uib-shell[data-frame='cards']:not([data-compact]) > .uib-shell-side[data-side='primary'] { margin-inline-end: var(--genai-shell-gap, var(--ds-size-3)); }",
    );
    expect(css).toContain(
      ".uib-shell[data-frame='cards'] .uib-shell-toggle { --dsc-button-border-radius: var(--genai-shell-toggle-radius, var(--ds-border-radius-xl)); --dsc-button-size: var(--genai-shell-rail-button-size, var(--ds-size-11)); }",
    );
    expect(css).toContain(
      'border-radius: var(--genai-shell-card-radius, var(--ds-border-radius-xl));',
    );
  });

  it('give every title one look, Heading xs on one line, its line as tall as --ds-size-8', () => {
    const title = /\.uib-shell-title \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(title).toContain(
      'font-size: var(--genai-shell-title-font-size, var(--ds-heading-xs-font-size))',
    );
    expect(title).toContain('line-height: var(--genai-shell-title-line-height, var(--ds-size-8))');
    expect(title).toContain('white-space: nowrap');
    expect(title).toContain('text-overflow: ellipsis');
  });

  it('align the head row of a card to its top, so a title beside a 44 button stays on the others’ line', () => {
    expect(css).toContain(
      ".uib-shell[data-frame='cards'] > .uib-shell-side > .uib-shell-box > .uib-shell-header, .uib-shell[data-frame='cards'] > .uib-shell-side > .uib-shell-fill > .uib-shell-box > .uib-shell-header { align-items: start; }",
    );
  });

  it('centre an open panel’s button on its title’s line, moved and not resized, and leave a rail’s alone', () => {
    expect(css).toContain(
      ".uib-shell[data-frame='cards'] > .uib-shell-side:not([data-collapsed]) .uib-shell-header > .uib-shell-toggle { translate: 0 calc((var(--genai-shell-title-line-height, var(--ds-size-8)) - var(--genai-shell-rail-button-size, var(--ds-size-11))) / 2); }",
    );
  });

  it('draw the tools’ dropdown button pressed or open on the active surface, hover only under the pointer (dev-verktoy-3)', () => {
    const open = css.slice(css.indexOf(".uib-shell-tools-trigger[aria-expanded='true'] {"));
    expect(open.slice(0, open.indexOf('}'))).toContain(
      '--dsc-button-background: var(--genai-shell-tools-trigger-active-background, var(--ds-color-neutral-surface-active));',
    );
    const trigger = css.slice(css.indexOf('.uib-shell-tools-trigger {'));
    expect(trigger.slice(0, trigger.indexOf('}'))).toContain(
      '--dsc-button-background--active: var(--genai-shell-tools-trigger-active-background, var(--ds-color-neutral-surface-active));',
    );
  });

  it('draw the tools’ dropdown button in neutral in every state, never in the Button’s accent', () => {
    const rules = [
      '.uib-shell-tools-trigger {',
      ".uib-shell-tools-trigger[aria-expanded='true'] {",
    ].map((start) => {
      expect(css.indexOf(start), start).toBeGreaterThanOrEqual(0);
      const from = css.slice(css.indexOf(start));
      return from.slice(0, from.indexOf('}'));
    });
    const trigger = rules[0] ?? '';
    for (const [name, token] of [
      ['--dsc-button-background', 'surface-tinted'],
      ['--dsc-button-background--hover', 'surface-hover'],
      ['--dsc-button-background--active', 'surface-active'],
      ['--dsc-button-color', 'text-default'],
      ['--dsc-button-color--hover', 'text-default'],
      ['--dsc-button-color--active', 'text-default'],
    ]) {
      expect(trigger).toMatch(
        new RegExp(`${name}: var\\([^;]*var\\(--ds-color-neutral-${token}\\)\\);`),
      );
    }
    for (const rule of rules) {
      expect(rule).not.toMatch(/accent|--ds-color-(surface|text|base)-/);
    }
  });

  it('keep what a rail shows at its bottom out of the top row', () => {
    expect(css).toContain('.uib-shell[data-compact] .uib-shell-rail-foot { display: none; }');
  });

  it('are each listed on the component page', () => {
    const names = [...new Set(uses.map((use) => use.name))];
    expect(names.filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});

// A `data-color` in the markup is a pin a host's `color` cannot reach: each named here.
describe('the Shell markup', () => {
  it('pins to neutral only the panel buttons kunnskapsassistenten draws neutral, with the reason', () => {
    const lines = readFileSync(`${import.meta.dirname}/Shell.tsx`, 'utf8').split('\n');
    const at = lines.flatMap((line, index) =>
      line.includes('data-color="neutral"') ? [index] : [],
    );
    // The panel's button, and the close button of a panel that fills the shell.
    expect(at).toHaveLength(2);
    for (const index of at) {
      expect(lines[index - 1]?.trim()).toMatch(/^\/\/ Pinned to neutral, as kunnskapsassistenten/);
      expect(lines[index - 2]).toMatch(/uib-shell-(?:toggle|close)/);
    }
  });
});
