import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/conversation.css`, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const flat = css.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/,? \)/g, ')');

// Each `var(--genai-…, fallback)` with its fallback.
const uses = [...flat.matchAll(/var\((--genai-[a-z-]+), (var\(--[a-z0-9-]+\)|[^)]+)\)/g)].map(
  ([, name, fallback]) => ({ name: name ?? '', fallback: fallback ?? '' }),
);

// Pinned to a colour family on purpose, each with a comment in the CSS.
const warningPins = [
  '--genai-conversation-mark-background',
  '--genai-conversation-mark-color',
  '--genai-conversation-mark-current-background',
  '--genai-conversation-mark-current-color',
];

describe('the conversation styles', () => {
  it('follow the host’s colour family, but for the four marks pinned to warning', () => {
    const pinned = uses
      .filter((use) =>
        /--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(use.fallback),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual([...warningPins].sort());
    for (const name of warningPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-warning-/);
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
          .every((part) => part.trim().startsWith('.uib-conversation')),
    );
    expect(selectors.length).toBeGreaterThan(15);
    expect(outside).toEqual([]);
  });

  it('draw the question with no border, its ground alone marking it', () => {
    expect(flat).toMatch(/\.uib-conversation-question \{[^}]*--dsc-card-border-width: 0;/);
    expect(flat).not.toContain('--genai-conversation-question-border-color');
  });

  it('draw the question on the tinted Card’s own ground unless the host names another', () => {
    expect(flat).toContain(
      'background: var(--genai-conversation-question-background, var(--ds-color-surface-tinted));',
    );
  });

  it('keep the search strip over the conversation while it scrolls', () => {
    expect(flat).toContain('position: sticky;');
    expect(flat).toContain(
      'inset-block-start: var(--genai-conversation-search-inset-block-start, 0);',
    );
  });
});
