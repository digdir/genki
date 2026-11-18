// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { core } from './nb/core';
import { areas, parts, type Area, type Part } from './areas';
import { pageParts } from './page-texts';

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

const shellNamespaces = [...Object.keys(core), 'builder'];

const usedAreaNamespaces = (files: Iterable<string>, areaNamespaces: readonly string[]) => {
  const text = [...files].map(read).join('\n');
  return areaNamespaces.filter((ns) => new RegExp(`['"\`]${ns}\\.`).test(text));
};

const page = 'signed-in-page.tsx';
const lazyScreens = [
  ...read(page).matchAll(/withTexts\(\s*'(\w+)',\s*\(\)\s*=>\s*import\('(\.\/screens\/[^']+)'\)/g),
].map((m) => ({ area: m[1] as Area, screen: resolve(page, m[2] ?? '') ?? '' }));

describe('area texts', () => {
  it('keeps the first load free of area catalogues', () => {
    const firstLoad = [...moduleGraph('main.tsx', { intoTexts: true })].filter((file) =>
      /^i18n\/(nb|en)\//.test(file),
    );
    expect(firstLoad.filter((file) => !/^i18n\/(nb|en)\/core/.test(file))).toEqual([]);
    expect(firstLoad).toContain('i18n/nb/core.ts');
  });

  it('loads every lazy screen of the signed-in page together with its area texts', () => {
    const imports = read(page).match(/import\('\.\/screens\//g) ?? [];
    expect(lazyScreens.map((s) => s.screen).every(Boolean)).toBe(true);
    expect(lazyScreens).toHaveLength(imports.length);
    expect(new Set(lazyScreens.map((s) => s.area))).toEqual(new Set(Object.keys(areas)));
  });

  it('gives the signed-in page every text it shows outside its lazy screens', async () => {
    const all = await namespacesOf(Object.keys(parts) as Part[]);
    const loaded = new Set([...shellNamespaces, ...(await namespacesOf(pageParts))]);
    const used = usedAreaNamespaces(moduleGraph(page), all);
    expect(used.filter((ns) => !loaded.has(ns))).toEqual([]);
  });

  it.each(lazyScreens)(
    'names every text the $area screen uses in its area',
    async ({ area, screen }) => {
      const all = await namespacesOf(Object.keys(parts) as Part[]);
      const loaded = new Set([
        ...shellNamespaces,
        ...(await namespacesOf(pageParts)),
        ...(await namespacesOf(areas[area])),
      ]);
      const used = usedAreaNamespaces(moduleGraph(screen, { dynamic: true }), all);
      expect(used.filter((ns) => !loaded.has(ns))).toEqual([]);
    },
  );
});

describe('area texts in the running portal', () => {
  let cleanup: () => void = () => undefined;
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  const fresh = async () => {
    vi.resetModules();
    const texts = await import('.');
    const utils = await import('../test-utils');
    const rtl = await import('@testing-library/react');
    cleanup = rtl.cleanup;
    return { ...texts, ...utils, ...rtl };
  };

  it("loads an area's texts before its screen renders", async () => {
    const { translator, renderAt, screen } = await fresh();
    expect(translator('nb').has('access.searchPerson')).toBe(false);

    await renderAt('#/access/people');

    expect(await screen.findByLabelText('Søk etter person')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\baccess\.\w+/);
  });

  it('switches language on a lazily loaded screen', async () => {
    const { renderAt, screen, fireEvent, within, go } = await fresh();
    await renderAt('#/access/people');
    expect(await screen.findByLabelText('Søk etter person')).toBeTruthy();

    await go('#/profile');
    const choice = await screen.findByRole('group', { name: 'Språk / Language' });
    fireEvent.click(within(choice).getByRole('radio', { name: 'English' }));
    await go('#/access/people');

    expect(await screen.findByLabelText('Search for a person')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\baccess\.\w+/);
  });

  it('reads the guardrail rule template text when it is used, not when its screen loads', async () => {
    vi.resetModules();
    const { ruleTemplate } = await import('../screens/service/GuardrailRules');
    const { loadArea } = await import('./areas');
    await loadArea('services');

    const { translator } = await import('.');
    expect(ruleTemplate.message).toBe(translator('nb')('serviceGuardrails.defaultMessage'));
    expect(ruleTemplate.message).not.toBe('serviceGuardrails.defaultMessage');
  });
});
