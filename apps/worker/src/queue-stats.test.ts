import type { QueueBacklog } from '@genai/jobs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logQueueStats, startQueueStats } from './queue-stats.js';

const now = new Date('2026-11-19T10:00:00Z');

const source = (server: string, backlog: QueueBacklog[]) => ({
  server,
  jobs: { backlog: async () => backlog },
});

describe('queue stats', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the oldest waiting job across both servers, with every queue that has jobs waiting', async () => {
    const lines: [string, Record<string, unknown> | undefined][] = [];
    await logQueueStats(
      [
        source('platform', [{ queue: 'usage-gateway-poll', queued: 2, oldestQueuedSeconds: 120 }]),
        source('knowledge', [{ queue: 'knowledge.embed', queued: 40, oldestQueuedSeconds: 2400 }]),
      ],
      (msg, extra) => lines.push([msg, extra]),
      now,
    );
    expect(lines).toEqual([
      [
        'queue stats',
        {
          oldestQueuedSeconds: 2400,
          queues: [
            {
              server: 'platform',
              queue: 'usage-gateway-poll',
              queued: 2,
              oldestQueuedSeconds: 120,
            },
            {
              server: 'knowledge',
              queue: 'knowledge.embed',
              queued: 40,
              oldestQueuedSeconds: 2400,
            },
          ],
        },
      ],
    ]);
  });

  it('logs zero when nothing waits or a queue cannot report its backlog', async () => {
    const lines: unknown[] = [];
    await logQueueStats(
      [source('platform', []), { server: 'memory', jobs: {} }],
      (msg, extra) => lines.push([msg, extra]),
      now,
    );
    expect(lines).toEqual([['queue stats', { oldestQueuedSeconds: 0, queues: [] }]]);
  });

  it('logs every 5 minutes, and a failed read as its own line', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const failing = {
      server: 'platform',
      jobs: {
        backlog: async () => {
          throw new Error('connection terminated');
        },
      },
    };
    const stats = startQueueStats(
      () => [failing],
      (msg) => lines.push(msg),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual(['queue stats failed']);
    stats.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lines).toHaveLength(1);
  });
});
