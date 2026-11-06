import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/answer.css`, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const flat = css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');

// Each `var(--genai-…, fallback)` with its fallback.
const uses = [...flat.matchAll(/var\((--genai-[a-z-]+), (var\(--[a-z0-9-]+\)|[^)]+)\)/g)].map(
  ([, name, fallback]) => ({ name: name ?? '', fallback: fallback ?? '' }),
);

// Pinned to a colour family on purpose, each with a comment in the CSS.
const accentPins = [
  '--genai-answer-footnote-background',
  '--genai-answer-footnote-border-color',
  '--genai-answer-footnote-color',
  '--genai-answer-footnote-hover-background',
  '--genai-answer-footnote-hover-color',
  '--genai-answer-sources-used-link-color',
  '--genai-answer-sources-used-link-hover-color',
];
const infoPins = ['--genai-answer-note-icon-color'];

describe('the answer styles', () => {
  it('follow the host’s colour family, but for the seven deliberate pins', () => {
    const pinned = uses
      .filter((use) =>
        /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.fallback),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual([...accentPins, ...infoPins].sort());
    for (const name of accentPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-accent-/);
    for (const name of infoPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-info-/);
  });

  it('name every rule after the block', () => {
    const selectors = [...flat.matchAll(/([^{};]+)\{/g)]
      .map(([, selector]) => selector?.trim() ?? '')
      .filter((selector) => selector && !selector.startsWith('@'));
    const outside = selectors.filter(
      (selector) =>
        !selector
          .replace(/\([^)]*\)/g, '')
          .split(',')
          .every((part) => part.trim().startsWith('.uib-answer')),
    );
    expect(selectors.length).toBeGreaterThan(20);
    expect(outside).toEqual([]);
  });

  it('add no card spacing above the first thing seen, after the line only a screen reader hears', () => {
    // Designsystemet spaces each card child after the first; the hidden line is the first.
    expect(flat).toContain(
      '.uib-answer-body > .ds-sr-only:first-child + * { margin-block-start: 0; }',
    );
  });

  it('keep a footnote from pushing the lines of the answer apart', () => {
    expect(flat).toContain('.uib-answer-footnote, .uib-answer-lost { line-height: 0; }');
  });

  it('set the footnote’s circle apart from the card with a strong ring, not the fill alone', () => {
    // The tinted fill is 1.2:1 on the card; a border-strong ring is over 3:1 in both themes.
    expect(uses.find((use) => use.name === '--genai-answer-footnote-border-color')?.fallback).toBe(
      'var(--ds-color-accent-border-strong)',
    );
    // Off while focused, so Designsystemet's two focus rings stay whole.
    expect(flat).toMatch(
      /\.uib-answer-mark:not\(:focus-visible\) \{ box-shadow: inset 0 0 0 var\(/,
    );
  });
});
