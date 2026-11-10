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
  '--genai-threads-signed-in-border-color',
];

describe('the Threads styles', () => {
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

// A `data-color` written into the markup is a pin a host's `color` cannot reach (V2-0009 §3):
// each is named here and justified by the comment on the line above it.
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
