import { describe, expect, it } from 'vitest';
import type { Ref } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { withDocumentScope } from './document-scope.js';

const fakeContext = (state: Map<string, unknown>, opened: string[]) =>
  ({
    state: {
      get: async (_scope: string, key: string) =>
        state.has(key) ? { v: 1, value: state.get(key) } : undefined,
      put: async (_scope: string, key: string, value: unknown) => {
        state.set(key, value);
        return 1;
      },
      checkpoint: async () => undefined,
    },
    use: async (_port: string, ref: Ref) => ({
      info: () => ({ id: ref.id, filters: { doc_num: 'multiselect' } }),
      search: async (request: { filters?: Record<string, unknown> }) => {
        opened.push(JSON.stringify(request.filters ?? {}));
        return { hits: [] };
      },
      datasets: () => [],
    }),
  }) as unknown as InvocationContext;

const searching: Strategy = {
  id: 'searching',
  version: '1',
  requires: { kernel: 1, ports: ['knowledge'], features: [] },
  run: async function* () {
    yield* [];
  },
  resume: async function* (ctx) {
    const port = await ctx.use<{ search(r: unknown): Promise<unknown> }>('knowledge', {
      kind: 'dataset',
      id: 'digdir/kudos',
    });
    await port.search({ query: 'mål' });
    yield* [];
  },
};

describe('document scope', () => {
  it('keeps a batch item inside its document after the run resumes from an approval', async () => {
    const state = new Map<string, unknown>();
    const searches: string[] = [];
    const scoped = withDocumentScope(() => undefined, searching);
    const input = {
      parts: [],
      data: { document: { id: '330296', dataset: 'digdir/kudos' } },
    };

    for await (const _ of scoped.run(fakeContext(state, searches), input, {})) void _;
    for await (const _ of (scoped.resume as NonNullable<Strategy['resume']>)(
      fakeContext(state, searches),
      {},
      { parts: [] },
      {},
    ))
      void _;

    expect(state.get('document-scope')).toEqual({ id: '330296', dataset: 'digdir/kudos' });
    expect(searches).toHaveLength(1);
    expect(searches[0]).toContain('330296');
  });
});
