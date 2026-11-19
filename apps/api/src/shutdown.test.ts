import { describe, expect, it, vi } from 'vitest';
import { textPart, type Principal } from '@genai/contracts';
import { createKernel, type Strategy } from '@genai/kernel';
import { drainBeforeExit } from './shutdown.js';

const kari: Principal = {
  kind: 'employee',
  issuer: 'ansattporten',
  subject: 'kari',
  tenant: '999888777',
};

const kernelRunning = (run: Strategy['run']) =>
  createKernel({
    strategies: [
      { id: 'waits', version: '1', requires: { kernel: 1, ports: [], features: [] }, run },
    ],
    capabilities: [
      {
        descriptor: {
          id: 'ka',
          version: '1',
          tenant: '999888777',
          title: 'ka',
          description: 'ka',
          input: {},
          interaction: ['stream'],
          accepts: ['text/plain'],
          produces: ['text/plain'],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI-generert' },
        },
        strategy: { id: 'waits', version: '1' },
        config: {},
        grants: [],
      },
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
    now: () => new Date('2026-11-18T10:00:00Z'),
  });

const noCases = { drain: () => Promise.resolve() };

describe('stopping the API', () => {
  it('the API waits for running service runs before it exits on SIGTERM', async () => {
    let open: () => void = () => undefined;
    const kernel = kernelRunning(async function* () {
      await new Promise<void>((resolve) => (open = resolve));
      yield { type: 'kernel.result', data: [textPart('ferdig')] };
    });
    const run = await kernel.invoke(kari, 'ka', {});
    let exited = false;

    const stopping = drainBeforeExit(kernel, noCases, 60_000).then(() => (exited = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(false);
    open();
    await stopping;

    expect(await run.result).toEqual([textPart('ferdig')]);
    expect(exited).toBe(true);
  });

  it('the API exits at the grace period when a service run does not end', async () => {
    vi.useFakeTimers();
    try {
      const kernel = kernelRunning(async function* () {
        await new Promise<never>(() => undefined);
        yield* [];
      });
      await kernel.invoke(kari, 'ka', {});
      let exited = false;

      const stopping = drainBeforeExit(kernel, noCases, 60_000).then(() => (exited = true));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(exited).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;

      expect(exited).toBe(true);
      expect(kernel.running()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the API accepts no new run once it has begun to stop', async () => {
    const kernel = kernelRunning(async function* () {
      yield { type: 'kernel.result', data: [textPart('ok')] };
    });

    await drainBeforeExit(kernel, noCases, 1_000);

    await expect(kernel.invoke(kari, 'ka', {})).rejects.toMatchObject({ code: 'server_stopped' });
  });
});
