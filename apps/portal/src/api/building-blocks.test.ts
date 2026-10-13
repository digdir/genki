import { describe, expect, it } from 'vitest';
import { readable, type CatalogItem } from './building-blocks';

const item = (over: Partial<CatalogItem>) =>
  ({ id: 'x', kind: 'tool', name: 'x', ...over }) as CatalogItem;

describe('building block names', () => {
  it('shows a model by its name instead of the raw deployment id', () => {
    const model = item({
      kind: 'model',
      id: 'foundry-openai/gpt-4o-2m-tps',
      name: 'foundry-openai/gpt-4o-2m-tps',
    });
    expect(readable(model).name).toBe('gpt-4o-2m-tps');
  });

  it('keeps a name the API already gave', () => {
    expect(readable(item({ kind: 'model', id: 'a/b', name: 'GPT-4o' })).name).toBe('GPT-4o');
    expect(readable(item({ kind: 'tool', id: 'a/b', name: 'a/b' })).name).toBe('a/b');
  });
});
