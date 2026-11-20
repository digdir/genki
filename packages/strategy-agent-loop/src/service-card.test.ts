import { describe, expect, it } from 'vitest';
import { baseConfig, result, retrieval, run } from './harness.test-utils.js';
import {
  agentLoopConfig,
  agentTools,
  cardFactsCache,
  defaultSystemPrompt,
  ownerInstructionsHeading,
  searchPromptSections,
  toolsOnlySystemPrompt,
} from './index.js';
import type { SourceFactsQuery, SourceFactsReport } from './source-facts.js';

const collection: SourceFactsReport = {
  id: 'digdir/reports',
  name: 'Rapporter',
  inScope: true,
  documents: 4512,
  yearField: 'year',
  newest: [],
  filterValues: {
    year: [
      { value: '2026', count: 40 },
      { value: '2015', count: 300 },
      { value: '2006', count: 12 },
    ],
  },
};

const withFacts = (facts: SourceFactsReport[] = [collection]) => {
  const asked: SourceFactsQuery[] = [];
  const stub = retrieval({
    sourceFacts: async (request) => {
      asked.push(request);
      return facts;
    },
  });
  return { impl: stub.impl, asked };
};

const answerOnly = { primary: { loop: [() => result('Ferdig.')] } };

const systemPrompt = async (
  strategy: Record<string, unknown> = {},
  facts = withFacts().impl,
  extra: Partial<Parameters<typeof run>[0]> = {},
) => {
  const out = await run({
    scripts: answerOnly,
    retrieval: facts,
    config: { ...baseConfig, strategy: { ...baseConfig.strategy, ...strategy } },
    ...extra,
  });
  return String(out.loops[0]?.messages[0]?.content);
};

const kudosNames = /orgs_long|orgs_short|owner_short|Prop\. 1 S|tildelingsbrev|årsrapport/i;

describe('the service card in the agent prompt', () => {
  it('the prompt names the service and its datasets with count and year range', async () => {
    const prompt = await systemPrompt();

    expect(prompt).toMatch(
      /^About this service:\nYou are the service "KA"\. Its purpose: Svarer på spørsmål om offentlig økonomi\.\n/,
    );
    expect(prompt).toContain('- "Rapporter": 4512 documents, year from 2006 to 2026');
    expect(prompt).toContain('Fields the collection can be filtered on: orgs_short.');
  });

  it("the prompt states today's date", async () => {
    expect(await systemPrompt()).toContain("Today's date is 6. oktober 2026 (Norwegian time).");
  });

  it('the prompt says that "du" and "you" mean the service and its collection', async () => {
    expect(await systemPrompt()).toContain(
      'When the user says "du", "dere" or "you", they mean this service and its document collection, not this conversation.',
    );
  });

  it('the prompt names the answer languages of the service', async () => {
    const out = await run({
      scripts: answerOnly,
      retrieval: withFacts().impl,
      config: { ...baseConfig, languages: ['nb', 'en'] },
    });

    expect(String(out.loops[0]?.messages[0]?.content)).toContain(
      'Answer languages: Norwegian bokmål, English.',
    );
  });

  it('the collection facts are read within the active filters', async () => {
    const facts = withFacts([{ ...collection, inScope: false, documents: 0 }]);
    const prompt = await systemPrompt({}, facts.impl, {
      overrides: {
        'retrieve-filter-by': { fields: [{ field: 'year', 'selected-options': ['2025'] }] },
      },
    });

    expect(facts.asked).toEqual([{ newest: 0, maxValues: 50 }]);
    expect(prompt).toContain('Its document collection, within the active filters:');
    expect(prompt).toContain('- "Rapporter": outside the active filters');
  });

  it('a card is still given when the collection facts cannot be read', async () => {
    const failing = retrieval({
      sourceFacts: async () => {
        throw new Error('the index is down');
      },
    }).impl;

    const prompt = await systemPrompt({}, failing);

    expect(prompt).toContain('You are the service "KA".');
    expect(prompt).not.toContain('Its document collection');
  });

  it('a service without a dataset is told what it is without a collection', async () => {
    const out = await run({ scripts: answerOnly, withoutDataset: true });
    const prompt = String(out.loops[0]?.messages[0]?.content);

    expect(prompt).toContain('they mean this service, not this conversation.');
    expect(prompt).not.toContain('document collection');
    expect(prompt).toContain(toolsOnlySystemPrompt);
  });

  it('the answer call is told which service it writes for', async () => {
    const out = await run({
      retrieval: withFacts().impl,
      config: { ...baseConfig, strategy: { ...baseConfig.strategy, ablate: ['sufficiency-gate'] } },
      scripts: {
        primary: {
          loop: [
            () => result('', [{ id: 's', name: 'search', arguments: '{"queries":["x"]}' }]),
            () => result('', [{ id: 'r', name: 'read_chunks', arguments: '{"chunk_ids":["c1"]}' }]),
          ],
        },
      },
    });
    const synth = out.seen.find((s) => s.kind === 'synth')?.request;

    expect(String(synth?.messages[0]?.content)).toContain('You are the service "KA".');
  });
});

