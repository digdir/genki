import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  chunk,
  result,
  retrieval,
  run,
  toolMessages,
} from './harness.test-utils.js';
import type { AgentLoopRuntimeConfig, Chunk, SearchAttribution } from './index.js';

const searchConfig = (search: Record<string, unknown>): AgentLoopRuntimeConfig => ({
  ...baseConfig,
  strategy: { ...baseConfig.strategy, search },
});

const searchOnce = (args: Record<string, unknown> = { queries: ['årsverk'] }) => ({
  primary: { loop: [() => result('', [call('search', args)]), () => result('Ferdig.')] },
});

const firstResult = async (
  opts: {
    store?: Map<string, Chunk>;
    config?: AgentLoopRuntimeConfig;
    args?: Record<string, unknown>;
    attribution?: SearchAttribution;
  } = {},
) => {
  const base = retrieval({}, opts.store);
  const impl = opts.attribution
    ? retrieval(
        {
          search: async (queries, options, signal) => ({
            ...(await base.impl.search(queries, options, signal)),
            attribution: opts.attribution as SearchAttribution,
          }),
        },
        opts.store,
      ).impl
    : base.impl;
  const out = await run({
    retrieval: impl,
    scripts: searchOnce(opts.args),
    ...(opts.config ? { config: opts.config } : {}),
  });
  return toolMessages(out.loops[1])[0] ?? '';
};

const threeDocuments = () =>
  new Map([
    ['c1', chunk(1)],
    ['c2', chunk(2)],
    ['c3', chunk(3)],
  ]);

