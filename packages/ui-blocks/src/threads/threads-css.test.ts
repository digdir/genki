import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/threads.css`, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const usesOf = (body: string) =>
  [...body.matchAll(/var\(\s*(--genai-threads-[a-z-]+),\s*var\((--ds-[a-z0-9-]+)\)\s*\)/g)].map(
    ([, name, token]) => ({ name, token }),
  );
// Each rule apart, so kunnskapsassistenten's rows and the design's (`variant="nav"`) are each held
// to their own pins.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = '', body = '']) => ({
  nav: selector.includes("[data-variant='nav']"),
  uses: usesOf(body),
}));
const uses = rules.filter((rule) => !rule.nav).flatMap((rule) => rule.uses);
const navUses = rules.filter((rule) => rule.nav).flatMap((rule) => rule.uses);
const pinnedIn = (list: typeof uses) => [
  ...new Set(
    list
      .filter((use) =>
        /^--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.token ?? ''),
      )
      .map((use) => use.name),
  ),
];

// Pinned to neutral on purpose, as the reference draws them, each with a comment in the CSS.
const neutralPins = [
  '--genai-threads-group-title-color',
  '--genai-threads-meta-color',
  '--genai-threads-no-matches-color',
  '--genai-threads-signed-in-border-color',
];

// The design's rows: dark text, a grey hover and grey group names, as the dev-trader board draws;
// and the band under «Ny tråd», the panel's own colour.
const navNeutralPins = [
  '--genai-threads-group-title-color',
  '--genai-threads-new-band-background',
  '--genai-threads-thread-color',
  '--genai-threads-thread-hover-background',
];

const ruleFor = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, s = '']) => s.trim() === selector)?.[2] ?? '';

describe('the Threads styles', () => {
  it('read the design’s rows through their own rules, which the lint reads too', () => {
    expect(navUses.length).toBeGreaterThan(0);
    expect(rules.filter((rule) => rule.nav).length).toBeGreaterThan(0);
  });

  it('pin the design’s rows to neutral, as the board draws them, and nothing else', () => {
    expect(pinnedIn(navUses).sort()).toEqual(navNeutralPins);
    for (const use of navUses.filter((u) => navNeutralPins.includes(u.name ?? '')))
      expect(use.token).toMatch(/^--ds-color-neutral-/);
  });

  it('keep the design’s «Ny tråd» in view as the list scrolls, on the panel’s colour, as dev-trader does', () => {
    const top = ruleFor(".uib-threads[data-variant='nav'] > .uib-threads-top");
    expect(top).toContain('position: sticky');
    expect(top).toContain('inset-block-start: 0');
    // The band reaches the gap's height under the button, so no row shows between it and the list.
    expect(top).toContain('padding-block-end: var(--genai-threads-gap, var(--ds-size-4))');
    expect(top).toContain(
      'background: var(--genai-threads-new-band-background, var(--ds-color-neutral-surface-default))',
    );
  });

  it('stop a row reached by keyboard below the design’s «Ny tråd», not under it (WCAG 2.4.11)', () => {
    const below = ruleFor(
      ".uib-threads[data-variant='nav'] :is(a, button, input, [tabindex]):not(.uib-threads-new)",
    );
    expect(below).toMatch(
      /scroll-margin-block-start:\s*calc\(\s*var\(--genai-threads-new-size, var\(--ds-size-11\)\)\s*\+\s*var\(--genai-threads-gap, var\(--ds-size-4\)\)\s*\)/,
    );
  });

  it('tint the design’s open row in the host’s colour family, its text that family’s own', () => {
    for (const name of ['--genai-threads-current-background', '--genai-threads-current-color'])
      for (const use of navUses.filter((u) => u.name === name))
        expect(use.token).toMatch(/^--ds-color-(?:background|text)-/);
  });

  it('follow the host’s colour family, but for the four deliberate neutral pins', () => {
    const pinned = uses
      .filter((use) =>
        /^--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.token ?? ''),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual(neutralPins);
    for (const name of neutralPins)
      expect(uses.find((use) => use.name === name)?.token).toMatch(/^--ds-color-neutral-/);
  });

  it('draw the hover, the open row and the box in the host’s colour family', () => {
    for (const name of [
      '--genai-threads-thread-hover-background',
      '--genai-threads-current-background',
      '--genai-threads-current-color',
      '--genai-threads-overlay-background',
      '--genai-threads-overlay-color',
    ])
      expect(uses.find((use) => use.name === name)?.token).toMatch(/^--ds-color-(?:surface|text)-/);
  });
});

// A `data-color` in the markup is a pin a host's `color` cannot reach: each named here.
const markupPins: Record<string, string[]> = {
  'Threads.tsx': ['uib-threads-show-filters'],
  'ThreadMenu.tsx': ['Dropdown.Trigger'],
};

describe('the Threads markup', () => {
  it.each(Object.entries(markupPins))(
    'pins to neutral in %s only what kunnskapsassistenten draws neutral, each with its reason',
    (file, named) => {
      const lines = readFileSync(`${import.meta.dirname}/${file}`, 'utf8').split('\n');
      const at = lines.flatMap((line, index) =>
        line.includes('data-color="neutral"') ? [index] : [],
      );
      expect(at).toHaveLength(named.length);
      at.forEach((index, n) => {
        expect(lines[index - 1]?.trim()).toMatch(
          /^\/\/ Pinned to neutral, as kunnskapsassistenten/,
        );
        expect(lines.slice(index - 5, index).join('\n')).toContain(named[n]);
      });
    },
  );
});
