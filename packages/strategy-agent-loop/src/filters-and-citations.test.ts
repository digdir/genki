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

const filtered = {
  'retrieve-filter-by': {
    fields: [
      { type: 'multiselect', field: 'orgs_short', 'selected-options': ['DIGDIR'] },
      { type: 'multiselect', field: 'concerned_years', 'selected-options': ['2025'] },
    ],
  },
};

describe('agent loop with caller filters', () => {
  it('tells the agent which filters are active, finishes a filtered question within budget and cites by [N]', async () => {
    const out = await run({
      overrides: filtered,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev Digdir 2025'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
          ],
          synth: [
            () => 'Digdir skal styrke felles løsninger [c1] og ha bedre data (chunk_id: c2).',
          ],
        },
      },
    });

    const system = String(out.loops[0]?.messages[0]?.content);
    expect(system).toContain(
      'Active filters set by the caller: orgs_short is one of DIGDIR; concerned_years is one of 2025.',
    );
    expect(system).toContain('Cite sources as [N], never by chunk_id.');
    expect(out.task.status).toBe('completed');
    expect(out.loops.length).toBeLessThanOrEqual(4);
    expect(out.text).toBe('Digdir skal styrke felles løsninger [1] og ha bedre data [2].');
    expect(out.meta?.citations).toEqual([
      { index: 1, chunkId: 'c1' },
      { index: 2, chunkId: 'c2' },
    ]);
    expect(out.sources.slice(0, 2).map((s) => s.chunkId)).toEqual(['c1', 'c2']);
  });

  it('rewrites OpenAI-style markers such as 【1†L1-L4】 in the answer as [N]', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2'] })]),
          ],
          synth: [
            () =>
              'Digdir skal styrke felles løsninger 【1†L1-L4】 og ha bedre data 【2:0†source】.',
          ],
        },
      },
    });

    expect(out.text).toBe('Digdir skal styrke felles løsninger [1] og ha bedre data [2].');
    expect(out.meta?.citations).toEqual([
      { index: 1, chunkId: 'c1' },
      { index: 2, chunkId: 'c2' },
    ]);
  });

  it('an answer from generate_response with OpenAI-style markers passes the grounding gate as cited', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          synth: [() => 'Svar 【1†L1-L4】.\nKilder: 【1†source】'],
        },
      },
    });

    expect(out.text).toBe('Svar [1].');
    expect(out.meta?.citations).toEqual([{ index: 1, chunkId: 'c1' }]);
    expect(out.notices).not.toContainEqual(expect.objectContaining({ source: 'grounding-gate' }));
  });

  it('says nothing about filters when the caller set none', async () => {
    const out = await run({
      scripts: { primary: { loop: [() => result('Svaret er 42.')] } },
    });

    expect(String(out.loops[0]?.messages[0]?.content)).not.toContain('Active filters');
  });

  it('marks an answer that found nothing and cites nothing with a structured no-answer flag', async () => {
    const empty = await run({
      scripts: { primary: { loop: [() => result('Jeg fant ikke noe om dette i dokumentene.')] } },
    });
    const answered = await run({
      scripts: { primary: { loop: [() => result('Svaret er 42.')] } },
    });

    expect(empty.meta).toMatchObject({ noAnswer: true });
    expect(answered.meta?.noAnswer).toBeUndefined();
  });
});

