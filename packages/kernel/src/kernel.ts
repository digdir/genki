import {
  strategyEventTypes,
  type CapabilityDescriptor,
  type Event,
  type EventActor,
  type Input,
  type Interrupt,
  type Part,
  type Principal,
  type Ref,
  type ResourceProvenance,
  type Task,
  type TaskStatus,
  type Usage,
} from '@genai/contracts';
import {
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  sameRef,
  type ContentScope,
  type EventLog,
  type StateStore,
  type StoredTask,
  type TaskStore,
} from './memory.js';
import { DeltaCoalescer } from './deltas.js';
import {
  KERNEL_MAJOR,
  KernelError,
  supportedFeatures,
  type Budget,
  type Capability,
  type Emitted,
  type Feature,
  type InvocationContext,
  type InvokeOptions,
  type Kernel,
  type PolicyAction,
  type PolicyDecisionPoint,
  type PortContext,
  type PortProvider,
  type Run,
  type StateScope,
  type Strategy,
} from './spi.js';

export interface KernelLimits {
  maxDepth: number;
  maxEventsPerTask: number;
  maxConcurrentPerTenant: number;
  deltaFlushMs: number;
  deltaFlushChars: number;
}

export interface CapabilitySource {
  all(): readonly Capability[];
}

export interface KernelOptions {
  strategies: Strategy[];
  capabilities: Capability[] | CapabilitySource;
  ports: Record<string, PortProvider>;
  policy: PolicyDecisionPoint;
  log?: EventLog;
  tasks?: TaskStore;
  state?: StateStore;
  limits?: Partial<KernelLimits>;
  newId?: () => string;
  now?: () => Date;
}

const defaultLimits: KernelLimits = {
  maxDepth: 8,
  maxEventsPerTask: 10_000,
  maxConcurrentPerTenant: 100,
  deltaFlushMs: 100,
  deltaFlushChars: 500,
};

const usageKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'requests',
  'costMicroNok',
] as const;

const strategyTypes = new Set<string>(strategyEventTypes);
const extensionType = /^x\.[a-z0-9-]+\.[a-z0-9.-]+$/i;

const isRunning = (status: TaskStatus) => status === 'queued' || status === 'running';
const isTerminal = (status: TaskStatus) =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

const principalRef = (p: Principal): Ref => ({
  kind: p.kind,
  id: JSON.stringify([p.issuer, p.subject]),
  ...(p.tenant === undefined ? {} : { tenant: p.tenant }),
});

const principalKey = (p: Principal) =>
  JSON.stringify([p.kind, p.issuer, p.subject, p.tenant ?? null]);

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const addUsage = (a: Usage, b: Usage): Usage => {
  const sum: Usage = {};
  for (const k of usageKeys) {
    const total = (a[k] ?? 0) + (b[k] ?? 0);
    if (total) sum[k] = total;
  }
  return sum;
};

const tighter = (a: Usage | undefined, b: Usage): Usage => {
  const least: Usage = { ...a };
  for (const k of usageKeys) {
    const v = b[k];
    if (v !== undefined) least[k] = Math.min(least[k] ?? v, v);
  }
  return least;
};

class BudgetNode {
  used: Usage;

  constructor(
    readonly limit: Usage | undefined,
    readonly parent: BudgetNode | undefined,
    readonly onTrip: (error: KernelError) => void,
    used: Usage = {},
  ) {
    this.used = used;
  }

  chain(): BudgetNode[] {
    return [this, ...(this.parent?.chain() ?? [])];
  }

  remaining(): Usage | undefined {
    if (!this.limit) return undefined;
    const left: Usage = {};
    for (const k of usageKeys) {
      const max = this.limit[k];
      if (max !== undefined) left[k] = max - (this.used[k] ?? 0);
    }
    return left;
  }

  headroom(): Usage | undefined {
    const left = this.chain()
      .map((node) => node.remaining())
      .filter((u): u is Usage => u !== undefined);
    if (left.length === 0) return undefined;
    const least: Usage = {};
    for (const k of usageKeys) {
      const values = left.map((u) => u[k]).filter((v): v is number => v !== undefined);
      if (values.length) least[k] = Math.min(...values);
    }
    return least;
  }

