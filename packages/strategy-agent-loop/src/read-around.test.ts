import { describe, expect, it } from 'vitest';
import {
  call,
  chunk,
  readSignal,
  result,
  retrieval,
  run,
  toolMessages,
} from './harness.test-utils.js';
import type { AgentRetrieval, PartsAround } from './workspace.js';

/** Pages 4 to 6 of a report whose printed page labels run two ahead, and a table from page 3, which has no label. */
const around: PartsAround = {
  parts: [
    { seq: 5, text: '| kai | meter |', regions: [{ unit: 3 }, { unit: 4 }] },
    { seq: 7, text: 'Etter tabellen kommer merknadene.', regions: [{ unit: 4 }] },
    { seq: 8, text: 'Funn', regions: [{ unit: 5 }] },
    { seq: 9, text: 'Første funn om fartøy.', regions: [{ unit: 5 }] },
    { seq: 12, text: 'Tredje funn om fortøyning.', regions: [{ unit: 6 }] },
  ],
  units: [
    { unit: 3, label: null },
    { unit: 4, label: '6' },
    { unit: 5, label: '7' },
    { unit: 6, label: '8' },
  ],
  cut: false,
};

const store = () =>
  new Map([
    ['c1', chunk(1, { page: 5, content: 'Første funn om fartøy.' })],
    ['c2', chunk(2)],
  ]);

const readAround = (
  readParts: AgentRetrieval['readParts'],
  args: Record<string, unknown> = { around: { chunk_id: 'c1', read: 'units', n: 1 } },
) => {
  const fake = retrieval(readParts ? { readParts } : {}, store());
  return {
    calls: fake.calls,
    out: run({
      retrieval: fake.impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['funn'] })]),
            () => result('', [call('read_chunks', args)]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('support-found')],
        },
      },
    }),
  };
};

describe('read_chunks around a hit', () => {
  it('read_chunks around a hit returns the pages before and after it', async () => {
    const asked: unknown[] = [];
    const { out } = readAround(async (chunkId, read, n, budget) => {
      asked.push({ chunkId, read, n, budget });
      return around;
    });
    const text = toolMessages((await out).loops[2])[1] ?? '';

    expect(asked).toEqual([{ chunkId: 'c1', read: 'units', n: 1, budget: expect.any(Number) }]);
    // Each run of parts is headed by the page it starts on: its printed label, else its number.
    const pages = [...text.matchAll(/^--- page=(\S+) ---$/gm)].map((m) => m[1]);
    expect(pages).toEqual(['3', '6', '7', '8']);
    expect(text).toContain('--- page=3 ---\n| kai | meter |\n\n--- page=6 ---\nEtter tabellen');
    expect(text).toContain('--- page=7 ---\nFunn\n\nFørste funn om fartøy.\n\n--- page=8 ---');
    expect(text).toContain('--- page=8 ---\nTredje funn om fortøyning.');
    expect(text).toMatch(/chunk_id=c1 doc_num=d1/);
  });

  it('a read around a hit keeps the text within max_content_length and says it was cut', async () => {
    const asked: number[] = [];
    const { out } = readAround(
      async (_c, _r, _n, budget) => {
        asked.push(budget);
        return { ...around, parts: around.parts.slice(0, 2), cut: true };
      },
      { around: { chunk_id: 'c1', read: 'neighbours', n: 5 }, max_content_length: 60 },
    );
    const text = toolMessages((await out).loops[2])[1] ?? '';
    expect(asked).toEqual([60]);
    expect(text).toMatch(/cut at the read's limit/);
  });

  it("read_chunks keeps today's tool for a dataset that cannot read parts", async () => {
    const without = await readAround(undefined).out;
    const spec = (o: typeof without) =>
      JSON.stringify(o.loops[0]?.tools?.find((t) => t.name === 'read_chunks')?.parameters);
    expect(spec(without)).not.toContain('around');
    expect(toolMessages(without.loops[2])[1]).toMatch(/cannot read around a hit/);

    const withParts = await readAround(async () => around).out;
    expect(spec(withParts)).toContain('around');
  });
});