describe('the card facts in a run', () => {
  it('card facts are reused across runs until the filters change', async () => {
    const facts = withFacts();
    const loopOptions = {
      retrieval: async () => facts.impl,
      now: () => new Date('2026-10-06T10:00:00Z'),
    };
    const filtered = {
      'retrieve-filter-by': { fields: [{ field: 'year', 'selected-options': ['2025'] }] },
    };

    await run({ scripts: answerOnly, loopOptions });
    await run({ scripts: answerOnly, loopOptions });
    expect(facts.asked).toHaveLength(1);

    await run({ scripts: answerOnly, loopOptions, overrides: filtered });
    expect(facts.asked).toHaveLength(2);
  });

  it('card facts are not shared between configs with other datasets', async () => {
    const facts = withFacts();
    const loopOptions = {
      retrieval: async () => facts.impl,
      now: () => new Date('2026-10-06T10:00:00Z'),
    };
    const withDataset = (dataset: string) => ({
      ...baseConfig,
      knowledge: { datasets: [{ dataset }] },
    });

    await run({ scripts: answerOnly, loopOptions, config: withDataset('reports') });
    await run({ scripts: answerOnly, loopOptions, config: withDataset('letters') });

    expect(facts.asked).toHaveLength(2);
  });
});

describe('the owner prompt on the platform base', () => {
  it('instructions are added to the base prompt instead of replacing it', async () => {
    const prompt = await systemPrompt({ instructions: 'Svar kort og på klarspråk.' });

    expect(prompt).toContain(
      `${defaultSystemPrompt}\n\n${ownerInstructionsHeading}\nSvar kort og på klarspråk.`,
    );
  });

  it('an edited base section replaces only that section', async () => {
    const prompt = await systemPrompt({
      promptSections: { workflow: 'Search, then read what you will cite.' },
    });

    expect(prompt).toContain('Search, then read what you will cite.');
    expect(prompt).not.toContain('1. SEARCH:');
    for (const section of searchPromptSections.filter((s) => s.id !== 'workflow'))
      expect(prompt).toContain(section.text);
  });

  it('an empty section edit leaves that section out', async () => {
    const prompt = await systemPrompt({ promptSections: { gate: '' } });

    expect(prompt).not.toContain('sufficiency gate');
    expect(prompt).toContain('1. SEARCH:');
  });

  it('a section the platform does not have is refused', () => {
    expect(agentLoopConfig.safeParse({ promptSections: { tone: 'Vær blid.' } }).success).toBe(
      false,
    );
    expect(
      agentLoopConfig.safeParse({ promptSections: { role: 'Du er en arkivar.' } }).success,
    ).toBe(true);
  });

  it('the generic prompt contains no Kudos field names', () => {
    expect(defaultSystemPrompt).not.toMatch(kudosNames);
    expect(toolsOnlySystemPrompt).not.toMatch(kudosNames);
    expect(JSON.stringify(agentTools)).not.toMatch(kudosNames);
  });
});

describe('the card facts cache', () => {
  it('reuses card facts for five minutes, then reads them again', async () => {
    let now = new Date('2026-10-06T10:00:00Z');
    const cached = cardFactsCache(() => now);
    let reads = 0;
    const collect = async () => {
      reads += 1;
      return { sources: [], filterFields: [], complete: true };
    };

    await cached('k', collect);
    now = new Date('2026-10-06T10:04:59Z');
    await cached('k', collect);
    now = new Date('2026-10-06T10:05:00Z');
    await cached('k', collect);

    expect(reads).toBe(2);
  });

  it('does not keep card facts that could not all be read', async () => {
    const cached = cardFactsCache(() => new Date('2026-10-06T10:00:00Z'));
    let reads = 0;
    const collect = async () => {
      reads += 1;
      return { sources: [], filterFields: [], complete: false };
    };

    await cached('k', collect);
    await cached('k', collect);

    expect(reads).toBe(2);
  });
});
