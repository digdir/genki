import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import {
  ModelError,
  type ChatChunk,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from '@genai/port-model';
import {
  KnowledgeError,
  type KnowledgePort,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import { errorResult, textOf, type ToolPort, type ToolResult } from '@genai/port-tools';
import {
  refusalText,
  runHooks,
  type HookCall,
  type HookConfig,
  type HookInvoker,
  type HookPoint,
  type HookRecord,
} from './hook.js';

export const hookEventType = 'x.hook.ran';

export interface WithHooksOptions {
  hooks(ctx: InvocationContext): Promise<HookConfig[]>;
  invoke: HookInvoker;
}

const modelPayload = (id: string, request: ChatRequest) => ({
  model: id,
  messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  tools: (request.tools ?? []).map((t) => t.name),
});

const resultPayload = (id: string, result: ChatResult) => ({
  model: id,
  content: result.content,
  toolCalls: result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
  finishReason: result.finishReason,
});

const searchPayload = (dataset: string, request: SearchRequest) => ({
  dataset,
  query: request.query,
  ...(request.limit !== undefined ? { limit: request.limit } : {}),
  ...(request.filters ? { filters: request.filters } : {}),
});

const hitsPayload = (dataset: string, request: SearchRequest, result: SearchResult) => ({
  dataset,
  query: request.query,
  hits: result.hits.map((h) => ({
    id: h.id,
    score: h.score,
    ...(h.title !== undefined ? { title: h.title } : {}),
    ...(h.url !== undefined ? { url: h.url } : {}),
    ...(h.document !== undefined ? { document: h.document } : {}),
    text: h.text.slice(0, 2000),
  })),
});

export const withHooks = <C>(inner: Strategy<C>, options: WithHooksOptions): Strategy<C> => {
  const wrap = (
    run: (ctx: InvocationContext) => AsyncIterable<Emitted>,
  ): ((ctx: InvocationContext) => AsyncIterable<Emitted>) =>
    async function* (ctx) {
      const hooks = await options.hooks(ctx);
      if (hooks.length === 0) {
        yield* run(ctx);
        return;
      }
      const records: HookRecord[] = [];
      const service = ctx.capability.id;
      const call = (point: HookPoint, payload: Record<string, unknown>): HookCall => ({
        point,
        tenant: ctx.tenant,
        task: ctx.task,
        service,
        payload,
      });
      const hooked = async (point: HookPoint, payload: Record<string, unknown>) => {
        const outcome = await runHooks(hooks, call(point, payload), options.invoke, ctx.signal);
        records.push(...outcome.records);
        return outcome.refused;
      };
      const has = (point: HookPoint, mode?: HookConfig['mode']) =>
        hooks.some((h) => h.enabled && h.point === point && (!mode || h.mode === mode));

      const model = (port: ModelPort): ModelPort => {
        const id = port.info().id;
        const before = async (request: ChatRequest) => {
          const refused =
            has('before_model') && (await hooked('before_model', modelPayload(id, request)));
          if (refused) throw new ModelError('refused', refusalText(refused));
        };
        const after = async (result: ChatResult) => {
          const refused =
            has('after_model') && (await hooked('after_model', resultPayload(id, result)));
          if (refused) throw new ModelError('refused', refusalText(refused));
        };
        return {
          info: () => port.info(),
          chat: async (request) => {
            await before(request);
            const result = await port.chat(request);
            await after(result);
            return result;
          },
          chatStream: async function* (request): AsyncIterable<ChatChunk> {
            await before(request);
            const hold = has('after_model', 'enforce');
            const held: ChatChunk[] = [];
            for await (const chunk of port.chatStream(request)) {
              if (chunk.kind === 'done') {
                await after(chunk.result);
                yield* held;
                yield chunk;
              } else if (hold) held.push(chunk);
              else yield chunk;
            }
          },
        };
      };

      const tool = (port: ToolPort): ToolPort => ({
        definition: () => port.definition(),
        call: async (input) => {
          const name = port.definition().name;
          const refusedBefore =
            has('before_tool') && (await hooked('before_tool', { tool: name, input }));
          if (refusedBefore) return errorResult(refusalText(refusedBefore));
          const result: ToolResult = await port.call(input);
          const refusedAfter =
            has('after_tool') &&
            (await hooked('after_tool', {
              tool: name,
              isError: result.isError === true,
              text: textOf(result),
            }));
          return refusedAfter ? errorResult(refusalText(refusedAfter)) : result;
        },
      });

      const knowledge = (port: KnowledgePort): KnowledgePort => {
        const dataset = port.info().id;
        const before = async (request: SearchRequest) => {
          const refused =
            has('before_search') &&
            (await hooked('before_search', searchPayload(dataset, request)));
          if (refused) throw new KnowledgeError('forbidden', refusalText(refused));
        };
        const after = async (request: SearchRequest, result: SearchResult) => {
          const refused =
            has('after_search') &&
            (await hooked('after_search', hitsPayload(dataset, request, result)));
          if (refused) throw new KnowledgeError('forbidden', refusalText(refused));
        };
        if (!has('before_search') && !has('after_search')) return port;
        const documents = port.documents?.bind(port);
        return {
          info: () => port.info(),
          search: async (request) => {
            await before(request);
            const result = await port.search(request);
            await after(request, result);
            return result;
          },
          searchMany: async (requests) => {
            for (const request of requests) await before(request);
            const results = await port.searchMany(requests);
            for (const [i, request] of requests.entries())
              await after(request, results[i] ?? { hits: [] });
            return results;
          },
          fetch: (ids) => port.fetch(ids),
          range: (document, from, to) => port.range(document, from, to),
          facets: (fields, filters) => port.facets(fields, filters),
          ...(documents ? { documents } : {}),
          ...(port.export ? { export: port.export } : {}),
        };
      };

      const scoped: InvocationContext = {
        ...ctx,
        use: async <P>(port: string, ref: Parameters<InvocationContext['use']>[1]) => {
          const opened = await ctx.use<P>(port, ref);
          if (port === 'model') return model(opened as ModelPort) as P;
          if (port === 'tools') return tool(opened as ToolPort) as P;
          if (port === 'knowledge') return knowledge(opened as KnowledgePort) as P;
          return opened;
        },
      };
      const drain = function* (): Generator<Emitted> {
        for (const record of records.splice(0))
          yield { type: hookEventType, audience: 'audit', data: record };
      };
      let paused = false;
      try {
        for await (const event of run(scoped)) {
          yield* drain();
          if (event.type === 'kernel.interrupt') paused = true;
          yield event;
        }
      } catch (error) {
        yield* drain();
        throw error;
      }
      yield* drain();
      if (!paused && has('task_completed')) {
        await hooked('task_completed', { task: ctx.task, service, status: 'completed' });
        yield* drain();
      }
    };

  return {
    ...inner,
    run: (ctx, input, config) => wrap((scoped) => inner.run(scoped, input, config))(ctx),
    ...(inner.resume
      ? {
          resume: (
            ctx: InvocationContext,
            checkpoint: unknown,
            response: Parameters<NonNullable<Strategy<C>['resume']>>[2],
            config: C,
          ) =>
            wrap((scoped) =>
              (inner.resume as NonNullable<Strategy<C>['resume']>)(
                scoped,
                checkpoint,
                response,
                config,
              ),
            )(ctx),
        }
      : {}),
  };
};
