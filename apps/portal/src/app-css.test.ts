import { beforeAll, describe, expect, it } from 'vitest';

// Vitest gives `?raw` CSS as an empty string, so the stylesheet is read from disk.
let css = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
  };
  css = fs
    .readFileSync(new URL('./app.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
});

/** The at-rules a selector's rules sit in, outermost first, one list per place it is written. */
const wrappersOf = (selector: string) => {
  const found: string[][] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === '{') {
      const prelude = css.slice(start, i).trim();
      if (prelude === selector) found.push(open.filter((p) => p.startsWith('@')));
      open.push(prelude);
      start = i + 1;
    } else if (css[i] === '}') {
      open.pop();
      start = i + 1;
    } else if (css[i] === ';') {
      start = i + 1;
    }
  }
  return found;
};

describe('the portal styles', () => {
  // Unlayered, the ring beats every layer, and a block that draws its focus on a frame, as the
  // Composer does, shows a second ring on the field inside it.
  it('draw the fallback focus ring under Designsystemet’s and the blocks’ own focus', () => {
    expect(wrappersOf(':focus-visible')).toEqual([['@layer ds.base']]);
  });
});
