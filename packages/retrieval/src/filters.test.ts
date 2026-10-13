import { describe, expect, it } from 'vitest';
import type { FilterKind, Hit, KnowledgePort, SearchRequest } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { createAgentRetrieval } from './factories.js';
import {
  accepts,
  fromFilterMap,
  mergeTyped,
  toFilterMapFields,
  toInput,
  toSet,
} from './filters.js';
import { FacetCache, retrieve } from './pipeline.js';

describe('typed filter merging', () => {
  it('lets explicit clauses win per field and type, and combines different types on one field', () => {
    const explicit = toSet({ orgs_short: ['NAV'], title: ['Årsrapport 2024'] });
    const detected = {
      orgs_short: [['DIGDIR']],
      title: [{ contains: ['2024'] }],
      type: [{ not: ['Brev'] }],
    };

    expect(toInput(mergeTyped(explicit, detected))).toEqual({
      orgs_short: ['NAV'],
      title: { all: [['Årsrapport 2024'], { contains: ['2024'] }] },
      type: { not: ['Brev'] },
    });
  });

  it('keeps several detected clauses of different types, and drops empty sets', () => {
    expect(toInput(mergeTyped({}, { title: [{ contains: ['2024'] }, ['Årsrapport']] }))).toEqual({
      title: { all: [{ contains: ['2024'] }, ['Årsrapport']] },
    });
    expect(toInput(mergeTyped({}, {}))).toBeUndefined();
    expect(toSet({ title: { all: [['a'], { contains: ['b'] }] } })).toEqual({
      title: [['a'], { contains: ['b'] }],
    });
  });

  it('accepts a clause only where the field declares a matching kind, including several kinds per field', () => {
    expect(accepts('text', { contains: ['2024'] })).toBe(true);
    expect(accepts('text', ['x'])).toBe(false);
    expect(accepts(['text', 'multiselect'], ['x'])).toBe(true);
    expect(accepts('multiselect', { not: ['x'] })).toBe(true);
    expect(accepts('select', ['x'])).toBe(true);
    expect(accepts('select', ['x', 'y'])).toBe(false);
    expect(accepts(undefined, ['x'])).toBe(false);
  });
});

const portWith = (filters: Record<string, FilterKind | FilterKind[]>) => {
  const requests: SearchRequest[] = [];
  const hit: Hit = {
    id: 'c1',
    score: 1,
    text: 't',
    title: 'Årsrapport 2024',
    document: 'd1',
    fields: {},
  };
  const port: KnowledgePort = {
    info: () => ({
      id: 'kudos',
      residency: 'norway',
      filters: filters as Record<string, FilterKind>,
      profiles: ['content', 'phrase'],
    }),
    searchMany: async (batch) => {
      requests.push(...batch);
      return batch.map(() => ({ hits: [hit] }));
    },
    search: async () => ({ hits: [hit] }),
    fetch: async (ids) => ids.map(() => hit),
    range: async () => [],
    facets: async () => ({ orgs_short: [{ value: 'Digdir', count: 3 }] }),
  };
  return { port, requests };
};

describe('typed filters in the pipeline', () => {
  it('sends a detected contains clause alongside an explicit multiselect on the same field', async () => {
    const k = portWith({ title: ['text', 'multiselect'], orgs_short: 'multiselect' });

    const result = await retrieve({
      knowledge: k.port,
      queries: ['årsrapport Digdir 2024'],
      filters: { title: ['Årsrapport 2024'], orgs_short: ['NAV'] },
      facetCache: new FacetCache(),
      config: { strategies: [{ name: 'content', profiles: ['content'] }] },
    });

    expect(k.requests[0]?.filters).toEqual({
      title: { all: [['Årsrapport 2024'], { contains: ['2024'] }] },
      orgs_short: ['NAV'],
    });
    expect(result.trace.expansion.detectedFilter).toEqual({
      orgs_short: ['Digdir'],
      title: { contains: ['2024'] },
    });
  });

  it('collapses to one value per field when types do not collide, so the current port keeps working', async () => {
    const k = portWith({ title: 'text', orgs_short: 'multiselect' });

    await retrieve({
      knowledge: k.port,
      queries: ['Digdir 2024'],
      facetCache: new FacetCache(),
      config: { strategies: [{ name: 'content', profiles: ['content'] }] },
    });

    expect(k.requests[0]?.filters).toEqual({
      orgs_short: ['Digdir'],
      title: { contains: ['2024'] },
    });
  });
});

describe('factories with a model', () => {
  it('plan with the corpus-aware planner by default', async () => {
    const k = portWith({ doc_num: 'multiselect' });
    const calls: string[] = [];
    const model: ModelPort = {
      info: () => ({ id: 'm', residency: 'norway', capabilities: ['json-schema'] }),
      chat: async (request) => {
        calls.push(request.jsonSchema?.name ?? '');
        return {
          content:
            request.jsonSchema?.name === 'groundedQueries'
              ? JSON.stringify({ search_phrases: ['grounded'] })
              : JSON.stringify({ user_intent: 'Intent', search_phrases: ['blind'] }),
          toolCalls: [],
          finishReason: 'stop',
          usage: {},
          servedModel: 'm',
        };
      },
      chatStream: () => {
        throw new Error('not used');
      },
    };

    const plan = await createAgentRetrieval({ knowledge: k.port, model }).plan(
      'q',
      [],
      new AbortController().signal,
    );

    expect(calls).toEqual(['planQueries', 'groundedQueries']);
    expect(plan).toMatchObject({ queries: ['Intent', 'grounded'], userIntent: 'Intent' });
  });
});

describe("headless-rag's retrieve-filter-by map", () => {
  it('becomes typed filter values: multiselect lists, contains, not-in-set and integers', () => {
    expect(
      fromFilterMap({
        fields: [
          { field: 'type', 'selected-options': ['Evaluering', 'Årsrapport'] },
          { field: 'title', type: 'contains', selected_options: ['2024'] },
          { field: 'orgs_short', type: 'not-in-set', 'selected-options': ['NAV'] },
          { field: 'concerned_years', 'value-type': 'integer', value: '2023' },
          { field: 'empty', 'selected-options': [] },
        ],
      }),
    ).toEqual({
      type: ['Evaluering', 'Årsrapport'],
      title: { contains: ['2024'] },
      orgs_short: { not: ['NAV'] },
      concerned_years: [2023],
    });
  });

  it('is nothing when it names no usable field, and round-trips for reporting', () => {
    expect(fromFilterMap(undefined)).toBeUndefined();
    expect(fromFilterMap({ fields: [] })).toBeUndefined();
    expect(toFilterMapFields({ type: ['Evaluering'], title: { contains: ['2024'] } })).toEqual([
      {
        type: 'multiselect',
        field: 'type',
        'selected-options': ['Evaluering'],
        'value-type': 'string',
      },
      { type: 'contains', field: 'title', 'selected-options': ['2024'], 'value-type': 'string' },
    ]);
  });
});
