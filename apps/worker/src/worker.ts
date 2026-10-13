import type { Principal } from '@genai/contracts';
import type { Runtime } from '@genai/composition';
import type { PolicyDecisionPoint } from '@genai/kernel';
import {
  InMemoryQueue,
  TriggerRunner,
  systemPrincipal,
  triggerBindings,
  type Admission,
  type Clock,
  type MessageQueue,
  type RunCost,
  type TriggerBinding,
  type TriggerRun,
} from '@genai/jobs';

export const ownTenantOnly = (systemScope = 'genai:worker'): PolicyDecisionPoint => ({
  decide: async (principal: Principal) =>
    principal.kind === 'agency-system' && principal.scopes?.includes(systemScope)
      ? { allow: true }
      : { allow: false, reason: 'the worker only runs as an agency system user' },
});

export interface WorkerOptions {
  runtime: Pick<Runtime, 'kernel' | 'registry' | 'store' | 'blobStore' | 'sync'>;
  queue?: MessageQueue;
  clock?: Clock;
  pollIntervalMs?: number;
  onRun?: (run: TriggerRun) => void;
  paused?: (binding: TriggerBinding) => boolean | Promise<boolean>;
  blocked?: (binding: TriggerBinding) => Promise<{ code: string; error: string } | undefined>;
  active?: () => boolean | Promise<boolean>;
  admit?: (tenant: string) => Promise<Admission>;
  meter?: (task: string) => Promise<RunCost>;
}

export const createWorker = (options: WorkerOptions) => {
  const { runtime } = options;
  const { kernel } = runtime;
  const queue = options.queue ?? new InMemoryQueue();
  const runner = new TriggerRunner({
    kernel,
    queue,
    blob: runtime.blobStore,
    principalFor: systemPrincipal(),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.onRun ? { onRun: options.onRun } : {}),
    ...(options.paused ? { paused: options.paused } : {}),
    ...(options.blocked ? { blocked: options.blocked } : {}),
    ...(options.admit ? { admit: options.admit } : {}),
    ...(options.meter ? { meter: options.meter } : {}),
  });

  let syncing: Promise<unknown> = Promise.resolve();
  const syncOnce = async () => {
    await runtime.sync();
    const bindings = await triggerBindings(runtime.store);
    const active = (await options.active?.()) ?? true;
    const changes = runner.reconcile(active ? bindings : []);
    return {
      capabilities: runtime.registry.all().length,
      triggers: bindings.length,
      active,
      ...changes,
    };
  };
  const sync = () => {
    const next = syncing.catch(() => undefined).then(syncOnce);
    syncing = next;
    return next;
  };

  return { kernel, queue, sync, stop: () => runner.stop() };
};
