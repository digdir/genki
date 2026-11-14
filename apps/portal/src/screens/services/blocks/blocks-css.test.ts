import { beforeAll, describe, expect, it } from 'vitest';

// Vitest gives `?raw` CSS as an empty string, so the stylesheet is read from disk.
let css = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
  };
  css = fs.readFileSync(new URL('./blocks.css', import.meta.url), 'utf8');
});

// A rule's declarations, found by its exact selector, without comments or extra spaces.
const rule = (selector: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => block.split('{'))
    .find(([head]) => head?.trim() === selector)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();

describe('the Grensesnitt tab’s stylesheet', () => {
  it('lets the switcher wrap on a narrow screen, its toggles as tall as on one line', () => {
    expect(rule('.blocks-switcher')).toContain('width: fit-content;');
    expect(rule('.blocks-left[data-narrow] .blocks-switcher')).toBe(
      'flex-wrap: wrap; min-inline-size: 0; block-size: auto;',
    );
    expect(rule('.blocks-left[data-narrow] .blocks-switcher > *')).toBe(
      'block-size: var(--dsc-togglegroup-button-size);',
    );
  });

  it('scrolls a preview wider than its space from its left edge, so none of it is out of reach', () => {
    expect(rule('.service-preview-viewport')).toContain('overflow: auto hidden;');
    expect(rule('.service-preview-viewport')).toContain('justify-content: safe center;');
  });
});
