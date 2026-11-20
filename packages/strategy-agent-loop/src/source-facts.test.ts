import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  result,
  retrieval,
  run,
  systemMessages,
  toolMessages,
} from './harness.test-utils.js';
import type { SourceFactsQuery, SourceFactsReport } from './source-facts.js';

const kudos: SourceFactsReport = {
  id: 'digdir/kudos',
  name: 'Kudos',
  inScope: true,
  documents: 45799,
  lastImport: '2026-11-15T03:12:00.000Z',
  yearField: 'concerned_years',
  newest: [{ id: 'd9', title: 'Årsrapport 2025', date: '2026-03-01', year: '2026' }],
  newestOrder: 'date-within-latest-years',
  filterValues: { orgs_short: [{ value: 'DIGDIR', count: 120 }] },
};

const withFacts = () => {
  const asked: SourceFactsQuery[] = [];
  const stub = retrieval({
    sourceFacts: async (request) => {
      asked.push(request);
      return [kudos];
    },
  });
  return { ...stub, asked };
};

const toolNames = (request: { tools?: { name: string }[] } | undefined) =>
  (request?.tools ?? []).map((t) => t.name);

const enabled = {
  ...baseConfig,
  strategy: { ...baseConfig.strategy, noToolCallRetry: true },
  tools: ['source-facts@1'],
};

describe('the source facts tool', () => {
  it('is offered only to a service that lists source-facts@1 in its tools', async () => {
    const script = { primary: { loop: [() => result('Ferdig.')], smallTalk: () => 'SMALL_TALK' } };
    const on = await run({
      scripts: script,
      retrieval: withFacts().impl,
      config: enabled,
      tools: ['source-facts@1'],
    });
    const off = await run({ scripts: script, retrieval: withFacts().impl });

    expect(toolNames(on.loops[0])).toContain('source_facts');
    expect(toolNames(off.loops[0])).not.toContain('source_facts');
  });

  it('gives the model the facts as untrusted data and lets it answer from them without searching', async () => {
    const facts = withFacts();
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('source_facts', { newest: 5, fields: ['orgs_short'] })]),
            () => result('Det nyeste dokumentet er Årsrapport 2025.'),
          ],
        },
      },
      retrieval: facts.impl,
      config: enabled,
      tools: ['source-facts@1'],
      question: 'Hvilke nyligste dokumenter har du hentet inn fra Kudos?',
    });

    expect(facts.asked).toEqual([
      { newest: 0, maxValues: 50 },
      { newest: 5, fields: ['orgs_short'] },
    ]);
    const [content] = toolMessages(out.loops[1]);
    expect(content).toMatch(/^<untrusted_data kind="source-facts">/);
    expect(content).toContain('"documents": 45799');
    expect(content).toContain('"last_import": "2026-11-15T03:12:00.000Z"');
    expect(systemMessages(out.loops[1]).join('\n')).not.toContain('MUST search FIRST');
    expect(out.text).toBe('Det nyeste dokumentet er Årsrapport 2025.');
    expect(facts.calls.some((c) => c.op === 'search')).toBe(false);
  });

  it('is not run for a service that has not listed it, even when the model calls it', async () => {
    const facts = withFacts();
    const out = await run({
      scripts: {
        primary: {
          loop: [() => result('', [call('source_facts', {})]), () => result('Ferdig.')],
          smallTalk: () => 'SMALL_TALK',
        },
      },
      retrieval: facts.impl,
    });

    expect(facts.asked).toEqual([{ newest: 0, maxValues: 50 }]);
    expect(toolMessages(out.loops[1])[0]).toMatch(/^Unknown tool: source_facts/);
  });
});
