import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expiredFlags, flagKeys, flags, isFlagKey, type FlagKey } from './flags.js';

const root = join(import.meta.dirname, '..', '..', '..');
const skipped = new Set(['node_modules', 'dist', 'i18n', 'mock']);
const registry = join('packages', 'contracts', 'src', 'flags.ts');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-utils)?\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe('the feature flag registry', () => {
  it('finds a flag expired the day after its removeBy date and not on the date itself', () => {
    const spec = { description: 'x', owner: 'x', removeBy: '2027-02-28', selfService: false };

    expect(expiredFlags(new Date('2027-02-28T20:00:00Z'), { trial: spec })).toEqual([]);
    expect(expiredFlags(new Date('2027-03-01T10:00:00Z'), { trial: spec })).toEqual(['trial']);
  });

  it('gives every flag a description, an owner and a removeBy date', () => {
    for (const spec of Object.values(flags)) {
      expect(spec.description.trim()).not.toBe('');
      expect(spec.owner.trim()).not.toBe('');
      expect(spec.removeBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('has every registered flag used in production code outside the registry', () => {
    const unused = new Set<string>(flagKeys);
    for (const file of [...sources(join(root, 'apps')), ...sources(join(root, 'packages'))]) {
      if (unused.size === 0) break;
      if (relative(root, file) === registry) continue;
      const text = readFileSync(file, 'utf8');
      for (const key of unused)
        if (text.includes(`'${key}'`) || text.includes(`"${key}"`)) unused.delete(key);
    }

    expect([...unused]).toEqual([]);
  });

  it('makes an unknown flag key a type error and refuses it at runtime', () => {
    const typoIsAKey: 'blokkStudio' extends FlagKey ? true : false = false;

    expect(typoIsAKey).toBe(false);
    expect(isFlagKey('blokkStudio')).toBe(false);
    expect(isFlagKey('blockStudio')).toBe(true);
  });
});
