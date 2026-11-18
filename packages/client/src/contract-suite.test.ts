import { describe, expect, it } from 'vitest';
import { createClient } from './client.js';
import { frontendContract } from './contract-suite.js';

const citations = frontendContract.checks.find((c) => c.name.includes('every [N]'));

const answering = (body: Record<string, unknown>) => {
  if (!citations) throw new Error('the suite has no check of [N]');
  const client = createClient({
    baseUrl: 'http://api',
    fetch: (async () => Response.json({ id: 'c', ...body })) as typeof fetch,
  });
  return citations.run({ client, service: 's', question: 'q' }, new AbortController().signal);
};

const text = (content: string) => ({ choices: [{ message: { content } }] });

const source = (index: number, documentId: string | undefined, ...chunkIds: string[]) => ({
  index,
  title: `Dokument ${index}`,
  ...(documentId === undefined ? {} : { document_id: documentId }),
  excerpts: chunkIds.map((chunkId) => ({ chunk_id: chunkId, text: 'Utdrag' })),
});

const marker = (n: number, chunkId: string, documentId: string) => ({
  marker: String(n),
  chunk_id: chunkId,
  document: documentId,
});

describe('the frontend contract on [N]', () => {
  it('checks each [N] through the markers when the answer cites excerpts', async () => {
    // [2] is a second excerpt of the first document, so no source has index 2.
    await expect(
      answering({
        ...text('Første [1], andre [2] og tredje [3].'),
        sources: [source(1, 'd1', 'c1', 'c2'), source(3, 'd2', 'c3')],
        markers: [marker(1, 'c1', 'd1'), marker(2, 'c2', 'd1'), marker(3, 'c3', 'd2')],
      }),
    ).resolves.toBeUndefined();
  });

  it('leads a marker to its excerpt by chunk id, also in a source without a document id', async () => {
    // genki names a chunk without a document by its chunk id, and its source has no `document_id`.
    await expect(
      answering({
        ...text('Første [1], andre [2] og tredje [3].'),
        sources: [source(1, 'd1', 'c1', 'c2'), source(3, undefined, 'c3')],
        markers: [marker(1, 'c1', 'd1'), marker(2, 'c2', 'd1'), marker(3, 'c3', 'c3')],
      }),
    ).resolves.toBeUndefined();
  });

  it('fails an [N] the markers do not list, even when a source has index N', async () => {
    await expect(
      answering({
        ...text('Første [1] og andre [2].'),
        sources: [source(1, 'd1', 'c1'), source(2, 'd2', 'c2')],
        markers: [marker(1, 'c1', 'd1')],
      }),
    ).rejects.toThrow("[2] is not in the answer's markers");
  });

  it('fails a marker that leads to an excerpt no source has', async () => {
    await expect(
      answering({
        ...text('Første [1] og andre [2].'),
        sources: [source(1, 'd1', 'c1'), source(2, 'd2', 'c2')],
        markers: [marker(1, 'c1', 'd1'), marker(2, 'c9', 'd2')],
      }),
    ).rejects.toThrow('[2] leads to excerpt c9, which no source has');
  });

  it('checks each [N] by the source with index N when the answer has no markers', async () => {
    const cited = text('Første [1] og andre [2].');
    await expect(
      answering({ ...cited, sources: [source(1, 'd1', 'c1'), source(2, 'd2', 'c2')] }),
    ).resolves.toBeUndefined();
    await expect(answering({ ...cited, sources: [source(1, 'd1', 'c1')] })).rejects.toThrow(
      '[2] has no source with index 2',
    );
  });
});
