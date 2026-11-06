import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/threads.css`, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const uses = [...css.matchAll(/var\((--genai-threads-[a-z-]+),\s*var\((--ds-[a-z0-9-]+)\)\)/g)].map(
  ([, name, token]) => ({ name, token }),
);

// Pinned to neutral on purpose, as the reference draws them, each with a comment in the CSS.
const neutralPins = [
  '--genai-threads-group-title-color',
  '--genai-threads-meta-color',
  '--genai-threads-no-matches-color',
];

describe('the Threads styles', () => {
  it('follow the host’s colour family, but for the three deliberate neutral pins', () => {
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
