import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/answer-actions.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\( /g, '(')
  .replace(/,? \)/g, ')');
const page = readFileSync(
  `${import.meta.dirname}/../../../../docs/components/answer-actions.html`,
  'utf8',
);

// Every `var(--genai-…, fallback)`, with its fallback.
const uses = [...css.matchAll(/var\((--genai-[a-z-]+), ((?:var\(--[a-z0-9-]+\))|[^)]+)\)/g)].map(
  ([, name, fallback]) => ({ name: name ?? '', fallback: fallback ?? '' }),
);
const literal = /^\d*\.?\d+(?:px|rem|em|r?lh|ch|%)?$/;

// Pinned to neutral on purpose, as kunnskapsassistenten and the workspace draw them, each with
// a comment in the CSS.
const neutralPins = [
  '--genai-answer-actions-comment-background',
  '--genai-answer-actions-counter-color',
  '--genai-answer-actions-end-color',
  '--genai-answer-actions-feedback-border-color',
  '--genai-answer-actions-form-background',
  '--genai-answer-actions-question-color',
  '--genai-answer-actions-receipt-color',
  '--genai-answer-actions-status-color',
];

describe('the answer actions’ styles', () => {
  it('sit in one layer after Designsystemet’s, so a host’s own CSS wins', () => {
    expect(
      css.trim().startsWith('@layer ds.theme, ds.base, ds.components, genai.components;'),
    ).toBe(true);
    expect(css.match(/@layer\s+[\w.]+\s*\{/g)).toEqual(['@layer genai.components {']);
  });

  it('hold no literal colour', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
  });

  it('read every token through a --genai- variable, with the token or a lone literal as the fallback', () => {
    let rest = css;
    for (const use of uses) rest = rest.replace(`var(${use.name}, ${use.fallback})`, '');
    expect(rest.match(/var\(--ds-[a-z0-9-]+\)/g) ?? []).toEqual([]);
    expect(rest.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|r?lh|vh|vw|ch)\b/g) ?? []).toEqual([]);
    expect(rest.match(/font-weight:\s*\d/g) ?? []).toEqual([]);
    for (const use of uses)
      expect(`${use.name} ${use.fallback}`).toMatch(
        new RegExp(
          `^--genai-answer-actions-[a-z-]+ (?:var\\(--ds-[a-z0-9-]+\\)|${literal.source.slice(1, -1)})$`,
        ),
      );
  });

  it('never set a --genai- variable, which is the host’s to set', () => {
    expect(css).not.toMatch(/--genai-[a-z-]+\s*:/);
  });

  it('follow the host’s colour family, but for the deliberate neutral pins', () => {
    const pinned = uses
      .filter((use) =>
        /^var\(--ds-color-(?:accent|neutral|brand\d|success|warning|danger|info)-/.test(
          use.fallback,
        ),
      )
      .map((use) => use.name);
    expect([...new Set(pinned)].sort()).toEqual(neutralPins);
    for (const name of neutralPins)
      expect(uses.find((use) => use.name === name)?.fallback).toMatch(/^var\(--ds-color-neutral-/);
  });

  it('are each listed on the block’s page', () => {
    const names = [...new Set(uses.map((use) => use.name))];
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });

  it('stretch the rows across the column, so the time stands at its far end', () => {
    const root = css.slice(css.indexOf(' .uib-answer-actions {'));
    expect(root.slice(0, root.indexOf('}'))).toContain('align-items: stretch;');
    const end = css.slice(css.indexOf(' .uib-answer-actions-end {'));
    expect(end.slice(0, end.indexOf('}'))).toContain('margin-inline-start: auto;');
  });
});
