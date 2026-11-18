import type { Principal } from '@genai/contracts';
import type { Capability, Kernel, PortContext, Strategy } from '@genai/kernel';

export type TrackedWork = <T>(
  principal: Principal,
  work: (ctx: PortContext) => Promise<T>,
) => Promise<{ value: T; task: string }>;

interface Pending {
  work: (ctx: PortContext) => Promise<unknown>;
  value?: unknown;
  failed?: { error: unknown };
}

/** Runs platform model work as a kernel task, so its usage counts like a service call. */
export const trackedWork = (input: {
  id: string;
  title: string;
  platformTenant: string;
  outputTokens: number;
}) => {
  const pending = new Map<string, Pending>();
  const strategyId = `${input.id}.run`;
  const capability: Capability = {
    descriptor: {
      id: input.id,
      version: '1',
      tenant: input.platformTenant,
      availableTo: '*',
      title: input.title,
      description: input.title,
      input: {},
      interaction: ['unary'],
      accepts: ['application/json'],
      produces: ['application/json'],
      emits: [],
      oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: '' },
    },
    strategy: { id: strategyId, version: '1' },
    config: {},
    grants: [],
    deadlineMs: 5 * 60_000,
  };
  const strategy: Strategy = {
    id: strategyId,
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx, data) {
      const call = pending.get(String((data.data as { call?: unknown } | undefined)?.call));
      if (!call) throw new Error(`no work for ${input.id}`);
      try {
        call.value = await call.work({
          tenant: ctx.tenant,
          principal: ctx.principal,
          task: ctx.task,
          signal: ctx.signal,
          meter: (usage, model) => ctx.budget.charge(usage, model),
          outputLimit: () => input.outputTokens,
        });
      } catch (error) {
        call.failed = { error };
        throw error;
      }
      yield { type: 'kernel.result', data: [] };
    },
  };
  const run =
    (kernel: () => Kernel): TrackedWork =>
    async <T>(principal: Principal, work: (ctx: PortContext) => Promise<T>) => {
      const call = crypto.randomUUID();
      const entry: Pending = { work };
      pending.set(call, entry);
      try {
        const started = await kernel().invoke(principal, input.id, { data: { call } });
        try {
          await started.result;
        } catch (error) {
          throw entry.failed?.error ?? error;
        }
        return { value: entry.value as T, task: started.task };
      } finally {
        pending.delete(call);
      }
    };
  return { capability, strategy, run };
};
