import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { uiBlocksEn, uiBlocksNb } from './index.js';

type Catalogue = Record<string, unknown>;

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

const modules = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
  .sort();

// The modules that may define a catalogue: the shared one, and each block's.
const catalogueModules = modules.filter((path) => /(^|\/)(i18n|catalogue)\.ts$/.test(path));

describe('the blocks’ catalogue for hosts', () => {
  it('lends a host every block’s words, from each block’s own catalogue', async () => {
    const missing: string[] = [];
    let catalogues = 0;
    for (const path of catalogueModules) {
      const stem = path.replace(/\.ts$/, '');
      const module = (await import(`./${stem}.ts`)) as { nb?: Catalogue; en?: Catalogue };
      if (!module.nb || !module.en) continue;
      catalogues += 1;
      for (const [name, words] of Object.entries(module.nb)) {
        if ((uiBlocksNb as Catalogue)[name] !== words) missing.push(`${path}: nb.${name}`);
      }
      for (const [name, words] of Object.entries(module.en)) {
        if ((uiBlocksEn as Catalogue)[name] !== words) missing.push(`${path}: en.${name}`);
      }
    }
    expect(catalogues).toBeGreaterThan(4);
    expect(missing).toEqual([]);
  });

  it('is read by no block, so a host that imports one block loads only that block’s words', () => {
    const readers = modules.filter(
      (path) => path !== 'index.ts' && /from\s+['"](\.\.?\/)+catalogues\.js['"]/.test(read(path)),
    );
    expect(readers).toEqual([]);
  });
});