  charge(usage: Usage): void {
    for (const k of usageKeys) {
      const v = usage[k];
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
        throw new KernelError('invalid_state', `usage ${k} must be a non-negative number`);
      }
    }
    const chain = this.chain();
    for (const node of chain) node.used = addUsage(node.used, usage);
    for (const node of chain) {
      for (const k of usageKeys) {
        const max = node.limit?.[k];
        if (max !== undefined && (node.used[k] ?? 0) > max) {
          const error = new KernelError('budget_exceeded', `budget for ${k} exceeded`);
          node.onTrip(error);
          throw error;
        }
      }
    }
  }
}

interface Live {
  task: Task;
  principal: Principal;
  capability: Capability;
  strategy: Strategy;
  controller: AbortController;
  abortReason?: KernelError;
  budget: BudgetNode;
  maxOutputTokens?: number;
  entryPoint?: string;
  checkpoint?: unknown;
  responder?: Principal;
  lastSeq: number;
  chain: Promise<unknown>;
  eventCount: number;
  depth: number;
  finished: boolean;
  settle: { resolve(parts: Part[]): void; reject(error: Error): void };
}

const aborted = Symbol('aborted');

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof aborted> => {
  promise.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(aborted);
  return Promise.race([
    promise,
    new Promise<typeof aborted>((resolve) =>
      signal.addEventListener('abort', () => resolve(aborted), { once: true }),
    ),
  ]);
};

export const checkCapability = (
  options: Pick<KernelOptions, 'strategies' | 'ports'>,
  cap: Capability,
) => {
  const name = `capability ${cap.descriptor.id}`;
  const strategy = options.strategies.find(
    (s) => s.id === cap.strategy.id && s.version === cap.strategy.version,
  );
  if (!strategy) {
    throw new KernelError(
      'misconfigured',
      `${name}: no strategy ${cap.strategy.id}@${cap.strategy.version}`,
    );
  }
  if (strategy.requires.kernel !== KERNEL_MAJOR) {
    throw new KernelError(
      'misconfigured',
      `${name}: strategy needs kernel ${strategy.requires.kernel}`,
    );
  }
  for (const port of strategy.requires.ports) {
    if (!options.ports[port])
      throw new KernelError('misconfigured', `${name}: no provider for port ${port}`);
  }
  for (const feature of strategy.requires.features) {
    if (!supportedFeatures.includes(feature)) {
      throw new KernelError('misconfigured', `${name}: feature ${feature} is not supported`);
    }
  }
};

const checkUnique = (capabilities: readonly Capability[]) => {
  const ids = new Set<string>();
  for (const cap of capabilities) {
    if (ids.has(cap.descriptor.id))
      throw new KernelError('misconfigured', `duplicate capability ${cap.descriptor.id}`);
    ids.add(cap.descriptor.id);
  }
};

export class CapabilityRegistry implements CapabilitySource {
  #capabilities: readonly Capability[] = [];

  constructor(private readonly options: Pick<KernelOptions, 'strategies' | 'ports'>) {}

  all() {
    return this.#capabilities;
  }

