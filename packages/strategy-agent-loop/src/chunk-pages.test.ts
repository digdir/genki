import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  chunk,
  readSignal,
  result,
  retrieval,
  run,
  toolMessages,
} from './harness.test-utils.js';

const store = () =>
  new Map([
    ['c1', chunk(1, { page: 67 })],
    ['c2', chunk(2, { page: 95, pageEnd: 98 })],
    ['c3', chunk(3)],
    ['c4', chunk(4, { document: 'd1', position: 1, page: 68, content: 'Neste side.' })],
    ['c5', chunk(5, { page: 40, pageEnd: 40 })],
  ]);

const searchLine = (text: string, id: string) =>
  text.split('\n').find((l) => l.includes(` chunk_id=${id} `)) ?? '';

const readHeader = (text: string, id: string) =>
  text.split('\n').find((l) => l.startsWith(`--- chunk_id=${id} `)) ?? '';

const searchThenRead = (ids: string[]) =>
  run({
    retrieval: retrieval({}, store()).impl,
    scripts: {
      primary: {
        loop: [
          () => result('', [call('search', { queries: ['omorganiseringer'] })]),
          () => result('', [call('read_chunks', { chunk_ids: ids })]),
          () => result('Ferdig.'),
        ],
        read: [() => readSignal('support-found')],
      },
    },
  });

describe('the page the agent sees for each chunk', () => {
  it("a search result line shows the chunk's page", async () => {
    const out = await searchThenRead(['c1']);

    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(searchLine(text, 'c1')).toMatch(/ chunk_index=0\/20 page=67 /);
    expect(searchLine(text, 'c2')).toMatch(/ chunk_index=0\/20 pages=95-98 /);
    expect(searchLine(text, 'c5')).toMatch(/ chunk_index=0\/20 page=40 /);
  });

  it("a read result shows each chunk's page, and its last page when it spans several", async () => {
    const out = await searchThenRead(['c1', 'c2']);

    const text = toolMessages(out.loops[2])[1] ?? '';
    expect(readHeader(text, 'c1')).toMatch(/ chunk_index=0 page=67 /);
    expect(readHeader(text, 'c2')).toMatch(/ chunk_index=0 pages=95-98 /);
  });

  it('a chunk without a page shows no page field', async () => {
    const out = await searchThenRead(['c3']);

    const search = searchLine(toolMessages(out.loops[1])[0] ?? '', 'c3');
    const read = readHeader(toolMessages(out.loops[2])[1] ?? '', 'c3');
    expect(search).not.toBe('');
    expect(read).not.toBe('');
    expect(search).not.toMatch(/\bpages?=/);
    expect(read).not.toMatch(/\bpages?=/);
  });

  it("the sources generate_response writes from show each chunk's page", async () => {
    const generated = async (citeBy: 'document' | 'excerpt') => {
      const out = await run({
        retrieval: retrieval({}, store()).impl,
        config: { ...baseConfig, strategy: { ...baseConfig.strategy, citeBy } },
        scripts: {
          primary: {
            loop: [
              () => result('', [call('search', { queries: ['omorganiseringer'] })]),
              () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c4', 'c2', 'c3'] })]),
              () => result('', [call('generate_response', { query: 'omorganiseringer' })]),
              () => result('Ferdig.'),
            ],
            read: [() => readSignal('support-found')],
          },
        },
      });
      const synth = out.seen.filter((s) => s.kind === 'synth').at(-1);
      return String(synth?.request.messages.at(-1)?.content);
    };

    const excerpts = await generated('excerpt');
    expect(excerpts).toMatch(
      /<untrusted_data kind="source" id="d1" title="Rapport 1" page="67">\nInnhold i chunk 1\./,
    );
    expect(excerpts).toMatch(
      /<untrusted_data kind="source" id="d1" title="Rapport 4" page="68">\nNeste side\./,
    );
    expect(excerpts).toMatch(
      /<untrusted_data kind="source" id="d2" title="Rapport 2" pages="95-98">\n/,
    );
    expect(excerpts).toMatch(/<untrusted_data kind="source" id="d3" title="Rapport 3">\n/);

    const documents = await generated('document');
    expect(documents).toContain(
      '<untrusted_data kind="source" id="d1" title="Rapport 1">\n--- page=67 ---\nInnhold i chunk 1.\n\n--- page=68 ---\nNeste side.\n</untrusted_data>',
    );
    expect(documents).toContain('--- pages=95-98 ---\nInnhold i chunk 2.');
    expect(documents).toContain(
      '<untrusted_data kind="source" id="d3" title="Rapport 3">\nInnhold i chunk 3.\n</untrusted_data>',
    );
  });

  it("the search and read_chunks descriptions tell the model to cite each chunk's page", async () => {
    const out = await searchThenRead(['c1']);

    const description = (name: string) =>
      out.loops[0]?.tools?.find((t) => t.name === name)?.description ?? '';
    for (const name of ['search', 'read_chunks']) {
      expect(description(name)).toContain('page=N');
      expect(description(name)).toContain('pages=N-M');
      expect(description(name)).toContain('cite that page');
    }
  });

  it('the answer model is told to write a page without square brackets, which are kept for citations', async () => {
    const out = await run({
      retrieval: retrieval({}, store()).impl,
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, citeBy: 'excerpt' } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['omorganiseringer'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'omorganiseringer' })]),
            () => result('Ferdig.'),
          ],
          read: [() => readSignal('support-found')],
        },
      },
    });

    const synth = out.seen.filter((s) => s.kind === 'synth').at(-1);
    expect(String(synth?.request.messages.at(-1)?.content)).toContain(
      'Write a page as plain text, such as "s. 67", never as a number in square brackets: [N] is only for citing a source.',
    );
  });
});
