import { beforeAll, describe, expect, it } from 'vitest';

let stylesheets: [string, string][] = [];
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
});

const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim(),
    body: m[2] ?? '',
  }));

const scrolls = /overflow(?:-[xy])?:\s*(?:auto|scroll)/;

describe('scroll containers', () => {
  it('are positioned, so a visually hidden label inside cannot widen or lengthen what is outside', () => {
    const loose = stylesheets.flatMap(([file, css]) =>
      rules(css)
        .filter((r) => scrolls.test(r.body) && !/(^|[\s;])position:/.test(r.body))
        .map((r) => `${file}: ${r.selector}`),
    );
    expect(stylesheets.length).toBeGreaterThan(10);
    expect(loose).toEqual([]);
  });

  it('that fill a panel or dialog keep the scroll from reaching the page behind', () => {
    const chaining = stylesheets.flatMap(([file, css]) =>
      rules(css)
        .filter((r) => /overflow(?:-y)?:\s*(?:auto|scroll)/.test(r.body) && /flex:/.test(r.body))
        .filter((r) => !/overscroll-behavior(?:-y)?:\s*(?:contain|none)/.test(r.body))
        .map((r) => `${file}: ${r.selector}`),
    );
    expect(chaining).toEqual([]);
  });
});

const css = (file: string) => new Map(stylesheets).get(file) ?? '';

const queryHolding = (sheet: string, selector: string) =>
  [...sheet.matchAll(/@(?:media|container)[^{]*/g)]
    .map((m) => {
      let depth = 0;
      let end = m.index + m[0].length;
      do {
        if (sheet[end] === '{') depth++;
        if (sheet[end] === '}') depth--;
        end++;
      } while (depth > 0 && end < sheet.length);
      return { query: m[0].trim(), body: sheet.slice(m.index, end) };
    })
    .filter((q) => q.body.includes(`${selector} {`))
    .map((q) => q.query);

describe('side by side columns', () => {
  it('stack by the width of the page column, which the menu narrows, not the window', () => {
    expect(css('app.css')).toMatch(/\.main-inner \{\s*container: page \/ inline-size;/);
    expect(queryHolding(css('screens/service/service.css'), '.service-sub')).toEqual([
      '@container page (max-width: 1179px)',
    ]);
    expect(queryHolding(css('screens/services.css'), '.builder-split')).toEqual([
      '@container page (max-width: 859px)',
    ]);
    expect(queryHolding(css('screens/services/blocks/blocks.css'), '.blocks-split')).toEqual([
      '@container page (max-width: 899px)',
    ]);
    expect(queryHolding(css('screens/apiref.css'), '.ar-ref,\n  .ar-version')).toEqual([
      '@container apiref (max-width: 699px)',
    ]);
  });
});

describe('side rails', () => {
  const rails = [
    ['screens/services/setup-layout.css', '.setup-nav', '@container setup (max-width: 1179px)'],
    ['screens/models/models.css', '.mc-filters', '@container page (max-width: 823px)'],
    ['app.css', '.dev-tools-nav', '@media (max-width: 900px)'],
    ['screens/service/service.css', '.service-subnav', '@container page (max-width: 1179px)'],
    ['screens/apiref.css', '.ar-nav', '@container apiref (max-width: 699px)'],
  ] as const;

  it('stick through the shared class, clear the draft bar, and have their own scroll', () => {
    const app = css('app.css');
    expect(app).toMatch(/:where\(\.sticky-rail\) \{[^}]*position: sticky;[^}]*overflow-y: auto;/);
    expect(app).toMatch(/\.draft-bar ~ \* \{\s*--rail-top:/);
    for (const [file, selector] of rails)
      expect(
        rules(css(file)).filter((r) => r.selector === selector && /position: sticky/.test(r.body)),
      ).toEqual([]);
  });

  it('stop sticking where their columns stack', () => {
    for (const [file, selector, query] of rails) {
      const sheet = css(file);
      const start = sheet.indexOf(query);
      const block = start < 0 ? '' : sheet.slice(start, sheet.indexOf('\n}', start));
      expect(block, `${file} ${selector}`).toMatch(
        new RegExp(`\\${selector} \\{[^}]*position: static;[^}]*max-height: none;`),
      );
    }
  });
});

describe('long words', () => {
  it('break in headings and text instead of widening the page', () => {
    expect(css('app.css')).toMatch(/body \{[^}]*overflow-wrap: break-word;/);
    expect(css('app.css')).toMatch(/\.ds-heading \{\s*overflow-wrap: anywhere;/);
  });
});

describe('bordered tables', () => {
  it('pad their first and last cells as Designsystemet pads table cells', () => {
    const app = css('app.css');
    for (const edge of ['first-child', 'last-child'])
      expect(app).toContain(
        `.table-scroll > table > * > tr > :is(th, td):not([aria-sort]):${edge} {\n  padding-inline-${edge === 'first-child' ? 'start' : 'end'}: var(--ds-size-3);`,
      );
    expect(css('screens/buildingblocks.css')).not.toMatch(/\.bb-calltypes t[hd]:first-child/);
  });
});
