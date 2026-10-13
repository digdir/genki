import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Input, Principal } from '@genai/contracts';
import type { InvokeOptions, Kernel, Run } from '@genai/kernel';
import { InMemoryBlobStore, observable } from '@genai/port-blob';
import {
  lifecycleBlock,
  InMemoryQueue,
  TriggerRunner,
  systemPrincipal,
  triggerBindings,
  type Clock,
  type TriggerBinding,
  type TriggerRun,
  monthlyQuotaGate,
} from './index.js';
import { publishedStore, tenant } from './kit.test-utils.js';

afterEach(() => {
  vi.useRealTimers();
});

const fakeKernel = (fail: (input: Input) => boolean = () => false) => {
  const calls: {
    principal: Principal;
    capability: string;
    input: Input;
    options?: InvokeOptions;
  }[] = [];
  const kernel = {
    invoke: async (
      principal: Principal,
      capability: string,
      input: Input,
      options?: InvokeOptions,
    ): Promise<Run> => {
      calls.push({ principal, capability, input, ...(options ? { options } : {}) });
      const failed = fail(input);
      return {
        task: `t${calls.length}`,
        events: (async function* () {})(),
        result: failed ? Promise.reject(new Error('the service failed')) : Promise.resolve([]),
      };
    },
  } as unknown as Kernel;
  return { kernel, calls };
};

const binding = (trigger: TriggerBinding['trigger']): TriggerBinding => ({
  tenant,
  service: 'klarsprak',
  capability: `${tenant}/klarsprak/default`,
  trigger,
});

describe('trigger bindings', () => {
  it('reads each published service trigger and points it at the default variant', async () => {
    const bindings = await triggerBindings(await publishedStore());

    expect(bindings).toEqual([
      binding({ kind: 'document-arrives', folder: 'klarsprak/innboks' }),
      {
        tenant,
        service: 'nynorsk',
        capability: `${tenant}/nynorsk/default`,
        trigger: { kind: 'queue-message', queue: 'nynorsk' },
      },
    ]);
  });
});

