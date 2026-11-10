import { describe, expect, it } from 'vitest';
import { call, result, retrieval, run, toolMessages } from './harness.test-utils.js';

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
      'Hint, no filter applied: The query names "Datatilsynet"; orgs_long can filter on it. The query names the years "2023", "2024"; title can filter on them. Add filter_by only if the question asks for nothing else; a question about an organisation also needs other organisations\' documents.',
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

  it('records what the search detected in the retrieval notice', async () => {
    const out = await run({ retrieval: detected(), scripts: searchOnce });

    const notice = out.notices.find((n) => n.kind === 'retrieval');
    expect(notice?.detections).toEqual([
      expect.objectContaining({ field: 'orgs_long', use: 'hint' }),
      expect.objectContaining({ field: 'title', use: 'hint' }),
    ]);
  });
});
