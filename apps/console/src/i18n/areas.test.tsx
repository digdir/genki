// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { areas, parts, type Area, type Part } from './areas';

const globbed = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sources = new Map(
  Object.entries(globbed).map(([path, text]) => [
    path.replace(/^\.\.\//, '').replace(/^\.\//, 'i18n/'),
    text,
  ]),
);
const read = (file: string) => sources.get(file) ?? '';

const normalize = (path: string) =>
  path
    .split('/')
    .reduce<string[]>((out, part) => {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
      return out;
    }, [])
    .join('/');

const resolve = (from: string, spec: string) => {
  if (!spec.startsWith('.')) return undefined;
  const base = normalize(`${from.split('/').slice(0, -1).join('/')}/${spec}`);
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base].find((file) =>
    sources.has(file),
  );
};

const staticImport =
  /^(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm;
const dynamicImport = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const moduleGraph = (entry: string, { dynamic = false, intoTexts = false } = {}) => {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    const specs = [...source.matchAll(staticImport)].map((m) => m[1] ?? m[2] ?? '');
    if (dynamic) specs.push(...[...source.matchAll(dynamicImport)].map((m) => m[1] ?? ''));
    for (const spec of specs) {
      const next = resolve(file, spec);
      if (next && (intoTexts || !next.startsWith('i18n/'))) pending.push(next);
    }
  }
  return seen;
};

const namespacesOf = async (list: readonly Part[]) =>
  (await Promise.all(list.map((part) => parts[part].nb()))).flatMap((c) => Object.keys(c));

const allNamespaces = [...sources.keys()]
  .filter((file) => /^i18n\/nb\/\w+\.ts$/.test(file))
  .map((file) => file.slice('i18n/nb/'.length, -3));

const usedNamespaces = (files: Iterable<string>) => {
  const text = [...files].map(read).join('\n');
  return allNamespaces.filter((ns) => new RegExp(`['"\`]${ns}\\.`).test(text));
};

const shellNamespaces = allNamespaces.filter((ns) => !(ns in parts));

const screensFile = 'lazy-screens.ts';
const lazyScreens = [
  ...read(screensFile).matchAll(
    /screen\(\s*'(\w+)',\s*\(\)\s*=>\s*import\('(\.\/screens\/[^']+)'\)/g,
  ),
].map((m) => ({ area: m[1] as Area, screen: resolve(screensFile, m[2] ?? '') ?? '' }));

describe('area texts', () => {
  it('keeps the first load free of area catalogues', () => {
    const firstLoad = [...moduleGraph('main.tsx', { intoTexts: true })].filter((file) =>
      /^i18n\/(nb|en)\//.test(file),
    );
    const lazy = firstLoad.filter(
      (file) => (/^i18n\/(nb|en)\/(\w+)\.ts$/.exec(file)?.[2] ?? '') in parts,
    );
    expect(lazy).toEqual([]);
    expect(firstLoad).toContain('i18n/nb/shell.ts');
  });

  it('loads every screen together with its area texts', () => {
    const imports = read(screensFile).match(/import\('\.\/screens\//g) ?? [];
    expect(lazyScreens.map((s) => s.screen).every(Boolean)).toBe(true);
    expect(lazyScreens).toHaveLength(imports.length);
    expect(new Set(lazyScreens.map((s) => s.area))).toEqual(new Set(Object.keys(areas)));
  });

  it('gives the shell every text it shows outside the lazy screens', () => {
    const used = usedNamespaces(moduleGraph('main.tsx'));
    expect(used.filter((ns) => !shellNamespaces.includes(ns))).toEqual([]);
  });

  it.each(lazyScreens)('names every text the $area screen uses in its area', async (lazy) => {
    const loaded = new Set([...shellNamespaces, ...(await namespacesOf(areas[lazy.area]))]);
    const used = usedNamespaces(moduleGraph(lazy.screen, { dynamic: true }));
    expect(used.filter((ns) => !loaded.has(ns))).toEqual([]);
  });
});

describe('area texts in the running console', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loads an area's texts together with its screen's code", async () => {
    vi.resetModules();
    const { translator } = await import('.');
    expect(translator('nb')('platformSecrets.title')).toBe('platformSecrets.title');

    const { PlatformSecrets } = await import('../lazy-screens');
    await PlatformSecrets.preload();

    expect(translator('nb')('platformSecrets.title')).not.toBe('platformSecrets.title');
    expect(translator('en')('platformSecrets.title')).not.toBe('platformSecrets.title');
  });
});
