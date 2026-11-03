import type { EventLog, OutsideRun, PortContext } from '@genai/kernel';

export const outsideRunTask = (tenant: string, at: Date) =>
  `outside-run:${tenant}:${at.toISOString().slice(0, 10)}`;

/** Audits and meters model calls made outside a run, one log per tenant and day. */
export const outsideRun = (log: EventLog, now: () => Date = () => new Date()): OutsideRun => {
  const append = async (ctx: PortContext, type: string, data: Record<string, unknown>) => {
    const at = now();
    const task = outsideRunTask(ctx.tenant, at);
    await log.append(
      {
        type,
        v: 1,
        task,
        ts: at.toISOString(),
        data: { ...data, task: ctx.task },
        actor: 'kernel',
        audience: 'audit',
      },
      { tenant: ctx.tenant, key: JSON.stringify(['task', task]) },
    );
  };
  return {
    audit: (ctx, record) => append(ctx, 'kernel.gate.call', { ...record }),
    meter: (ctx, usage, model) => append(ctx, 'kernel.usage', { usage, model }),
  };
};