describe('trigger runner', () => {
  it('starts a scheduled capability as the agency system user and arms the next run', async () => {
    const { kernel, calls } = fakeKernel();
    const timers: { at: Date; run: () => void }[] = [];
    const clock: Clock = {
      now: () => new Date('2026-10-06T05:00:00Z'),
      setTimer: (at, run) => {
        timers.push({ at, run });
        return () => undefined;
      },
    };
    const runs: TriggerRun[] = [];
    const runner = new TriggerRunner({ kernel, clock, onRun: (r) => runs.push(r) });

    runner.start([binding({ kind: 'schedule', cron: '0 8 * * 1-5' })]);
    timers[0]?.run();
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(timers[0]?.at.toISOString()).toBe('2026-10-06T06:00:00.000Z');
    expect(calls[0]?.principal).toEqual(systemPrincipal()(tenant));
    expect(calls[0]?.input.data).toEqual({
      trigger: 'schedule',
      firedAt: '2026-10-06T06:00:00.000Z',
    });
    expect(timers).toHaveLength(2);
    runner.stop();
  });

  it('reconciles bindings: keeps unchanged, stops removed, never double-starts', async () => {
    const { kernel, calls } = fakeKernel();
    const queue = new InMemoryQueue(2);
    const runner = new TriggerRunner({ kernel, queue });
    const a = binding({ kind: 'queue-message', queue: 'a' });
    const b = binding({ kind: 'queue-message', queue: 'b' });

    expect(runner.reconcile([a])).toMatchObject({ started: 1, stopped: 0, kept: 0 });
    expect(runner.reconcile([a, b])).toMatchObject({ started: 1, stopped: 0, kept: 1 });
    expect(runner.reconcile([a, b])).toMatchObject({ started: 0, stopped: 0, kept: 2 });
    await queue.send(`${tenant}:a`, 'x');
    expect(calls).toHaveLength(1);

    expect(runner.reconcile([b])).toMatchObject({ started: 0, stopped: 1, kept: 1 });
    await queue.send(`${tenant}:a`, 'y');
    expect(calls).toHaveLength(1);

    expect(runner.reconcile([{ ...b, capability: 'other' }])).toMatchObject({
      started: 1,
      stopped: 1,
    });
    await queue.send(`${tenant}:b`, 'z');
    expect(calls.map((c) => c.capability)).toEqual([a.capability, 'other']);
    runner.stop();
  });

  it('reports a binding that cannot start without stopping the others', () => {
    const { kernel } = fakeKernel();
    const runner = new TriggerRunner({ kernel });
    const result = runner.reconcile([
      binding({ kind: 'queue-message', queue: 'a' }),
      binding({ kind: 'schedule', cron: '0 8 * * *' }),
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.started).toBe(1);
    runner.stop();
  });

  it('starts a capability per queue message and dead-letters a message that keeps failing', async () => {
    const { kernel, calls } = fakeKernel(
      (input) => (input.data as { message?: unknown }).message === 'feil',
    );
    const queue = new InMemoryQueue(2);
    const runner = new TriggerRunner({ kernel, queue });
    runner.start([binding({ kind: 'queue-message', queue: 'nynorsk' })]);

    await queue.send(`${tenant}:nynorsk`, 'Hvis du ikke rekker fristen');
    await queue.send(`${tenant}:nynorsk`, 'feil');

    expect(calls.map((c) => c.input.parts?.[0]?.body)).toEqual([
      { kind: 'text', text: 'Hvis du ikke rekker fristen' },
      { kind: 'text', text: 'feil' },
      { kind: 'text', text: 'feil' },
    ]);
    expect(queue.deadLetters.map((d) => d.message.body)).toEqual(['feil']);
    expect(queue.pending(`${tenant}:nynorsk`)).toBe(0);
    runner.stop();
  });

  it('leaves a paused trigger alone and starts it again once it is resumed', async () => {
    const { kernel, calls } = fakeKernel();
    const queue = new InMemoryQueue(1);
    let paused = true;
    const runner = new TriggerRunner({ kernel, queue, paused: () => paused });
    runner.start([binding({ kind: 'queue-message', queue: 'nynorsk' })]);

    await queue.send(`${tenant}:nynorsk`, 'Mens den står på pause');
    paused = false;
    await queue.send(`${tenant}:nynorsk`, 'Etter pausen');

    expect(calls.map((c) => (c.input.data as { message?: unknown }).message)).toEqual([
      'Etter pausen',
    ]);
    runner.stop();
  });

  it('refuses to run a trigger of a paused or archived service, recording the service problem code', async () => {
    const { kernel, calls } = fakeKernel();
    const queue = new InMemoryQueue(1);
    const recorded: { outcome: string; code?: string; error?: string }[] = [];
    let state: { state: string } = { state: 'paused' };
    const history = async () => [{ spec: state, deleted: false, reason: 'Venter på ny modell' }];
    const runner = new TriggerRunner({
      kernel,
      queue,
      onRun: (run) => recorded.push(run),
      blocked: (b) => lifecycleBlock(history, b),
    });
    runner.start([binding({ kind: 'queue-message', queue: 'nynorsk' })]);

    await queue.send(`${tenant}:nynorsk`, 'Mens den er på pause');
    state = { state: 'archived' };
    await queue.send(`${tenant}:nynorsk`, 'Mens den er arkivert');
    state = { state: 'active' };
    await queue.send(`${tenant}:nynorsk`, 'Når den er tatt i bruk igjen');

    expect(recorded.slice(0, 2)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        code: 'service_paused',
        error: 'Tjenesten er satt på pause. Begrunnelse: Venter på ny modell',
      }),
      expect.objectContaining({ outcome: 'failed', code: 'service_archived' }),
    ]);
    expect(calls.map((c) => (c.input.data as { message?: unknown }).message)).toEqual([
      'Når den er tatt i bruk igjen',
    ]);
    runner.stop();
  });

  it('starts a capability when a document arrives in its folder, with the text as input', async () => {
    const { kernel, calls } = fakeKernel();
    const blobs = observable(new InMemoryBlobStore());
    const runner = new TriggerRunner({ kernel, blob: blobs });
    runner.start([binding({ kind: 'document-arrives', folder: 'klarsprak/innboks' })]);

    await blobs.put(
      { tenant, path: 'klarsprak/innboks/brev.txt' },
      new TextEncoder().encode('Det vises til Deres søknad.'),
      'text/plain',
    );
    await blobs.put(
      { tenant, path: 'klarsprak/utboks/svar.txt' },
      new TextEncoder().encode('x'),
      'text/plain',
    );
    await blobs.put(
      { tenant: '889640782', path: 'klarsprak/innboks/annen.txt' },
      new TextEncoder().encode('x'),
      'text/plain',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'Det vises til Deres søknad.' } }],
      data: { trigger: 'document-arrives', path: 'klarsprak/innboks/brev.txt' },
    });
    runner.stop();
  });

  it('finds documents written behind its back by polling the folder', async () => {
    vi.useFakeTimers();
    const { kernel, calls } = fakeKernel();
    const blobs = new InMemoryBlobStore();
    const runner = new TriggerRunner({ kernel, blob: blobs, pollIntervalMs: 1000 });
    runner.start([binding({ kind: 'document-arrives', folder: 'klarsprak/innboks' })]);

    await blobs.put(
      { tenant, path: 'klarsprak/innboks/brev.txt' },
      new TextEncoder().encode('Hei'),
      'text/plain',
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(1);
    runner.stop();
  });
});

