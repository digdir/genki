import { describe, expect, it } from 'vitest';
import { call, chunk, readSignal, result, retrieval, run } from './harness.test-utils.js';

describe('the read notice', () => {
  it('a read notice names the document, position and page of each chunk and what the read asked for', async () => {
    const out = await run({
      retrieval: retrieval(
        {},
        new Map([
          ['c1', chunk(1, { document: 'd1', position: 0, page: 67 })],
          ['c2', chunk(2, { document: 'd1', position: 1 })],
        ]),
      ).impl,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['omorganiseringer'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('support-found')],
        },
      },
    });

    const read = out.notices.find((n) => n.kind === 'read' && !n.auto);
    expect(read).toMatchObject({
      chunks: [
        { id: 'c1', document: 'd1', position: 0, page: 67 },
        { id: 'c2', document: 'd1', position: 1 },
      ],
      request: { chunkIds: ['c1', 'c2'] },
    });
  });
});
