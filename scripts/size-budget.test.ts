import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  budgets,
  firstLoadFiles,
  measureFirstLoad,
  overBudget,
  type FirstLoad,
  type Manifest,
} from './size-budget.ts';

const manifest: Manifest = {
  'index.html': {
    file: 'assets/index.js',
    isEntry: true,
    imports: ['_shared.js'],
    dynamicImports: ['src/screens/Reference.tsx'],
  },
  '_shared.js': { file: 'assets/shared.js', imports: ['_runtime.js'] },
  '_runtime.js': { file: 'assets/runtime.js' },
  'src/screens/Reference.tsx': {
    file: 'assets/Reference.js',
    isDynamicEntry: true,
    imports: ['_shared.js', '_reference-data.js'],
  },
  '_reference-data.js': { file: 'assets/reference-data.js' },
  'style.css': { file: 'assets/style.css' },
};

const load = (app: string, gzip: number): FirstLoad => ({
  app,
  files: ['assets/index.js'],
  raw: gzip * 3,
  gzip,
  budget: budgets[app] ?? 0,
});

describe('first-load size budget', () => {
  it('counts the entry and the chunks it imports up front, not the ones it loads on demand', () => {
    expect(firstLoadFiles(manifest).sort()).toEqual([
      'assets/index.js',
      'assets/runtime.js',
      'assets/shared.js',
    ]);
  });

  it('measures the first load uncompressed and at gzip level 9', () => {
    const text = Buffer.from('const portal = "portal";\n'.repeat(400));
    const measured = measureFirstLoad('portal', manifest, () => text);
    expect(measured.raw).toBe(text.length * 3);
    expect(measured.gzip).toBeLessThan(measured.raw / 10);
    expect(measured.budget).toBe(budgets.portal);
  });

  it('fails an app over its budget with the app, its size and its budget', () => {
    expect(overBudget([load('portal', 734_000)])).toEqual([
      'portal: the first load is 734.0 kB gzip, over its budget of 400.0 kB',
    ]);
  });

  it('passes an app within its budget', () => {
    expect(overBudget([load('portal', 365_500), load('workspace', 200_000)])).toEqual([]);
  });

  it('refuses a manifest without an entry instead of counting nothing', () => {
    expect(() => firstLoadFiles({ 'style.css': { file: 'assets/style.css' } })).toThrow(
      'the manifest has no entry chunk',
    );
  });

  it('has a budget for every app that Vite builds', () => {
    const apps = join(import.meta.dirname, '..', 'apps');
    const built = readdirSync(apps).filter((app) => existsSync(join(apps, app, 'vite.config.ts')));
    expect(Object.keys(budgets).sort()).toEqual(built.sort());
  });
});