describe('the search window the agent sees', () => {
  it('search results are grouped by document', async () => {
    const text = await firstResult({
      store: new Map([
        ['c1', chunk(1)],
        ['c1b', chunk(1, { chunkId: 'c1b', position: 4 })],
        ['c2', chunk(2)],
      ]),
    });

    const lines = text.split('\n');
    const first = lines.findIndex((l) => l.startsWith('1. doc_num=d1 '));
    expect(lines[first]).toContain('hits=2');
    expect(lines[first + 1]).toMatch(/^ {3}chunk_id=c1 chunk_index=0\/20/);
    expect(lines[first + 2]).toMatch(/^ {3}chunk_id=c1b chunk_index=4\/20/);
    expect(lines[first + 3]).toMatch(/^2\. doc_num=d2 /);
    expect(text).toContain('found 3 hits in 2 documents');
  });

  it('search shows at most three hits of a document and counts the rest', async () => {
    const text = await firstResult({
      store: new Map(
        [0, 1, 2, 3].map((i) => [`c1-${i}`, chunk(1, { chunkId: `c1-${i}`, position: i })]),
      ),
    });

    expect(text.match(/^ {3}chunk_id=/gm)).toHaveLength(3);
    expect(text).toContain('   1 more hit in this document: read it by doc_num and chunk_range');
  });

  it('search.displayLimit counts documents, not hits', async () => {
    const text = await firstResult({
      store: new Map([
        ['c1', chunk(1)],
        ['c1b', chunk(1, { chunkId: 'c1b', position: 4 })],
        ['c2', chunk(2)],
        ['c3', chunk(3)],
      ]),
      config: searchConfig({ displayLimit: 2 }),
    });

    expect(text).toContain('Showing documents 1 to 2 of 3;');
    expect(text.match(/^ {3}chunk_id=/gm)).toHaveLength(3);
    expect(text).not.toContain('doc_num=d3 ');
  });

  it('search names a filter it added from the query', async () => {
    const text = await firstResult({
      attribution: { autoFilter: { field: 'year', options: ['2025'] } },
    });

    expect(text).toContain('Filters: added from the query: year is one of 2025.');
  });

  it('search says when a filter from the query found nothing and was dropped', async () => {
    const text = await firstResult({
      attribution: { autoFilter: { field: 'year', options: ['2025'] }, autoFilterFallback: true },
    });

    expect(text).toContain(
      'Filters: none. A filter on year from the query found nothing, so the search ran without it.',
    );
    expect(text).not.toContain('added from the query');
  });

  it('search states the total and that more is available', async () => {
    const text = await firstResult({
      store: threeDocuments(),
      config: searchConfig({ displayLimit: 2 }),
    });

    expect(text).toContain('found 3 hits in 3 documents');
    expect(text).toContain(
      'Showing documents 1 to 2 of 3; more available: search again with the same queries and filter_by and page=2.',
    );
    expect(text).toContain('the collection may hold more documents that match than these');
  });

  it('search says when the window shows all it found', async () => {
    const text = await firstResult({ store: threeDocuments() });

    expect(text).toContain('Showing documents 1 to 3 of 3; that is all this search found.');
  });

  it('search lines show the publication date', async () => {
    const text = await firstResult({
      store: new Map([['c1', chunk(1, { publishedAt: '2025-03-01T00:00:00.000Z' })]]),
    });

    expect(text).toMatch(/1\. doc_num=d1 title="Rapport 1" published=2025-03-01 /);
  });

  it('search lists the active filters', async () => {
    const text = await firstResult({
      args: {
        queries: ['årsverk'],
        filter_by: { fields: [{ field: 'year', selected_options: ['2025'] }] },
      },
      attribution: {
        callerFilter: [
          {
            type: 'in-set',
            field: 'owner',
            'selected-options': ['Digdir'],
            'value-type': 'string',
          },
        ],
      },
    });

    expect(text).toContain(
      'Filters: set by the service or caller: owner is one of Digdir. set by your filter_by: year is one of 2025.',
    );
  });

  it('search says when no filter is active', async () => {
    expect(await firstResult()).toContain('\nFilters: none.');
  });

  it('search pages past the first window', async () => {
    const r = retrieval({}, threeDocuments());
    const args = { queries: ['årsverk'] };
    const out = await run({
      retrieval: r.impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', args)]),
            () => result('', [call('search', { ...args, page: 2 })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    const paged = toolMessages(out.loops[2])[1] ?? '';
    expect(paged).toContain('Showing documents 3 to 3 of 3; that is all this search found.');
    expect(paged).toMatch(/\n3\. doc_num=d3 /);
    expect(paged).not.toContain('doc_num=d1 ');
    expect(paged).toContain('This page of an earlier search did not use the search budget.');
    expect(r.calls.filter((c) => c.op === 'search')).toHaveLength(1);
  });

  it('a page of new queries runs a new search', async () => {
    const r = retrieval({}, threeDocuments());
    await run({
      retrieval: r.impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['årsverk'] })]),
            () => result('', [call('search', { queries: ['budsjett'], page: 2 })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(r.calls.filter((c) => c.op === 'search')).toHaveLength(2);
  });

  it('a page of the same search is served when the search budget is spent', async () => {
    const r = retrieval({}, threeDocuments());
    const args = { queries: ['årsverk'] };
    const out = await run({
      retrieval: r.impl,
      config: { ...baseConfig, strategy: { budget: { searches: 1 }, search: { displayLimit: 2 } } },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', args)]),
            () => result('', [call('search', { ...args, page: 2 })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[2])[1]).toContain('Showing documents 3 to 3 of 3;');
  });

  it('a page with other filters runs a new search', async () => {
    const r = retrieval({}, threeDocuments());
    await run({
      retrieval: r.impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['årsverk'] })]),
            () =>
              result('', [
                call('search', {
                  queries: ['årsverk'],
                  page: 2,
                  filter_by: { fields: [{ field: 'year', selected_options: ['2025'] }] },
                }),
              ]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(r.calls.filter((c) => c.op === 'search')).toHaveLength(2);
  });

  it('a page past the last page says how many pages there are', async () => {
    const r = retrieval({}, threeDocuments());
    const args = { queries: ['årsverk'] };
    const out = await run({
      retrieval: r.impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', args)]),
            () => result('', [call('search', { ...args, page: 5 })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[2])[1]).toContain(
      'Page 5 is past the last page: this search has 2 pages of 2 documents.',
    );
  });

  it('a page given as text is read as a number', async () => {
    const r = retrieval({}, threeDocuments());
    const args = { queries: ['årsverk'] };
    const out = await run({
      retrieval: r.impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', args)]),
            () => result('', [call('search', { ...args, page: '2' })]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[2])[1]).toContain('Showing documents 3 to 3 of 3;');
  });

  it('a search started on a later page tells diagnostics which page it showed', async () => {
    const out = await run({
      retrieval: retrieval({}, threeDocuments()).impl,
      config: searchConfig({ displayLimit: 2 }),
      scripts: searchOnce({ queries: ['årsverk'], page: 2 }),
    });

    expect(out.notices.find((n) => n.kind === 'retrieval')?.page).toBe(2);
  });

  it('search.snippets adds a snippet to each hit', async () => {
    const store = new Map([
      ['c1', chunk(1, { snippet: 'Digdir hadde 326 årsverk.' })],
      ['c2', chunk(2, { snippet: 'Budsjettet økte.' })],
    ]);

    const on = await firstResult({ store, config: searchConfig({ snippets: true }) });
    const off = await firstResult({ store });

    expect(on).toContain('chunk_id=c1 ');
    expect(on).toContain('snippet="Digdir hadde 326 årsverk."');
    expect(on).toContain('snippet="Budsjettet økte."');
    expect(off).not.toContain('snippet=');
  });

  it('strategyQuota changes the mix of hits', async () => {
    const store = new Map([
      ['c1', chunk(1, { searchTypes: ['phrase'] })],
      ['c2', chunk(2, { searchTypes: ['phrase'] })],
      ['c3', chunk(3, { searchTypes: ['phrase'] })],
      ['c4', chunk(4, { searchTypes: ['content'] })],
    ]);

    const plain = await firstResult({ store, config: searchConfig({ displayLimit: 2 }) });
    const mixed = await firstResult({
      store,
      config: searchConfig({ displayLimit: 2, strategyQuota: 1 }),
    });

    expect(plain).not.toContain('doc_num=d4 ');
    expect(mixed).toMatch(/\n2\. doc_num=d4 /);
  });

  it('the filter hint does not argue against filtering', async () => {
    const text = await firstResult({
      attribution: {
        detections: [
          { kind: 'year', field: 'year', values: ['2024'], queries: ['årsverk'], use: 'hint' },
        ],
      },
    });

    expect(text).toContain(
      'Use filter_by when the question is only about these; search without it when the question also needs other documents.',
    );
    expect(text).not.toMatch(/only if|also needs other organisations/);
  });
});
