import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atlasScriptFile, separateAtlasScript } from './atlas-page';

const atlas = readFileSync(
  new URL('../../../docs/architecture/system-atlas.html', import.meta.url),
  'utf8',
);

describe('the System Atlas page in the console build', () => {
  it('moves its inline script to a file, so it runs under a CSP without inline scripts', () => {
    const page = separateAtlasScript(atlas);
    expect(page.html.toLowerCase()).not.toContain('<script>');
    expect(page.html).toContain(`<script src="/${atlasScriptFile}"></script>`);
    expect(page.script.length).toBeGreaterThan(1000);
    expect(atlas).toContain(page.script);
  });

  it('refuses a page with more than one inline script', () => {
    expect(() => separateAtlasScript('<script>a</script><script>b</script>')).toThrow();
    expect(() => separateAtlasScript('<SCRIPT>a</SCRIPT><script>b</script>')).toThrow();
  });
});
