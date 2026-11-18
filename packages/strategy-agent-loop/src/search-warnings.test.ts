import { describe, expect, it } from 'vitest';
import { baseConfig, call, result, retrieval, run, toolMessages } from './harness.test-utils.js';
import type { AgentRetrieval } from './index.js';
import { searchFailures } from './tools.js';

const timeout = 'canceling statement due to statement timeout';

/** A knowledge fake whose content search fails, as retrieval reports it for each query. */
const failing = (warnings: string[], found = true): AgentRetrieval => {
  const base = retrieval().impl;
  return {
    ...base,
    search: async (queries, options, signal) => {
      const outcome = await base.search(queries, options, signal);
      return {
        chunks: found ? outcome.chunks : [],
        attribution: {
          phrase: 3,
          metadata: 2,
          content: 0,
          ...(warnings.length ? { warnings } : {}),
        },
      };
    },
  };
};

const searchOnce = (r: AgentRetrieval, args: Record<string, unknown> = {}) =>
  run({
    retrieval: r,
    config: baseConfig,
    scripts: {
      primary: {
        loop: [
          () =>
            result('', [call('search', { queries: ['tildelingsbrev', 'digdir 2025'], ...args })]),
          () => result('Ferdig.'),
        ],
      },
    },
  });

const retrievalNotice = (notices: Record<string, unknown>[]) =>
  notices.find((n) => n.kind === 'retrieval');

describe('a search strategy that fails', () => {
  it('a search whose content strategy times out tells the agent which strategy failed', async () => {
    const out = await searchOnce(
      failing([`content search: ${timeout}`, `content search: ${timeout}`]),
    );

    const text = toolMessages(out.loops[1])[0] ?? '';
    const warning = text.split('\n').find((line) => line.startsWith('Search warning:'));
    expect(warning).toBe(
      'Search warning: content search timed out. These hits come only from the searches that worked and may miss the answer: search with other words, or say that search is failing.',
    );
    expect(text.indexOf('Search warning:')).toBeLessThan(text.indexOf('<untrusted_data'));
    expect(text).not.toContain('statement');
  });

  it("the search step's notice names each failed strategy without the engine's message", async () => {
    const out = await searchOnce(
      failing([
        `content search: ${timeout}`,
        'metadata search: connect ECONNREFUSED 10.0.0.4:5432',
        'skipped org auto-filter: engine lacks facets',
      ]),
    );

    expect(retrievalNotice(out.notices)?.failed).toEqual([
      { strategy: 'content', reason: 'timeout' },
      { strategy: 'metadata', reason: 'error' },
    ]);
    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(text).toContain('Search warning: content search timed out; metadata search failed.');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('a search with no failed strategy adds no warning', async () => {
    const out = await searchOnce(failing(['skipped org auto-filter: engine lacks facets']));

    expect(toolMessages(out.loops[1])[0]).not.toContain('Search warning');
    expect(retrievalNotice(out.notices)).not.toHaveProperty('failed');
  });

  it('a search that finds nothing under an org-number filter because a strategy failed says search failed', async () => {
    const out = await searchOnce(failing([`content search: ${timeout}`], false), {
      filter_by: { fields: [{ field: 'owner_orgnr', selected_options: ['991825827'] }] },
    });

    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(text).toContain('Search warning: content search timed out.');
    expect(text).not.toContain('these organisations have no documents');
    expect(retrievalNotice(out.notices)?.failed).toEqual([
      { strategy: 'content', reason: 'timeout' },
    ]);
  });

  it('sorts each engine message into a failure reason, whatever the strategy is called', () => {
    expect(
      searchFailures({
        warnings: [
          'content search: took longer than 15 s',
          'content search: text search took longer than 15 s; these hits come from vector search only',
          'content search: vector search failed: 503',
          'phrase search: no query vector',
          'metadata search: the query is too long',
          'innhold-søk search: canceling statement\ndue to statement timeout',
          'content.v2 search: connect ECONNREFUSED 10.0.0.4:5432',
        ],
      }),
    ).toEqual([
      { strategy: 'content', reason: 'timeout' },
      { strategy: 'content', reason: 'text-unavailable' },
      { strategy: 'content', reason: 'vector-unavailable' },
      { strategy: 'phrase', reason: 'vector-unavailable' },
      { strategy: 'metadata', reason: 'query-too-long' },
      { strategy: 'innhold-søk', reason: 'timeout' },
      { strategy: 'content.v2', reason: 'error' },
    ]);
  });

  it("keeps the first search's failure when a filter that found nothing is dropped", async () => {
    const base = retrieval().impl;
    let calls = 0;
    const r: AgentRetrieval = {
      ...base,
      search: async (queries, options, signal) => {
        calls += 1;
        const outcome = await base.search(queries, options, signal);
        return calls === 1
          ? { chunks: [], attribution: { warnings: [`content search: ${timeout}`] } }
          : outcome;
      },
    };
    const out = await searchOnce(r, {
      filter_by: { fields: [{ field: 'orgs_short', selected_options: ['DIGDIR'] }] },
    });

    expect(toolMessages(out.loops[1])[0]).toContain('Search warning: content search timed out.');
    expect(retrievalNotice(out.notices)?.failed).toEqual([
      { strategy: 'content', reason: 'timeout' },
    ]);
  });

  it("a search that fails completely tells the agent why without the engine's message", async () => {
    const r: AgentRetrieval = {
      ...retrieval().impl,
      search: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.4:5432');
      },
    };
    const out = await searchOnce(r);

    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(text).toBe(
      'Search backend error: every search failed. Try again later, or say that search is failing.',
    );
  });
});