  replace(predicate: (c: Capability) => boolean, next: Capability[]) {
    for (const cap of next) checkCapability(this.options, cap);
    const merged = [...this.#capabilities.filter((c) => !predicate(c)), ...next];
    checkUnique(merged);
    this.#capabilities = merged;
  }
}

const validate = (options: KernelOptions) => {
  const strategyKeys = new Set<string>();
  for (const s of options.strategies) {
    const key = `${s.id}@${s.version}`;
    if (strategyKeys.has(key)) throw new KernelError('misconfigured', `duplicate strategy ${key}`);
    strategyKeys.add(key);
  }
  if (!Array.isArray(options.capabilities)) return;
  checkUnique(options.capabilities);
  for (const cap of options.capabilities) checkCapability(options, cap);
};

export const createKernel = (options: KernelOptions): Kernel => {
  validate(options);
  const log = options.log ?? new InMemoryEventLog();
  const store = options.tasks ?? new InMemoryTaskStore();
  const state = options.state ?? new InMemoryStateStore();
  const limits = { ...defaultLimits, ...options.limits };
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const live = new Map<string, Live>();

  const source = options.capabilities;
  const capabilities = (): readonly Capability[] => (Array.isArray(source) ? source : source.all());

  const capabilityById = (id: string) => {
    const capability = capabilities().find((c) => c.descriptor.id === id);
    if (!capability) throw new KernelError('not_found', `capability ${id} not found`);
    const strategy = options.strategies.find(
      (s) => s.id === capability.strategy.id && s.version === capability.strategy.version,
    );
    if (!strategy) throw new KernelError('misconfigured', `no strategy ${capability.strategy.id}`);
    return { capability, strategy };
  };

  const capabilityRef = (d: CapabilityDescriptor): Ref => ({
    kind: 'capability',
    id: d.id,
    tenant: d.tenant,
  });
  const taskRef = (t: Task): Ref => ({ kind: 'task', id: t.id, tenant: t.tenant });

  const availableTo = (d: CapabilityDescriptor, tenant: string) =>
    d.tenant === tenant ||
    d.availableTo === '*' ||
    (Array.isArray(d.availableTo) && d.availableTo.includes(tenant));

  const requireFeature = (l: Live, feature: Feature) => {
    if (!l.strategy.requires.features.includes(feature)) {
      throw new KernelError(
        'forbidden',
        `strategy ${l.strategy.id} did not declare feature ${feature}`,
      );
    }
  };

  const contentScope = (l: Live): ContentScope => ({
    tenant: l.task.tenant,
    key: l.task.thread
      ? JSON.stringify(['thread', principalKey(l.principal), l.task.thread])
      : JSON.stringify(['task', l.task.id]),
  });

  const stateScope = (l: Live, scope: StateScope): ContentScope =>
    scope === 'principal'
      ? { tenant: l.task.tenant, key: JSON.stringify(['principal', principalKey(l.principal)]) }
      : contentScope(l);

  const persist = (l: Live) =>
    store.put(
      {
        task: l.task,
        principal: l.principal,
        lastSeq: l.lastSeq,
        ...(l.checkpoint === undefined ? {} : { checkpoint: l.checkpoint }),
      },
      contentScope(l),
    );

  const emit = (l: Live, e: Emitted, actor: EventActor) => {
    const appended = l.chain.then(async () => {
      const stored = await log.append(
        {
          type: e.type,
          v: e.v ?? 1,
          task: l.task.id,
          ts: now().toISOString(),
          data: e.data,
          actor,
          ...(e.span ? { span: e.span } : {}),
          ...(e.fallback ? { fallback: e.fallback } : {}),
          ...(e.audience ? { audience: e.audience } : {}),
        },
        contentScope(l),
      );
      l.lastSeq = stored.seq;
      return stored;
    });
    l.chain = appended.catch(() => undefined);
    return appended;
  };

  const setStatus = async (l: Live, status: TaskStatus) => {
    await emit(l, { type: 'kernel.task.status', data: { status } }, 'kernel');
    l.task.status = status;
    if (isTerminal(status)) l.task.endedAt = now().toISOString();
    await persist(l);
    if (!isRunning(status)) live.delete(l.task.id);
    log.wake(l.task.id);
  };

  const abort = (l: Live, reason: KernelError) => {
    l.abortReason ??= reason;
    l.controller.abort(reason);
  };

  const outputLimit = (l: Live) => {
    const limits = [
      l.budget.headroom()?.outputTokens,
      l.maxOutputTokens === undefined
        ? undefined
        : l.maxOutputTokens - (l.task.usage.outputTokens ?? 0),
    ].filter((v): v is number => v !== undefined);
    return limits.length ? Math.min(...limits) : undefined;
  };

  const chargeLive = async (l: Live, usage: Usage, attribution: Record<string, unknown> = {}) => {
    let tripped: KernelError | undefined;
    try {
      l.budget.charge(usage);
    } catch (error) {
      if (!(error instanceof KernelError && error.code === 'budget_exceeded')) throw error;
      tripped = error;
    }
    l.task.usage = addUsage(l.task.usage, usage);
    await emit(
      l,
      { type: 'kernel.usage', data: { usage, ...attribution }, audience: 'audit' },
      'kernel',
    );
    if (tripped) throw tripped;
  };

  const recordResource = async (l: Live, resource: ResourceProvenance) => {
    const service = l.task.service;
    const added = <T>(known: T[] | undefined, item: T) =>
      known?.some((k) => stableStringify(k) === stableStringify(item))
        ? undefined
        : [...(known ?? []), item];
    if ('model' in resource) {
      const models = added(service.models, resource.model);
      if (!models) return;
      service.models = models;
    } else {
      const indexes = added(service.indexes, resource.index);
      if (!indexes) return;
      service.indexes = indexes;
    }
    await persist(l);
  };

  const fail = async (l: Live, error: Error) => {
    if (l.finished) return;
    l.finished = true;
    const code = error instanceof KernelError ? error.code : 'strategy_error';
    await emit(
      l,
      { type: 'kernel.error', data: { code, message: error.message }, audience: 'audit' },
      'kernel',
    );
    const clientMessage = error instanceof KernelError ? error.message : 'the service failed';
    await emit(l, { type: 'kernel.error', data: { code, message: clientMessage } }, 'kernel');
    await setStatus(l, 'failed');
    l.settle.reject(error);
  };

  const finishAborted = async (l: Live) => {
    const reason = l.abortReason ?? new KernelError('cancelled', 'task was cancelled');
    if (reason.code !== 'cancelled') return fail(l, reason);
    if (l.finished) return;
    l.finished = true;
    await setStatus(l, 'cancelled');
    l.settle.reject(reason);
  };

  const checkEmitted = (l: Live, e: Emitted) => {
    if (!strategyTypes.has(e.type) && !extensionType.test(e.type)) {
      throw new KernelError('invalid_event', `strategies may not emit ${e.type}`);
    }
    if (e.type === 'kernel.artifact')
      throw new KernelError('invalid_event', 'artifacts are not supported yet');
    if (e.type === 'kernel.result' && !Array.isArray(e.data)) {
      throw new KernelError('invalid_event', 'kernel.result must carry parts');
    }
    if (e.type === 'kernel.interrupt') {
      requireFeature(l, 'interrupts');
      const i = e.data as Partial<Interrupt> | null;
      if (
        !i ||
        typeof i.id !== 'string' ||
        typeof i.reason !== 'string' ||
        !Array.isArray(i.prompt)
      ) {
        throw new KernelError('invalid_event', 'kernel.interrupt needs id, reason and prompt');
      }
    }
  };

  const emitCounted = (l: Live, e: Emitted) => {
    l.eventCount += 1;
    if (l.eventCount > limits.maxEventsPerTask) {
      throw new KernelError(
        'limit_exceeded',
        `task emitted more than ${limits.maxEventsPerTask} events`,
      );
    }
    return emit(l, e, 'strategy');
  };

  const drive = async (l: Live, start: () => AsyncIterable<Emitted>) => {
    await setStatus(l, 'running');
    live.set(l.task.id, l);
    const deadlineMs = l.capability.deadlineMs;
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(
            () =>
              abort(l, new KernelError('deadline_exceeded', `deadline of ${deadlineMs} ms passed`)),
            deadlineMs,
          );
    let iterator: AsyncIterator<Emitted> | undefined;
    const deltas = new DeltaCoalescer(
      { ms: limits.deltaFlushMs, chars: limits.deltaFlushChars },
      async (e) => emitCounted(l, e),
      (error) =>
        abort(
          l,
          error instanceof KernelError
            ? error
            : new KernelError(
                'invalid_state',
                error instanceof Error ? error.message : String(error),
              ),
        ),
    );
    try {
      iterator = start()[Symbol.asyncIterator]();
      for (;;) {
        const next = await raceAbort(iterator.next(), l.controller.signal);
        if (next === aborted || next.done) break;
        checkEmitted(l, next.value);
        await deltas.push(next.value);
        if (next.value.type === 'kernel.result') l.task.result = next.value.data as Part[];
        if (next.value.type === 'kernel.interrupt') {
          const interrupt = next.value.data as Interrupt;
          l.task.pendingInterrupt = interrupt;
          l.finished = true;
          await setStatus(l, 'interrupted');
          l.settle.reject(new KernelError('interrupted', `task is waiting on ${interrupt.id}`));
          void iterator.return?.()?.catch(() => undefined);
          return;
        }
      }
      await deltas.flush();
      if (l.controller.signal.aborted) {
        void iterator.return?.()?.catch(() => undefined);
        return await finishAborted(l);
      }
      l.finished = true;
      await setStatus(l, 'completed');
      l.settle.resolve(l.task.result ?? []);
    } catch (error) {
      await deltas.flush().catch(() => undefined);
      if (l.controller.signal.aborted) {
        void iterator?.return?.()?.catch(() => undefined);
        return await finishAborted(l);
      }
      await fail(l, error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const runInBackground = (l: Live, start: () => AsyncIterable<Emitted>) => {
    drive(l, start).catch((error: unknown) => {
      l.settle.reject(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const clientOnly = async function* (events: AsyncIterable<Event>) {
    for await (const e of events) if (e.audience !== 'audit') yield e;
  };

  const runFor = (l: Live, fromSeq: number): Run => {
    const result = new Promise<Part[]>((resolve, reject) => {
      l.settle = { resolve, reject };
    });
    result.catch(() => undefined);
    return {
      task: l.task.id,
      events: clientOnly(log.read(l.task.id, fromSeq, () => isRunning(l.task.status))),
      result,
    };
  };

  const stateKey = (l: Live, scope: StateScope, key: string) => {
    const who = principalKey(l.principal);
    const owner =
      scope === 'task'
        ? [l.task.id]
        : scope === 'thread'
          ? [l.task.tenant, who, l.task.thread ?? `task:${l.task.id}`]
          : [who];
    return JSON.stringify([scope, ...owner, key]);
  };

  const contextFor = (l: Live): InvocationContext => {
    const budget: Budget = {
      remaining: () => l.budget.remaining(),
      charge: (usage) => chargeLive(l, usage),
    };
    return {
      principal: l.principal,
      capability: l.capability.descriptor,
      service: l.task.service,
      ...(l.responder === undefined ? {} : { responder: l.responder }),
      tenant: l.task.tenant,
      task: l.task.id,
      ...(l.task.thread === undefined ? {} : { thread: l.task.thread }),
      ...(l.entryPoint === undefined ? {} : { entryPoint: l.entryPoint }),
      signal: l.controller.signal,
      budget,
      state: {
        get: async <T>(scope: StateScope, key: string) => {
          const found = await state.get(stateKey(l, scope, key), stateScope(l, scope));
          return found as { v: number; value: T } | undefined;
        },
        put: (scope, key, value, expectV) =>
          state.put(stateKey(l, scope, key), value, stateScope(l, scope), expectV),
        checkpoint: async (value) => {
          requireFeature(l, 'checkpoint');
          l.checkpoint = value;
          await persist(l);
        },
      },
      use: async <P>(port: string, ref: Ref) => {
        if (!l.strategy.requires.ports.includes(port)) {
          throw new KernelError(
            'forbidden',
            `strategy ${l.strategy.id} did not declare port ${port}`,
          );
        }
        if (!l.capability.grants.some((g) => g.port === port && sameRef(g.ref, ref))) {
          throw new KernelError(
            'forbidden',
            `capability has no grant for ${port}:${ref.kind}/${ref.id}`,
          );
        }
        const decision = await options.policy.decide(l.principal, `use:${port}`, ref);
        if (!decision.allow) throw new KernelError('forbidden', decision.reason);
        const provider = options.ports[port];
        if (!provider) throw new KernelError('misconfigured', `no provider for port ${port}`);
        await emit(
          l,
          { type: 'kernel.resource.used', data: { port, ref }, audience: 'audit' },
          'kernel',
        );
        const portContext: PortContext = {
          tenant: l.task.tenant,
          principal: l.principal,
          task: l.task.id,
          signal: l.controller.signal,
          meter: (usage, model) => chargeLive(l, usage, { port, ref, ...(model ? { model } : {}) }),
          outputLimit: () => outputLimit(l),
          provenance: (resource) => recordResource(l, resource),
        };
        return provider.open(ref, portContext) as P;
      },
      invoke: async (capabilityId, input) => {
        requireFeature(l, 'subinvoke');
        return invoke(l.principal, capabilityId, input, {}, l);
      },
    };
  };

  async function invoke(
    principal: Principal,
    capabilityId: string,
    input: Input,
    invokeOptions: InvokeOptions = {},
    parent?: Live,
  ): Promise<Run> {
    const { capability, strategy } = capabilityById(capabilityId);
    const tenant = principal.tenant;
    if (!tenant) throw new KernelError('forbidden', 'principal acts for no tenant');
    if (!availableTo(capability.descriptor, tenant)) {
      throw new KernelError(
        'forbidden',
        `capability ${capabilityId} is not available to ${tenant}`,
      );
    }
    const decision = await options.policy.decide(
      principal,
      'invoke',
      capabilityRef(capability.descriptor),
    );
    if (!decision.allow) throw new KernelError('forbidden', decision.reason);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > limits.maxDepth)
      throw new KernelError('limit_exceeded', `invocation depth over ${limits.maxDepth}`);
    const running = [...live.values()].filter(
      (l) => l.task.tenant === tenant && isRunning(l.task.status),
    );
    if (running.length >= limits.maxConcurrentPerTenant) {
      throw new KernelError('limit_exceeded', `tenant ${tenant} has too many running tasks`);
    }

    const thread = invokeOptions.thread ?? parent?.task.thread;
    const configHash = await sha256(
      stableStringify({
        config: capability.config,
        grants: capability.grants,
        budget: capability.budget,
        deadlineMs: capability.deadlineMs,
      }),
    );
    const bounded: Capability = {
      ...capability,
      ...(invokeOptions.deadlineMs === undefined ? {} : { deadlineMs: invokeOptions.deadlineMs }),
      ...(invokeOptions.budget === undefined
        ? {}
        : { budget: tighter(capability.budget, invokeOptions.budget) }),
    };
    const controller = new AbortController();
    const l: Live = {
      task: {
        id: newId(),
        service: {
          capability: { id: capability.descriptor.id, version: capability.descriptor.version },
          strategy: { id: strategy.id, version: strategy.version },
          configHash,
        },
        principal: principalRef(principal),
        tenant,
        owner: capability.descriptor.tenant,
        ...(parent ? { parent: parent.task.id } : {}),
        ...(thread === undefined ? {} : { thread }),
        status: 'queued',
        artifacts: [],
        usage: {},
        createdAt: now().toISOString(),
      },
      principal,
      capability: bounded,
      strategy,
      controller,
      budget: new BudgetNode(bounded.budget, parent?.budget, (error) => abort(l, error)),
      ...(invokeOptions.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: invokeOptions.maxOutputTokens }),
      ...(invokeOptions.entryPoint === undefined ? {} : { entryPoint: invokeOptions.entryPoint }),
      lastSeq: -1,
      chain: Promise.resolve(),
      eventCount: 0,
      depth,
      finished: false,
      settle: { resolve: () => undefined, reject: () => undefined },
    };
    if (parent) {
      parent.controller.signal.addEventListener(
        'abort',
        () => abort(l, new KernelError('cancelled', 'parent task ended')),
        { once: true },
      );
      await emit(
        parent,
        {
          type: 'kernel.task.spawned',
          data: { child: l.task.id, capability: capability.descriptor.id },
          audience: 'audit',
        },
        'kernel',
      );
    }
    live.set(l.task.id, l);
    await persist(l);
    await emit(l, { type: 'kernel.task.status', data: { status: 'queued' } }, 'kernel');
    await emit(
      l,
      { type: 'kernel.task.input', data: { input }, audience: 'audit' },
      principalRef(principal),
    );
    await persist(l);

    const run = runFor(l, 0);
    runInBackground(l, () => strategy.run(contextFor(l), input, capability.config));
    return run;
  }

  const load = async (id: string): Promise<StoredTask> => {
    const running = live.get(id);
    if (running) {
      return {
        task: running.task,
        principal: running.principal,
        lastSeq: running.lastSeq,
        ...(running.checkpoint === undefined ? {} : { checkpoint: running.checkpoint }),
      };
    }
    const stored = await store.get(id);
    if (!stored) throw new KernelError('not_found', `task ${id} not found`);
    return stored;
  };

  const authorize = async (principal: Principal, id: string, action: PolicyAction) => {
    const stored = await load(id);
    const me = principalRef(principal);
    const isOwner = sameRef(stored.task.principal, me);
    const isAssignee = action === 'resume' && sameRef(stored.task.pendingInterrupt?.assignee, me);
    if (!isOwner && !isAssignee && principal.kind !== 'operator') {
      throw new KernelError('not_found', `task ${id} not found`);
    }
    const decision = await options.policy.decide(principal, action, taskRef(stored.task));
    if (!decision.allow) throw new KernelError('not_found', `task ${id} not found`);
    return stored;
  };

  const revive = (stored: StoredTask): Live => {
    const { capability, strategy } = capabilityById(stored.task.service.capability.id);
    const l: Live = {
      task: stored.task,
      principal: stored.principal,
      capability,
      strategy,
      controller: new AbortController(),
      budget: new BudgetNode(
        capability.budget,
        undefined,
        (error) => abort(l, error),
        stored.task.usage,
      ),
      ...(stored.checkpoint === undefined ? {} : { checkpoint: stored.checkpoint }),
      lastSeq: stored.lastSeq,
      chain: Promise.resolve(),
      eventCount: 0,
      depth: 0,
      finished: false,
      settle: { resolve: () => undefined, reject: () => undefined },
    };
    return l;
  };

  return {
    describe: async (principal) => {
      const visible: CapabilityDescriptor[] = [];
      for (const cap of capabilities()) {
        if (!principal.tenant || !availableTo(cap.descriptor, principal.tenant)) continue;
        const decision = await options.policy.decide(
          principal,
          'invoke',
          capabilityRef(cap.descriptor),
        );
        if (decision.allow) visible.push(cap.descriptor);
      }
      return visible;
    },

    invoke: (principal, capabilityId, input, invokeOptions) =>
      invoke(principal, capabilityId, input, invokeOptions),

    resume: async (principal, taskId, interruptId, response) => {
      const stored = await authorize(principal, taskId, 'resume');
      const pending = stored.task.pendingInterrupt;
      if (stored.task.status !== 'interrupted' || pending?.id !== interruptId) {
        throw new KernelError('invalid_state', `task ${taskId} is not waiting on ${interruptId}`);
      }
      if (pending.expiresAt && Date.parse(pending.expiresAt) < now().getTime()) {
        throw new KernelError('invalid_state', `interrupt ${interruptId} has expired`);
      }
      const l = revive(stored);
      if (!l.strategy.resume)
        throw new KernelError('invalid_state', `strategy ${l.strategy.id} cannot resume`);
      const resumeStrategy = l.strategy.resume.bind(l.strategy);
      delete l.task.pendingInterrupt;
      l.responder = principal;
      await emit(
        l,
        {
          type: 'kernel.interrupt.resolved',
          data: { interrupt: interruptId, responder: principalRef(principal), response },
          audience: 'audit',
        },
        principalRef(principal),
      );
      const run = runFor(l, l.lastSeq + 1);
      runInBackground(l, () =>
        resumeStrategy(contextFor(l), l.checkpoint, response, l.capability.config),
      );
      return run;
    },

    cancel: async (principal, taskId) => {
      const stored = await authorize(principal, taskId, 'cancel');
      const running = live.get(taskId);
      if (running) return abort(running, new KernelError('cancelled', 'task was cancelled'));
      if (stored.task.status !== 'interrupted') return;
      const l = revive(stored);
      l.finished = true;
      await setStatus(l, 'cancelled');
    },

    task: async (principal, taskId) =>
      structuredClone((await authorize(principal, taskId, 'read')).task),

    events: async (principal, taskId, eventsOptions = {}) => {
      const audit = eventsOptions.audience === 'audit';
      await authorize(principal, taskId, audit ? 'read-audit' : 'read');
      const events = log.read(taskId, eventsOptions.fromSeq ?? 0, () => {
        const running = live.get(taskId);
        return running !== undefined && isRunning(running.task.status);
      });
      return audit ? events : clientOnly(events);
    },

    annotate: async (principal, taskId, annotation) => {
      const stored = await load(taskId);
      const decision = await options.policy.decide(principal, 'annotate', taskRef(stored.task));
      if (!decision.allow) throw new KernelError('not_found', `task ${taskId} not found`);
      const l = live.get(taskId) ?? revive(stored);
      await emit(
        l,
        { type: annotation.type, data: annotation.data, audience: 'audit' },
        principalRef(principal),
      );
      if (!live.has(taskId)) await persist(l);
    },

    pending: async (principal) => {
      const me = principalRef(principal);
      return store.pendingFor(me);
    },
  };
};
