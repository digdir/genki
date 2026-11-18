import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueSettings } from './index.js';

const packagesDir = join(import.meta.dirname, '..', '..');

const sourceOf = (pkg: string) => {
  const dir = join(packagesDir, pkg.replace('@genai/', ''), 'src');
  const read = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      if (statSync(p).isDirectory()) return read(p);
      return f.endsWith('.ts') && !f.endsWith('.test.ts') ? [readFileSync(p, 'utf8')] : [];
    });
  return existsSync(dir) ? read(dir).join('\n') : undefined;
};

describe('settings catalogue', () => {
  it('gives every platform setting a unique key, a valid default and runtime layering', () => {
    expect(new Set(catalogueSettings.map((s) => s.key)).size).toBe(catalogueSettings.length);
    for (const s of catalogueSettings) {
      expect(s.schema.safeParse(s.default).success, s.key).toBe(true);
      expect(s.settableAt).toEqual(['platform', 'tenant', 'service', 'call']);
      expect(s.description.length, s.key).toBeGreaterThan(10);
    }
  });

  it('fails for a setting that no platform package reads', () => {
    for (const s of catalogueSettings) {
      expect(s.consumers.length, s.key).toBeGreaterThan(0);
      for (const c of s.consumers) {
        const source = sourceOf(c.package);
        expect(source, `${s.key}: ${c.package} does not exist`).toBeDefined();
        const [symbol, ...path] = c.field.split('.');
        expect(source, `${s.key}: ${c.package} has no ${symbol}`).toContain(symbol);
        expect(source, `${s.key}: ${c.package} has no ${c.field}`).toContain(`${path.at(-1)}:`);
      }
    }
  });

  it('points every settings row with an API key at a key the platform catalogue holds', () => {
    const portalRows = readFileSync(
      join(packagesDir, '..', 'apps', 'portal', 'src', 'data', 'settings.ts'),
      'utf8',
    );
    const rowKeys = [...portalRows.matchAll(/apiKey: '([^']+)'/g)].map((m) => m[1] ?? '');
    const catalogueKeys = new Set(catalogueSettings.map((s) => s.key));
    expect(rowKeys.length).toBeGreaterThan(0);
    for (const key of rowKeys) expect(catalogueKeys.has(key), key).toBe(true);
  });
});
