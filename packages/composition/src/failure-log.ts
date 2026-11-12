import type { Ref } from '@genai/contracts';
import type { EventLog, PortContext } from '@genai/kernel';
import {
  retryAfterMsOf,
  type EmbeddingOpenOptions,
  type EmbeddingPort,
} from '@genai/port-embedding';
import { ModelError, type ChatRequest, type ModelPort } from '@genai/port-model';

export type ApiLog = (msg: string, fields: Record<string, unknown>) => void;

type CapabilityOf = (task: string) => Promise<string | undefined>;

const requestErrors = new Set(['bad_request', 'unsupported']);
const reasonLength = 300;

const errorFields = (error: unknown) => {
  const named = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const reason =
    error instanceof ModelError && requestErrors.has(error.code)
      ? error.message.slice(0, reasonLength)
      : undefined;
  return {
    error: named,
    ...(typeof code === 'string' ? { code } : {}),
    ...(reason ? { reason } : {}),
  };
};

export const loggedModels = <R extends { open(ref: Ref, ctx: PortContext): ModelPort }>(
  router: R,
  log: ApiLog,
  capabilityOf: CapabilityOf,
): R => {
  const report = (ref: Ref, ctx: PortContext, error: unknown) => {
    void capabilityOf(ctx.task)
      .catch(() => undefined)
      .then((capability) =>
        log('model call failed', {
          task: ctx.task,
          tenant: ctx.tenant,
          ...(capability ? { capability } : {}),
          model: ref.id,
          ...errorFields(error),
        }),
      );
  };
  return Object.assign(Object.create(router) as R, {
    open: (ref: Ref, ctx: PortContext): ModelPort => {
      const port = router.open(ref, ctx);
      return Object.assign(Object.create(port) as ModelPort, {
        chat: async (request: ChatRequest) => {
          try {
            return await port.chat(request);
          } catch (error) {
            report(ref, ctx, error);
            throw error;
          }
        },
        chatStream: async function* (request: ChatRequest) {
          try {
            yield* port.chatStream(request);
          } catch (error) {
            report(ref, ctx, error);
            throw error;
          }
        },
      });
    },
  });
};

// The error's message is left out: a provider may quote the input in it.
export const loggedEmbedders = <
  R extends {
    open(ref: Ref, ctx: PortContext, request?: EmbeddingOpenOptions): EmbeddingPort;
  },
>(
  router: R,
  log: ApiLog,
  capabilityOf: CapabilityOf,
): R => {
  const open = (ref: Ref, ctx: PortContext, request?: EmbeddingOpenOptions): EmbeddingPort => {
    const port = router.open(ref, ctx, request);
    return Object.assign(Object.create(port) as EmbeddingPort, {
      embed: async (texts: string[]) => {
        try {
          return await port.embed(texts);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          // A caller that retries itself (a knowledge job, #400) waits out a 429 and retries a 5xx,
          // and logs the failure only when it gives up; counting each try would fire the alert.
          if (request?.retries === 0 && (code === 'rate_limited' || code === 'unavailable'))
            throw error;
          void capabilityOf(ctx.task)
            .catch(() => undefined)
            .then((capability) =>
              log('model call failed', {
                task: ctx.task,
                tenant: ctx.tenant,
                ...(capability ? { capability } : {}),
                model: ref.id,
                error: error instanceof Error ? error.name : typeof error,
                ...(typeof code === 'string' ? { code } : {}),
              }),
            );
          throw error;
        }
      },
    });
  };
  // A proxy, not a prototype: the router's other methods read its private fields.
  return new Proxy(router, {
    get: (target, property) => {
      if (property === 'open') return open;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
};

const requestedModel = (body: unknown): string | undefined => {
  if (typeof body !== 'string') return undefined;
  try {
    const model = (JSON.parse(body) as { model?: unknown } | null)?.model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
};

// Logs each 429 before the SDK waits and retries; the body is read only for its `model` field.
export const throttleLoggedFetch =
  (endpoint: string, inner: typeof fetch, log: ApiLog): typeof fetch =>
  async (input, init) => {
    const response = await inner(input, init);
    if (response.status !== 429) return response;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const retries = Number(headers.get('x-stainless-retry-count') ?? 0);
    const model = requestedModel(init?.body);
    const wait = retryAfterMsOf(response.headers);
    log('model call throttled', {
      endpoint,
      ...(model ? { model } : {}),
      status: response.status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
      attempt: (Number.isInteger(retries) && retries >= 0 ? retries : 0) + 1,
    });
    return response;
  };

export const failureLoggingEventLog = (
  inner: EventLog,
  log: ApiLog,
  capabilityOf: CapabilityOf,
  options: { messages?: boolean } = {},
): EventLog => {
  const models = new Map<string, Set<string>>();
  return {
    append: async (event, scope) => {
      const stored = await inner.append(event, scope);
      const data = (event.data ?? {}) as {
        port?: string;
        ref?: { id?: string };
        code?: unknown;
        status?: string;
        message?: unknown;
        provider?: { status?: unknown; body?: unknown };
      };
      if (event.type === 'kernel.resource.used' && data.port === 'model' && data.ref?.id)
        models.set(event.task, (models.get(event.task) ?? new Set()).add(data.ref.id));
      if (event.type === 'kernel.error' && event.audience === 'audit') {
        const used = [...(models.get(event.task) ?? [])];
        const capability = await capabilityOf(event.task).catch(() => undefined);
        log('task failed', {
          task: event.task,
          tenant: scope.tenant,
          ...(capability ? { capability } : {}),
          ...(used.length > 0 ? { models: used } : {}),
          ...(typeof data.code === 'string' ? { code: data.code } : {}),
          ...(options.messages && typeof data.message === 'string'
            ? { message: data.message }
            : {}),
          ...(typeof data.provider?.status === 'number'
            ? { providerStatus: data.provider.status }
            : {}),
          ...(options.messages && typeof data.provider?.body === 'string'
            ? { providerBody: data.provider.body }
            : {}),
        });
      }
      if (
        event.type === 'kernel.task.status' &&
        ['completed', 'failed', 'cancelled'].includes(String(data.status))
      )
        models.delete(event.task);
      return stored;
    },
    read: (task, fromSeq, isLive) => inner.read(task, fromSeq, isLive),
    wake: (task) => inner.wake(task),
  };
};
