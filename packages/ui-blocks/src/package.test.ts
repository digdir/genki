import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const pkg = JSON.parse(read('../package.json')) as { sideEffects?: unknown };

const modules = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
  .sort();

describe('the package, as a host bundles it', () => {
  it('declares only its stylesheets as side effects, so a host bundles only the blocks it imports', () => {
    // Without it, a bundler keeps every module the index reaches that has a call at its top,
    // even when the host imports one block.
    expect(pkg.sideEffects).toEqual(['**/*.css']);
  });

  it('imports no module only for what it does on load, which that declaration would drop', () => {
    const bare = modules.flatMap((path) =>
      [...read(path).matchAll(/^import\s+['"]([^'"]+)['"]/gm)]
        .map((match) => match[1] ?? '')
        .filter((spec) => !spec.endsWith('.css'))
        .map((spec) => `${path}: ${spec}`),
    );
    expect(modules.length).toBeGreaterThan(5);
    expect(bare).toEqual([]);
  });
});
