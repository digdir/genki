import { beforeAll, describe, expect, it } from 'vitest';

let stylesheets: [string, string][] = [];
let appCss = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
    readdirSync: (path: URL, options: { recursive: true }) => string[];
  };
  const here = new URL('./', import.meta.url);
  stylesheets = fs
    .readdirSync(here, { recursive: true })
    .filter((file) => file.endsWith('.css'))
    .map((file) => [file, fs.readFileSync(new URL(file, here), 'utf8')]);
  appCss = fs.readFileSync(new URL('../app.css', import.meta.url), 'utf8');
});
const shellClasses = /(^|[\s,}>~+])\.(body|shell|header|header-bar|sidebar)(?=[\s,{:.>~+[]|$)/m;

describe('screen stylesheets', () => {
  it('never style the shell layout classes, so a screen cannot resize the whole portal', () => {
    expect(stylesheets.length).toBeGreaterThan(5);
    for (const [file, css] of stylesheets) {
      expect(css.length, file).toBeGreaterThan(0);
      expect(css, file).not.toMatch(shellClasses);
    }
  });
});

describe('chip filters', () => {
  it('fill the pressed chip in the step flow filters, as the building block filters do', () => {
    const css = new Map(stylesheets).get('stepflows.css') ?? '';
    expect(css).toMatch(
      /\.sf-chips \[aria-pressed='true'\] \{[^}]*background: var\(--ds-color-accent-base-default\)/,
    );
  });
});

describe('app.css', () => {
  it('never gives a grid a bare 1fr track, so wide content cannot widen the page on a phone', () => {
    const tracks = [...appCss.matchAll(/grid-template-columns:([^;]+);/g)].map((m) => m[1] ?? '');
    expect(tracks.length).toBeGreaterThan(2);
    for (const track of tracks)
      expect(track.replace(/minmax\((?:[^()]|\([^()]*\))*\)/g, ''), track).not.toMatch(/\b1fr\b/);
  });
});
