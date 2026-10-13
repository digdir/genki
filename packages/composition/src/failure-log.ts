import type { Ref } from '@genai/contracts';
import type { EventLog, PortContext } from '@genai/kernel';
import type { ChatRequest, ModelPort } from '@genai/port-model';

export type ApiLog = (msg: string, fields: Record<string, unknown>) => void;

type CapabilityOf = (task: string) => Promise<string | undefined>;

const errorFields = (error: unknown) => {
  const named = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return { error: named, ...(typeof code === 'string' ? { code } : {}) };
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
