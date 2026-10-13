import type { Input, Ref } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { scopeToDocument, unreachableKnowledge, type KnowledgePort } from '@genai/port-knowledge';

export interface ScopedDocument {
  id: string;
  dataset: string;
}

export const documentOf = (input: Input): ScopedDocument | undefined => {
  const data = input.data as { document?: unknown } | undefined;
  const document = data?.document as { id?: unknown; dataset?: unknown } | undefined;
  return typeof document?.id === 'string' &&
    document.id &&
    typeof document.dataset === 'string' &&
    document.dataset
    ? { id: document.id, dataset: document.dataset }
    : undefined;
};

const scopedContext = (
  ctx: InvocationContext,
  resolve: (dataset: string) => string | undefined,
  document: ScopedDocument,
): InvocationContext => {
  const target = resolve(document.dataset) ?? document.dataset;
  const use = async <P>(port: string, ref: Ref): Promise<P> => {
    const opened = await ctx.use<P>(port, ref);
    if (port !== 'knowledge') return opened;
    const knowledge = opened as KnowledgePort;
    return (
      (resolve(ref.id) ?? ref.id) === target
        ? scopeToDocument(knowledge, document.id)
        : unreachableKnowledge(knowledge)
    ) as P;
  };
  return { ...ctx, use };
};

const scopeKey = 'document-scope';

const isScopedDocument = (value: unknown): value is ScopedDocument =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ScopedDocument).id === 'string' &&
  typeof (value as ScopedDocument).dataset === 'string';

export const withDocumentScope = <C>(
  resolve: (dataset: string) => string | undefined,
  inner: Strategy<C>,
): Strategy<C> => {
  const resume = inner.resume;
  return {
    ...inner,
    run: async function* (ctx, input, config) {
      const document = documentOf(input);
      if (document) await ctx.state.put('task', scopeKey, document);
      yield* inner.run(document ? scopedContext(ctx, resolve, document) : ctx, input, config);
    },
    ...(resume
      ? {
          resume: async function* (ctx, checkpoint, response, config) {
            const stored = (await ctx.state.get<unknown>('task', scopeKey))?.value;
            const document = isScopedDocument(stored) ? stored : undefined;
            yield* resume(
              document ? scopedContext(ctx, resolve, document) : ctx,
              checkpoint,
              response,
              config,
            );
          },
        }
      : {}),
  };
};