describe('triggered runs within the monthly token quota', () => {
  it('does not start a triggered run when the month is used up, and records why', async () => {
    const { kernel, calls } = fakeKernel();
    const queue = new InMemoryQueue();
    const runs: TriggerRun[] = [];
    const runner = new TriggerRunner({
      kernel,
      queue,
      onRun: (r) => runs.push(r),
      admit: monthlyQuotaGate({ monthlyTokens: () => 1000, usedTokens: async () => 1000 }),
    });
    runner.start([binding({ kind: 'queue-message', queue: 'nynorsk' })]);

    await queue.send(`${tenant}:nynorsk`, 'Hvis du ikke rekker fristen');

    expect(calls).toHaveLength(0);
    expect(runs).toEqual([expect.objectContaining({ outcome: 'failed', code: 'quota_exhausted' })]);
    runner.stop();
  });

  it('gives a triggered run what is left of the month as its budget, and records its tokens and cost', async () => {
    const { kernel, calls } = fakeKernel();
    const queue = new InMemoryQueue();
    const runs: TriggerRun[] = [];
    const runner = new TriggerRunner({
      kernel,
      queue,
      onRun: (r) => runs.push(r),
      admit: monthlyQuotaGate({ monthlyTokens: () => 1000, usedTokens: async () => 400 }),
      meter: async () => ({ usage: { inputTokens: 300, outputTokens: 50 }, costMicroNok: 4500 }),
    });
    runner.start([binding({ kind: 'queue-message', queue: 'nynorsk' })]);

    await queue.send(`${tenant}:nynorsk`, 'Hvis du ikke rekker fristen');
    await vi.waitFor(() => expect(runs).toHaveLength(1));

    expect(calls[0]?.options).toEqual({ budget: { inputTokens: 600, outputTokens: 600 } });
    expect(runs[0]).toMatchObject({
      outcome: 'completed',
      usage: { inputTokens: 300, outputTokens: 50 },
      costMicroNok: 4500,
    });
    runner.stop();
  });
});
