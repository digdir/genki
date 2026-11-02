import { z } from 'zod';
import type { Block } from '../blocks.js';
import { retrievalFor } from './retrieval.js';

const params = z.strictObject({
  fields: z.array(z.string().min(1)).min(1).max(20),
  maxValues: z.number().int().min(1).max(1000).default(200),
});
const facet = z.strictObject({ value: z.string(), count: z.number() });

export const facetsBlock: Block<Record<string, never>, z.infer<typeof params>> = {
  name: 'facets',
  version: '1',
  description: 'Read bounded facet values and counts from the service datasets',
  input: z.strictObject({}),
  params,
  output: z.strictObject({
    values: z.record(z.string(), z.array(z.string())),
    facets: z.record(z.string(), z.array(facet)),
  }),
  run: async function* (ctx, _input, params) {
    yield* [];
    const retrieval = await retrievalFor(ctx, undefined);
    if (!retrieval.facets) throw new Error(`step ${ctx.step} needs retrieval with facets`);
    const fields = [...new Set(params.fields)];
    const found = await retrieval.facets(fields, params.maxValues, ctx.invocation.signal);
    // Bound the block output even when a custom retrieval backend ignores the requested cap.
    const facets = Object.fromEntries(
      fields.map((field) => [field, (found[field] ?? []).slice(0, params.maxValues)]),
    );
    return {
      values: Object.fromEntries(
        Object.entries(facets).map(([field, list]) => [field, list.map((v) => v.value)]),
      ),
      facets,
    };
  },
};
