import type { Input, Principal } from '@genai/contracts';
import type { DefinitionStore, ServiceDefinition } from '@genai/definitions';
import type { Kernel } from '@genai/kernel';
import {
  pollFolder,
  readablePart,
  type BlobInfo,
  type BlobStore,
  type ObservableBlobStore,
} from '@genai/port-blob';
import type { Admission, RunCost } from './quota.js';
import type { MessageQueue } from './queue.js';
import { schedule, type Clock } from './scheduler.js';
import { triggerId } from './trigger-runs.js';

export type Trigger = ServiceDefinition['spec']['triggers'][number];

export interface TriggerBinding {
  tenant: string;
  service: string;
  capability: string;
  trigger: Trigger;
}

export interface TriggerRun extends Partial<RunCost> {
  binding: TriggerBinding;
  task?: string;
  outcome: 'completed' | 'failed';
  error?: string;
  code?: string;
}

export const systemPrincipal =
  (scopes: string[] = ['genai:worker']) =>
  (tenant: string): Principal => ({
    kind: 'agency-system',
    issuer: 'urn:genai:worker',
    subject: `worker:${tenant}`,
    tenant,
    scopes,
  });

export const triggerBindings = async (store: DefinitionStore): Promise<TriggerBinding[]> => {
  const compiled = await store.capabilities();
  const bindings: TriggerBinding[] = [];
  const seen = new Set<string>();
  for (const c of compiled) {
    const key = `${c.service.tenant}/${c.service.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const published = await store.get('Service', c.service.tenant, c.service.id);
    if (published?.definition.kind !== 'Service') continue;
    const first = compiled.find(
      (o) => o.service.tenant === c.service.tenant && o.service.id === c.service.id,
    );
    for (const trigger of published.definition.spec.triggers) {
      bindings.push({
        tenant: c.service.tenant,
        service: c.service.id,
        capability: (first ?? c).capability.descriptor.id,
        trigger,
      });
    }
  }
  return bindings;
};

export interface TriggerRunnerOptions {
  kernel: Kernel;
  principalFor?: (tenant: string) => Principal;
  queue?: MessageQueue;
  blob?: BlobStore | ObservableBlobStore;
  clock?: Clock;
  timeZone?: string;
  pollIntervalMs?: number;
  onRun?: (run: TriggerRun) => void;
  paused?: (binding: TriggerBinding) => boolean | Promise<boolean>;
  blocked?: (binding: TriggerBinding) => Promise<{ code: string; error: string } | undefined>;
  admit?: (tenant: string) => Promise<Admission>;
  meter?: (task: string) => Promise<RunCost>;
}

const isObservable = (store: BlobStore): store is ObservableBlobStore => 'onPut' in store;

export const serviceLifecycleKind = 'service-lifecycle';

export const lifecycleBlock = async (
  history: (
    kind: string,
    scope: string,
    id: string,
  ) => Promise<{ spec: unknown; deleted: boolean; reason: string }[]>,
  binding: Pick<TriggerBinding, 'tenant' | 'service'>,
) => {
  const latest = (await history(serviceLifecycleKind, binding.tenant, binding.service)).at(-1);
  const state = (latest?.spec as { state?: string } | undefined)?.state;
  if (!latest || latest.deleted) return undefined;
  if (state === 'paused')
    return {
      code: 'service_paused',
      error: `Tjenesten er satt på pause. Begrunnelse: ${latest.reason}`,
    };
  if (state === 'archived')
    return { code: 'service_archived', error: 'Tjenesten er arkivert og kan ikke kjøres.' };
  return undefined;
};

export const bindingKey = (binding: TriggerBinding) =>
  `${binding.tenant}/${triggerId(binding.service, binding.trigger)}`;

export class TriggerRunner {
  #bound = new Map<string, { signature: string; stop: () => void }>();

  constructor(private readonly options: TriggerRunnerOptions) {}

  async #start(binding: TriggerBinding, input: Input) {
    if (await this.options.paused?.(binding)) return;
    const blocked = await this.options.blocked?.(binding);
    if (blocked) {
      this.options.onRun?.({
        binding,
        outcome: 'failed',
        error: blocked.error,
        code: blocked.code,
      });
      return;
    }
    const admission = (await this.options.admit?.(binding.tenant)) ?? { ok: true };
    if (!admission.ok) {
      this.options.onRun?.({
        binding,
        outcome: 'failed',
        error: admission.error,
        code: admission.code,
      });
      return;
    }
    const principal = (this.options.principalFor ?? systemPrincipal())(binding.tenant);
    let task: string | undefined;
    const metered = async () =>
      task && this.options.meter ? await this.options.meter(task).catch(() => ({})) : {};
    try {
      const run = await this.options.kernel.invoke(
        principal,
        binding.capability,
        input,
        admission.budget ? { budget: admission.budget } : {},
      );
      task = run.task;
      await run.result;
      this.options.onRun?.({ binding, task, outcome: 'completed', ...(await metered()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
      this.options.onRun?.({
        binding,
        ...(task ? { task } : {}),
        outcome: 'failed',
        error: message,
        ...(code ? { code } : {}),
        ...(await metered()),
      });
      throw error;
    }
  }

  start(bindings: TriggerBinding[]) {
    this.stop();
    const { failed } = this.reconcile(bindings);
    if (failed[0]) throw new Error(failed[0].error);
  }

  reconcile(bindings: TriggerBinding[]) {
    const wanted = new Map<string, TriggerBinding>();
    for (const binding of bindings) wanted.set(bindingKey(binding), binding);
    const result = {
      started: 0,
      stopped: 0,
      kept: 0,
      failed: [] as { key: string; error: string }[],
    };
    for (const [key, bound] of [...this.#bound]) {
      const next = wanted.get(key);
      if (next && JSON.stringify(next) === bound.signature) continue;
      bound.stop();
      this.#bound.delete(key);
      result.stopped += 1;
    }
    for (const [key, binding] of wanted) {
      if (this.#bound.has(key)) {
        result.kept += 1;
        continue;
      }
      try {
        this.#bound.set(key, { signature: JSON.stringify(binding), stop: this.#bind(binding) });
        result.started += 1;
      } catch (error) {
        result.failed.push({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  #bind(binding: TriggerBinding): () => void {
    const stops: (() => void)[] = [];
    try {
      const { trigger } = binding;
      if (trigger.kind === 'schedule') {
        const job = schedule(
          trigger.cron,
          (at) =>
            this.#start(binding, { data: { trigger: 'schedule', firedAt: at.toISOString() } }),
          {
            ...(this.options.clock ? { clock: this.options.clock } : {}),
            ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
            onError: () => undefined,
          },
        );
        stops.push(() => job.stop());
      } else if (trigger.kind === 'queue-message') {
        if (!this.options.queue) throw new Error(`no queue for ${binding.service}`);
        stops.push(
          this.options.queue.subscribe(`${binding.tenant}:${trigger.queue}`, (message) =>
            this.#start(binding, {
              data: { trigger: 'queue-message', queue: trigger.queue, message: message.body },
              ...(typeof message.body === 'string'
                ? {
                    parts: [
                      { mime: 'text/plain', body: { kind: 'text' as const, text: message.body } },
                    ],
                  }
                : {}),
            }),
          ),
        );
      } else {
        const store = this.options.blob;
        if (!store) throw new Error(`no blob store for ${binding.service}`);
        const prefix = trigger.folder.endsWith('/') ? trigger.folder : `${trigger.folder}/`;
        const arrived = async (info: BlobInfo) => {
          const body = (await store.get(info))?.body;
          await this.#start(binding, {
            parts: [readablePart(info, body)],
            data: { trigger: 'document-arrives', path: info.path },
          }).catch(() => undefined);
        };
        if (isObservable(store)) {
          stops.push(store.onPut(binding.tenant, prefix, arrived));
        } else {
          const watcher = pollFolder(store, binding.tenant, prefix, arrived, {
            intervalMs: this.options.pollIntervalMs ?? 10_000,
          });
          stops.push(() => watcher.stop());
        }
      }
    } catch (error) {
      for (const stop of stops) stop();
      throw error;
    }
    return () => {
      for (const stop of stops) stop();
    };
  }

  stop() {
    for (const bound of this.#bound.values()) bound.stop();
    this.#bound.clear();
  }
}
