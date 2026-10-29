import type { Input } from '@genai/contracts';
import type { Emitted, Strategy } from '@genai/kernel';
import { describe, expect, it } from 'vitest';
import { usingRetrievalPorts, withFixedFilters } from './retrieval-ports.js';

const fixed = { field: 'product', 'selected-options': ['Maskinporten'] };
const config = { knowledge: { datasets: [{ dataset: 'd' }], filters: { fields: [fixed] } } };
const filterBy = (input: Input) =>
  (input.data as { overrides?: Record<string, { fields: unknown[] }> }).overrides?.[
    'retrieve-filter-by'
  ]?.fields;

describe('a variant fixed filter', () => {
  it('goes before the caller filters, keeps the other overrides, and adds nothing without a filter', () => {
    const caller = { field: 'language', 'selected-options': ['nb'] };
    const input: Input = {
      data: { query: 'q', overrides: { x: 1, 'retrieve-filter-by': { fields: [caller] } } },
    } as Input;

    const merged = withFixedFilters(input, config);

    expect(filterBy(merged)).toEqual([fixed, caller]);
    expect((merged.data as { overrides: { x: number } }).overrides.x).toBe(1);
    expect(filterBy(withFixedFilters({ data: { query: 'q' } } as Input, config))).toEqual([fixed]);
    expect(withFixedFilters(input, { knowledge: { datasets: [] } })).toBe(input);
  });

  it('is added once when a nested strategy is wrapped too', () => {
    const once = withFixedFilters({ data: { query: 'q' } } as Input, config);
    expect(withFixedFilters(once, config)).toBe(once);
  });

  it('reaches the wrapped strategy on run', async () => {
    const seen: Input[] = [];
    const strategy: Strategy<unknown> = {
      id: 's',
      version: '1',
      requires: { kernel: 1, ports: [], features: [] },
      run: async function* (_ctx, input) {
        seen.push(input);
        yield* [] as Emitted[];
      },
    };
    const wrapped = usingRetrievalPorts(strategy);

    for await (const _ of wrapped.run({} as never, { data: { query: 'q' } } as Input, config))
      void _;

    expect(filterBy(seen[0] as Input)).toEqual([fixed]);
    expect(wrapped.requires.ports).toEqual(['model', 'knowledge', 'rerank']);
  });
});
