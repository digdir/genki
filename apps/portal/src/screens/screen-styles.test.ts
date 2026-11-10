import { describe, expect, it } from 'vitest';

const stylesheets = import.meta.glob<string>('./**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const shellClasses = /(^|[\s,}>~+])\.(body|shell|header|header-bar|sidebar)(?=[\s,{:.>~+[]|$)/m;

describe('screen stylesheets', () => {
  it('never style the shell layout classes, so a screen cannot resize the whole portal', () => {
    const files = Object.entries(stylesheets);
    expect(files.length).toBeGreaterThan(5);
    for (const [file, css] of files) expect(css, file).not.toMatch(shellClasses);
  });
});
