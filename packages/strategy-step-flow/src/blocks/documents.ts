import { z } from 'zod';
import type { Block, BlockContext } from '../blocks.js';
import type { FlowChunk, FlowDocument, FlowRetrieval } from '../services.js';
import { chunkSchema, retrievalFor } from './retrieval.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const clause = z.union([
  scalar,
  z.array(z.union([z.string(), z.number()])),
  z.strictObject({ not: z.array(z.union([z.string(), z.number()])) }),
  z.strictObject({ contains: z.array(z.string()) }),
  z.strictObject({
    gte: z.union([z.number(), z.string()]).optional(),
    lte: z.union([z.number(), z.string()]).optional(),
  }),
]);
const filterValue = z.union([clause, z.strictObject({ all: z.array(clause) })]);

const unset = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

const filterMap = z
  .record(z.string(), z.unknown())
  .optional()
  .transform((filters, ctx) => {
    const kept = Object.entries(filters ?? {}).filter(([, v]) => !unset(v));
    const out: Record<string, z.infer<typeof filterValue>> = {};
    for (const [field, value] of kept) {
      const parsed = filterValue.safeParse(value);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `filter ${field} has an unsupported value`,
        });
        return z.NEVER;
      }
      out[field] = parsed.data;
    }
    return out;
  });

const documentSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().optional(),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
}) as unknown as z.ZodType<FlowDocument>;

const supporting = async <K extends 'documents' | 'readDocument'>(
  ctx: BlockContext,
  method: K,
): Promise<FlowRetrieval & Required<Pick<FlowRetrieval, K>>> => {
  const retrieval = await retrievalFor(ctx, undefined);
  if (!retrieval[method])
    throw new Error(`step ${ctx.step}: the service's datasets cannot be read document by document`);
  return retrieval as FlowRetrieval & Required<Pick<FlowRetrieval, K>>;
};

const documentsInput = z.looseObject({
  ids: z
    .array(z.string())
    .nullish()
    .transform((ids) => (ids ?? []).filter((id) => id.trim())),
  filters: filterMap,
});
const documentsParams = z.strictObject({
  filters: filterMap,
  limit: z.number().int().positive().max(1000).default(50),
});

export const documentsBlock: Block<
  z.infer<typeof documentsInput>,
  z.infer<typeof documentsParams>
> = {
  name: 'documents',
  version: '1',
  description: "List documents from the service's datasets by filters or ids, without generating",
  input: documentsInput,
  params: documentsParams,
  output: z.strictObject({ documents: z.array(documentSchema) }),
  run: async function* (ctx, input, params) {
    const retrieval = await supporting(ctx, 'documents');
    const filters = { ...params.filters, ...input.filters };
    const documents = await retrieval.documents(
      {
        ...(input.ids.length > 0 ? { ids: input.ids } : {}),
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        limit: params.limit,
      },
      ctx.invocation.signal,
    );
    yield {
      type: 'kernel.notice',
      data: { kind: 'documents', step: ctx.step, count: documents.length },
    };
    return { documents };
  },
};

const readInput = z.looseObject({
  document: z.union([
    z.string().min(1),
    z.looseObject({ id: z.string().min(1) }).transform((d) => d.id),
  ]),
  query: z.string().optional(),
});
const readParams = z.strictObject({
  maxChunks: z.number().int().positive().max(2000).default(200),
  topK: z.number().int().positive().optional(),
});

const inReadingOrder = (chunks: FlowChunk[]) =>
  chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort(
      (a, b) =>
        (a.chunk.position ?? Number.MAX_SAFE_INTEGER) -
          (b.chunk.position ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({ chunk }) => chunk);

const hitsOf = (chunks: FlowChunk[]) =>
  chunks.map((c) => ({
    id: c.chunkId,
    ...(c.document === undefined ? {} : { document: c.document }),
    ...(c.position === undefined ? {} : { position: c.position }),
  }));

export const readDocumentBlock: Block<z.infer<typeof readInput>, z.infer<typeof readParams>> = {
  name: 'read-document',
  version: '1',
  description: "Read one document's chunks, optionally reranked by a question and cut to the best",
  input: readInput,
  params: readParams,
  output: z.looseObject({ document: z.string(), chunks: z.array(chunkSchema) }),
  run: async function* (ctx, input, params) {
    const retrieval = await supporting(ctx, 'readDocument');
    const signal = ctx.invocation.signal;
    let chunks = await retrieval.readDocument(input.document, params.maxChunks, signal);
    if (chunks.length === 0) throw new Error(`the document ${input.document} has no text`);
    if (input.query?.trim() && params.topK !== undefined) {
      try {
        chunks = await retrieval.rerank(input.query, chunks, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        yield {
          type: 'kernel.notice',
          data: { kind: 'step', step: ctx.step, stage: 'rerank-failed' },
        };
      }
      chunks = chunks.slice(0, params.topK);
    }
    chunks = inReadingOrder(chunks);
    yield { type: 'kernel.notice', data: { kind: 'retrieval', hits: hitsOf(chunks) } };
    return { document: input.document, chunks };
  },
};
