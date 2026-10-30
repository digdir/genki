import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  knowledgeRuntimeInput,
  startHealthServer,
  watchKnowledgeBinding,
  type KnowledgeBindingWatch,
} from './knowledge-binding.js';

const platform = '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const production = '0b8e2f61-5c3d-4e7a-9b1c-2d3e4f5a6b7c';

let watch: KnowledgeBindingWatch | undefined;
let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;

afterEach(async () => {
  watch?.stop();
  await server?.close();
  server = undefined;
  vi.useRealTimers();
});

const readiness = async (ready: () => boolean) => {
  server ??= await startHealthServer({ port: 0, ready });
  return (await fetch(`${server.url}/readyz`)).status;
};

describe('the knowledge server binding', () => {
  it('the worker runs no knowledge job, fails readiness and reports it when the knowledge server is bound to another platform server', async () => {
    const log = vi.fn();
    watch = watchKnowledgeBinding({
      platformId: async () => platform,
      boundTo: async () => production,
      log,
    });
    await watch.start();
    expect(() => watch?.knowledgeBound()).toThrow(
      `the knowledge server is bound to platform server ${production}, not ${platform}`,
    );
    expect(await readiness(() => watch?.ready() ?? false)).toBe(503);
    expect(log).toHaveBeenCalledWith('knowledge server bound to another platform server', {
      level: 'error',
      platform,
      boundTo: production,
    });
  });

  it('a worker without a knowledge server is ready and its gate refuses knowledge jobs', async () => {
    watch = watchKnowledgeBinding({ platformId: async () => platform, log: vi.fn() });
    await watch.start();
    expect(watch.ready()).toBe(true);
    expect(await readiness(() => watch?.ready() ?? false)).toBe(200);
    expect(() => watch?.knowledgeBound()).toThrow('no knowledge server configured');
  });

  it('a worker becomes ready within a minute of its binding being fixed or its server coming up', async () => {
    vi.useFakeTimers();
    const answers: (() => Promise<string | undefined>)[] = [
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      async () => production,
      async () => platform,
    ];
    const boundTo = vi.fn(async () => (answers.shift() ?? (async () => platform))());
    const log = vi.fn();
    watch = watchKnowledgeBinding({ platformId: async () => platform, boundTo, log });

    await watch.start();
    expect(watch.ready()).toBe(false);
    expect(log).toHaveBeenCalledWith('knowledge server unreachable', {
      level: 'error',
      error: 'Error: connect ECONNREFUSED',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watch.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watch.ready()).toBe(true);
    expect(() => watch?.knowledgeBound()).not.toThrow();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(boundTo).toHaveBeenCalledTimes(3);
  });

  it('fails to start the health server with the port it could not take', async () => {
    server = await startHealthServer({ port: 0, ready: () => true });
    const port = Number(new URL(server.url).port);
    await expect(startHealthServer({ port, ready: () => true })).rejects.toThrow(
      `WORKER_HEALTH_PORT ${port} is taken`,
    );
  });

  it("the worker's knowledge writes are guarded by its binding", async () => {
    watch = watchKnowledgeBinding({
      platformId: async () => platform,
      boundTo: async () => production,
      log: vi.fn(),
    });
    await watch.start();
    const pools = { writer: {}, owner: {} } as never;
    const input = knowledgeRuntimeInput({ pools }, watch);
    expect(input.knowledgeServer).toBe(pools);
    expect(() => input.knowledgeGuard?.()).toThrow('bound to platform server');
    expect(knowledgeRuntimeInput(undefined, watch)).toEqual({});
  });
});