describe('what the search detected in the query', () => {
  const detected = () => {
    const r = retrieval();
    return retrieval({
      search: async (queries, options, signal) => ({
        ...(await r.impl.search(queries, options, signal)),
        attribution: {
          detections: [
            {
              kind: 'organisation',
              field: 'orgs_long',
              values: ['Datatilsynet'],
              queries,
              use: 'hint',
            },
            { kind: 'year', field: 'title', values: ['2023', '2024'], queries, use: 'hint' },
          ],
        },
      }),
    }).impl;
  };
  const searchOnce = {
    primary: {
      loop: [
        () => result('', [call('search', { queries: ['Hva sier DFØ om Datatilsynet i 2023?'] })]),
        () => result('Svar.'),
      ],
    },
  };

  it('tells the agent what the query names and which field can filter on it, without filtering', async () => {
    const out = await run({ retrieval: detected(), scripts: searchOnce });

    expect(toolMessages(out.loops[1])[0]).toContain(
      'Hint, no filter applied: The query names "Datatilsynet"; orgs_long can filter on it. The query names the years "2023", "2024"; title can filter on them. Use filter_by when the question is only about these; search without it when the question also needs other documents.',
    );
  });

  it('words a rule hint as what the query suggests', async () => {
    const r = retrieval();
    const ruled = retrieval({
      search: async (queries, options, signal) => ({
        ...(await r.impl.search(queries, options, signal)),
        attribution: {
          detections: [{ kind: 'rule', field: 'language', values: ['en'], queries, use: 'hint' }],
        },
      }),
    }).impl;

    const out = await run({ retrieval: ruled, scripts: searchOnce });

    expect(toolMessages(out.loops[1])[0]).toContain(
      'The query suggests language "en"; language can filter on it.',
    );
  });

  it('gives no hint for what the search only ranked by', async () => {
    const r = retrieval();
    const boosted = retrieval({
      search: async (queries, options, signal) => ({
        ...(await r.impl.search(queries, options, signal)),
        attribution: {
          detections: [
            { kind: 'organisation', field: 'orgs_long', values: ['NAV'], queries, use: 'boost' },
          ],
        },
      }),
    }).impl;

    const out = await run({ retrieval: boosted, scripts: searchOnce });

    expect(toolMessages(out.loops[1])[0]).not.toContain('Hint');
  });

  it('a retrieval notice carries the pages of a chunk that runs over two pages', async () => {
    const store = new Map([[`c1`, chunk(1, { page: 25, pageEnd: 26 })]]);

    const out = await run({ retrieval: retrieval({}, store).impl, scripts: searchOnce });

    const notice = out.notices.find((n) => n.kind === 'retrieval');
    expect(notice?.hits).toEqual([expect.objectContaining({ id: 'c1', page: 25, pageEnd: 26 })]);
  });

  it('records what the search detected in the retrieval notice', async () => {
    const out = await run({ retrieval: detected(), scripts: searchOnce });

    const notice = out.notices.find((n) => n.kind === 'retrieval');
    expect(notice?.detections).toEqual([
      expect.objectContaining({ field: 'orgs_long', use: 'hint' }),
      expect.objectContaining({ field: 'title', use: 'hint' }),
    ]);
  });
});

