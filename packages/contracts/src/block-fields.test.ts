import { describe, expect, it } from 'vitest';
import { blockFieldRoots, blockFields, canonicalPath, fieldOf } from './block-fields.js';
import { blockFixtures } from './block-fixtures.js';
import { blockStates } from './blocks.js';

const paths = Object.keys(blockFields);

describe('the field list a block may read', () => {
  it('gives every field path one type and every list an item shape', () => {
    expect(new Set(paths).size).toBe(paths.length);
    for (const [path, field] of Object.entries(blockFields)) {
      expect(blockFieldRoots).toContain(path.split('.')[0]);
      if (field.type === 'enum') expect(field.values?.length).toBeGreaterThan(0);
      if (field.type !== 'list') continue;
      expect(field.max).toBeGreaterThan(0);
      const items = paths.filter((p) => p.startsWith(`${path}.`));
      expect(field.of === 'string' || items.length > 0, path).toBe(true);
    }
  });

  it('reads a field path in linear time', () => {
    const hostile = `${'source.'.repeat(100_000)}title`;
    const aliases = new Map([['source', 'sources']]);
    const started = performance.now();
    expect(fieldOf(canonicalPath(hostile, aliases))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads an alias as the list it stands for', () => {
    const aliases = new Map([['source', 'sources']]);
    expect(canonicalPath('source.title', aliases)).toBe('sources.title');
    expect(fieldOf(canonicalPath('source.title', aliases))?.type).toBe('string');
    expect(fieldOf('constructor')).toBeUndefined();
  });

  it('has made-up preview data for every state a block can declare', () => {
    expect(Object.keys(blockFixtures).sort()).toEqual([...blockStates].sort());
  });
});
