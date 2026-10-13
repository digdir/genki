import { describe, expect, it } from 'vitest';
import {
  discoveredIds,
  globMatches,
  listedModels,
  matchModel,
  parseMeter,
  priceTable,
  renderPrices,
  type RetailItem,
} from './import-azure-prices.js';

const item = (meterName: string, retailPrice: number, unitOfMeasure = '1K'): RetailItem => ({
  meterName,
  productName: 'Azure OpenAI',
  skuName: meterName,
  unitOfMeasure,
  retailPrice,
  type: 'Consumption',
});

const items = [
  item('gpt 4.1 mini Inp glbl Tokens', 0.0038),
  item('gpt 4.1 mini Outp glbl Tokens', 0.0152),
  item('gpt 4.1 mini cached Inp glbl Tokens', 0.001),
  item('gpt 4.1 mini Batch Outp glbl Tokens', 0.0076),
  item('gpt 4.1 mini Inp regional Tokens', 0.0042),
  item('GPT 5 Mini Inpt Glbl 1M Tokens', 2.3802, '1M'),
  item('GPT 5 Mini outpt Glbl 1M Tokens', 19.0417, '1M'),
  item('gpt 4o 1120 Inp glbl Tokens', 0.0238),
  item('gpt 4o 1120 Outp glbl Tokens', 0.0952),
  item('gpt 4o 0513 Input global Tokens', 0.0476),
  item('gpt 4o 0513 Output global Tokens', 0.1428),
  item('text-embedding-3-small-glbl Tokens', 0.0002),
];
const table = priceTable(items);

describe('Azure price import', () => {
  it('reads only global pay-as-you-go token meters', () => {
    expect(parseMeter(item('gpt 4.1 mini cached Inp glbl Tokens', 0.001))).toBeUndefined();
    expect(parseMeter(item('gpt 4.1 mini Inp regional Tokens', 0.0042))).toBeUndefined();
    expect(parseMeter(item('gpt 4.1 mini Inp glbl Tokens', 0.0038))).toMatchObject({
      family: 'gpt 4.1 mini',
      direction: 'input',
    });
  });

  it('prices a deployment by its family in NOK per 1,000 tokens', () => {
    expect(matchModel({ id: 'foundry-openai/mini', family: 'gpt-4.1-mini' }, table)).toMatchObject({
      ok: true,
      price: { inputPerThousand: 0.0038, outputPerThousand: 0.0152 },
    });
    expect(matchModel({ id: 'foundry-openai/gpt-5-mini' }, table)).toMatchObject({
      ok: true,
      price: { inputPerThousand: 0.0023802, outputPerThousand: 0.0190417 },
    });
  });

  it('gives embeddings an output price of 0 from their input-only meter', () => {
    expect(matchModel({ id: 'foundry/text-embedding-3-small' }, table)).toMatchObject({
      ok: true,
      price: { inputPerThousand: 0.0002, outputPerThousand: 0 },
    });
  });

  it('refuses to guess between versions with different prices', () => {
    expect(matchModel({ id: 'foundry-openai/x', family: 'gpt-4o' }, table).ok).toBe(false);
    expect(
      matchModel({ id: 'foundry-openai/x', family: 'gpt-4o-2024-11-20' }, table),
    ).toMatchObject({ ok: true, price: { inputPerThousand: 0.0238, outputPerThousand: 0.0952 } });
    expect(matchModel({ id: 'foundry-claude/claude-sonnet-4-5' }, table).ok).toBe(false);
  });

  it('applies the discovery globs from models.yaml', () => {
    const exclude = ['claude-*', 'text-embedding-*', '*-codex*', 'gpt-4.5-preview'];
    expect(globMatches('gpt-4.1-mini', ['*'], exclude)).toBe(true);
    expect(globMatches('gpt-5-codex', ['*'], exclude)).toBe(false);
    expect(globMatches('gpt-4.5-preview', ['*'], exclude)).toBe(false);
    expect(globMatches('gpt-4.5-preview-2', ['*'], exclude)).toBe(true);
    expect(globMatches('claude-sonnet-4-5', ['claude-*'], [])).toBe(true);
  });

  it('builds discovered ids per endpoint from one shared listing', () => {
    const listing = [
      { id: 'GPT-4o-2M-tps', model: 'gpt-4o' },
      { id: 'claude-opus-4-1', model: 'claude-opus-4-1' },
      { id: 'text-embedding-3-small', model: 'text-embedding-3-small' },
    ];
    expect(
      discoveredIds(
        [
          {
            name: 'foundry-openai',
            from: 'foundry-openai',
            include: ['*'],
            exclude: ['claude-*', 'text-embedding-*'],
          },
          {
            name: 'foundry-claude',
            from: 'foundry-openai',
            include: ['claude-*'],
            exclude: [],
          },
        ],
        new Map([['foundry-openai', listing]]),
      ),
    ).toEqual([
      { id: 'foundry-openai/gpt-4o-2m-tps', family: 'gpt-4o' },
      { id: 'foundry-claude/claude-opus-4-1', family: 'claude-opus-4-1' },
    ]);
  });

  it('reads an explicit id list with optional families', () => {
    expect(listedModels('a/b=gpt-4o, c/d')).toEqual([
      { id: 'a/b', family: 'gpt-4o' },
      { id: 'c/d' },
    ]);
  });

  it('writes sorted entries under a source comment', () => {
    expect(
      renderPrices(
        {
          'b/y': { inputPerThousand: 2, outputPerThousand: 3 },
          'a/x': { inputPerThousand: 0.1, outputPerThousand: 0 },
        },
        '2026-10-08',
      ),
    ).toBe(
      [
        '# Azure Retail Prices API (prices.azure.com), NOK per 1,000 tokens, GlobalStandard, Sweden Central, 2026-10-08',
        'models:',
        '  a/x: { inputPerThousand: 0.1, outputPerThousand: 0 }',
        '  b/y: { inputPerThousand: 2, outputPerThousand: 3 }',
        '',
      ].join('\n'),
    );
  });
});