describe('a filtered search that finds nothing', () => {
  /** A source where every filtered search finds nothing and an unfiltered one finds c1–c5. */
  const emptyWhenFiltered = () => {
    const r = retrieval();
    const fake = retrieval({
      search: async (queries, options, signal) => {
        const found = await r.impl.search(queries, options, signal);
        fake.calls.push({ op: 'search', args: { queries, ...options } });
        return options.filters?.length ? { ...found, chunks: [] } : found;
      },
    });
    return fake;
  };
  const searchFiltered = (field: string, value: string) => ({
    primary: {
      loop: [
        () =>
          result('', [
            call('search', {
              queries: ['KI'],
              filter_by: { fields: [{ field, selected_options: [value] }] },
            }),
          ]),
        () => result('Ingen dokumenter.'),
      ],
    },
  });

  it('keeps a filter on org numbers that finds nothing, and tells the model, instead of searching without it', async () => {
    const r = emptyWhenFiltered();

    const out = await run({
      retrieval: r.impl,
      scripts: searchFiltered('owner_orgnr', '991825827'),
    });

    const searches = r.calls.filter((c) => c.op === 'search');
    expect(searches).toHaveLength(1);
    expect(searches[0]?.args).toMatchObject({
      filters: [{ field: 'owner_orgnr', selectedOptions: ['991825827'] }],
    });
    const message = toolMessages(out.loops[1])[0];
    expect(message).toContain('found 0 chunks with owner_orgnr');
    expect(message).toContain('The filter was kept');
    expect(message).not.toContain('retried without filters');
  });

  it('drops the other filters before the org-number filter when a search finds nothing', async () => {
    const r = retrieval();
    const fake = retrieval({
      search: async (queries, options, signal) => {
        const found = await r.impl.search(queries, options, signal);
        fake.calls.push({ op: 'search', args: { queries, ...options } });
        const fields = (options.filters ?? []).map((f) => f.field);
        return fields.includes('concerned_years') ? { ...found, chunks: [] } : found;
      },
    });

    const out = await run({
      retrieval: fake.impl,
      scripts: {
        primary: {
          loop: [
            () =>
              result('', [
                call('search', {
                  queries: ['KI'],
                  filter_by: {
                    fields: [
                      { field: 'owner_orgnr', selected_options: ['991825827'] },
                      { field: 'concerned_years', selected_options: ['2019'] },
                    ],
                  },
                }),
              ]),
            () => result('Ferdig.'),
          ],
        },
      },
    });

    const searches = fake.calls.filter((c) => c.op === 'search');
    expect(searches).toHaveLength(2);
    expect(searches[1]?.args).toMatchObject({
      filters: [{ field: 'owner_orgnr', selectedOptions: ['991825827'] }],
    });
    const message = toolMessages(out.loops[1])[0];
    expect(message).toContain('retried with only owner_orgnr');
    expect(message).not.toContain('The filter was kept');
  });

  it('keeps the org-number filter when it finds nothing even without the other filters', async () => {
    const r = emptyWhenFiltered();

    const out = await run({
      retrieval: r.impl,
      scripts: {
        primary: {
          loop: [
            () =>
              result('', [
                call('search', {
                  queries: ['KI'],
                  filter_by: {
                    fields: [
                      { field: 'owner_orgnr', selected_options: ['991825827'] },
                      { field: 'concerned_years', selected_options: ['2019'] },
                    ],
                  },
                }),
              ]),
            () => result('Ingen dokumenter.'),
          ],
        },
      },
    });

    const searches = r.calls.filter((c) => c.op === 'search');
    expect(searches).toHaveLength(2);
    expect(searches[1]?.args).toMatchObject({
      filters: [{ field: 'owner_orgnr', selectedOptions: ['991825827'] }],
    });
    const message = toolMessages(out.loops[1])[0];
    expect(message).toContain('even without the other filters');
    expect(message).toContain('The filter was kept');
    expect(message).not.toContain('retried without filters');
  });

  it('still searches without a year filter that finds nothing', async () => {
    const r = emptyWhenFiltered();

    const out = await run({
      retrieval: r.impl,
      scripts: searchFiltered('concerned_years', '2019'),
    });

    expect(r.calls.filter((c) => c.op === 'search')).toHaveLength(2);
    expect(toolMessages(out.loops[1])[0]).toContain(
      'Filtered retrieval returned 0 chunks; retried without filters.',
    );
  });
});

describe('searching inside one document', () => {
  it('the search tool tells the agent to filter by doc_num or title to search inside one document', async () => {
    const out = await run({
      scripts: { primary: { loop: [() => result('Ferdig.')], smallTalk: () => 'QUESTION' } },
    });

    const search = out.loops[0]?.tools?.find((t) => t.name === 'search');
    const filterBy = JSON.stringify(
      (search?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
        ?.filter_by,
    );
    expect(filterBy).toContain(
      'When inspect_filters lists doc_num or title, search inside one document by filtering doc_num with the doc_num a hit showed, or title with the words of its title, and leave the title out of the queries.',
    );
  });
});
