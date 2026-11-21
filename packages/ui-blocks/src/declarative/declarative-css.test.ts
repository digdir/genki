import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/declarative.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\( /g, '(')
  .replace(/,? \)/g, ')');

const uses = [...css.matchAll(/var\((--genai-[a-z-]+), ?(var\(--[a-z0-9-]+\)|[^()]+)\)/g)].map(
  ([, name = '', fallback = '']) => ({ name, fallback }),
);

describe('the declarative block styles', () => {
  it('uses only Designsystemet tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? []).toEqual([]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use.name).toMatch(/^--genai-declarative-[a-z]+(?:-[a-z]+)*$/);
      expect(use.fallback).toMatch(/^var\(--ds-[a-z0-9-]+\)$/);
    }
  });

  it('sits in one layer after Designsystemet’s, so a host’s own CSS wins', () => {
    expect(
      css.trim().startsWith('@layer ds.theme, ds.base, ds.components, genai.components;'),
    ).toBe(true);
    expect(css.match(/@layer\s+[\w.]+\s*\{/g)).toEqual(['@layer genai.components {']);
  });
});
