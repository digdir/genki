import { describe, expect, it } from 'vitest';
import { exampleModels } from '../mock';
import { exampleLiveDatasets } from '../mock/datasets';
import { exampleBlocks } from './building-blocks';
import { exampleDatasets } from './services';

describe('the mock data agrees with itself', () => {
  it('every model building block has the id of a model in the catalogue', () => {
    const catalogue = new Set(exampleModels.map((m) => m.id));
    const blocks = exampleBlocks.filter((b) => b.kind === 'model').map((b) => b.id);
    expect(blocks.filter((id) => !catalogue.has(id))).toEqual([]);
  });

  it('every dataset the example services read from is a dataset the mock knows', () => {
    const known = new Set(exampleLiveDatasets.map((d) => d.id));
    expect(Object.keys(exampleDatasets).filter((id) => id.includes('/') && !known.has(id))).toEqual(
      [],
    );
    expect(known.has('digdir/kudos') && 'digdir/kudos' in exampleDatasets).toBe(true);
  });
});
