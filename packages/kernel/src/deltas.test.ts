import { describe, expect, it } from 'vitest';
import { DeltaCoalescer } from './deltas.js';
import type { Emitted } from './spi.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('delta coalescing', () => {
  it('keeps merging text when each write takes longer than the window, so a slow store cannot turn every token into an event', async () => {
    const written: string[] = [];
    const coalescer = new DeltaCoalescer(
      { ms: 20, chars: 10_000 },
      async (e: Emitted) => {
        written.push((e.data as { text: string }).text);
        await sleep(30);
      },
      () => undefined,
    );

    for (let i = 0; i < 300; i += 1)
      await coalescer.push({ type: 'kernel.part.delta', data: { text: 'x' } });
    await coalescer.flush();

    expect(written.join('')).toBe('x'.repeat(300));
    expect(written.length).toBeLessThan(10);
  });
});
