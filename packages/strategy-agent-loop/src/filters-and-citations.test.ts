import { describe, expect, it } from 'vitest';
import { call, result, run } from './harness.test-utils.js';

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
