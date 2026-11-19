import { describe, expect, it } from 'vitest';
import { exampleModels } from '../mock';
import { exampleLiveDatasets } from '../mock/datasets';
import { exampleBlocks } from './building-blocks';
import { exampleDatasets } from './services';

const catalogueId = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

describe('the mock data agrees with itself', () => {
  it('every model building block has the id of a model in the catalogue', () => {
    const catalogue = new Set(exampleModels.map((m) => m.id));
    const blocks = exampleBlocks.filter((b) => b.kind === 'model').map((b) => b.id);
    expect(blocks.filter((id) => !catalogue.has(id))).toEqual([]);
  });

  it('every dataset the example services read from is a dataset the mock knows', () => {
    const known = new Set(exampleLiveDatasets.flatMap((d) => [d.id, ...(d.aliases ?? [])]));
    expect(Object.keys(exampleDatasets).filter((ref) => !known.has(ref))).toEqual([]);
  });

  it('no example dataset ref can be the id of a real dataset', () => {
    expect(Object.keys(exampleDatasets).filter((ref) => catalogueId.test(ref))).toEqual([]);
  });
});
