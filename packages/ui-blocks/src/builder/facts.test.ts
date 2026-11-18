import { describe, expect, it } from 'vitest';
import { blockIds } from './catalogue.js';
import {
  factsFromDefinition,
  factsFromModels,
  modelRowsFromDefinition,
  needMet,
  offerOf,
  optionOfferOf,
  servicesIn,
  type Channel,
  type ModelRow,
} from './facts.js';
import {
  byggereglerFilters,
  draftWithDataset,
  draftWithDocuments,
  draftWithFields,
} from './fixtures/drafts.js';
import rows from './fixtures/genki-test-models.json' with { type: 'json' };

// The rows are genki-test's `/v1/models` as the agents' key saw them on 2026-11-09.
const models = rows.data as ModelRow[];
const channels: Channel[] = ['conversations', 'facets', 'feedback'];
const facts = (service: string, given: { steps?: boolean } = {}) => {
  const found = factsFromModels(models, service, { channels, ...given });
  if (!found) throw new Error(`no ${service} on genki-test`);
  return found;
};
const offered = (service: string, given: { steps?: boolean } = {}) =>
  blockIds.filter((id) => offerOf(id, facts(service, given)).offered);

describe('the service facts', () => {
  it('lists each service once, with its rows', () => {
    expect(servicesIn(models).map((s) => s.service)).toEqual([
      'genki-guide',
      'klarsprak',
      'kunnskapsassistenten',
      'kunnskapsassistenten-demo',
      'kunnskapsassistenten-diagram',
      'kunnskapsassistenten-retrieve-only',
    ]);
  });

  it('reads the datasets and their multiselect fields from the row', () => {
    const ka = facts('kunnskapsassistenten');
    expect(ka.datasets).toEqual([
      {
        tenant: 'digdir',
        key: 'kudos',
        filterFields: ['type', 'concerned_years', 'orgs_short', 'orgs_long', 'doc_num'],
      },
    ]);
    expect(ka.chat).toBe(true);
    expect(ka.documents).toBe(false);
  });

  it('counts only the pickable variants of the same service', () => {
    expect(facts('kunnskapsassistenten').variants).toEqual(['kunnskapsassistenten__default']);
  });

  it('knows nothing of a service that is not there', () => {
    expect(factsFromModels(models, 'finnes-ikke', { channels })).toBeUndefined();
  });
});

describe('the blocks a service is offered', () => {
  it('offers kunnskapsassistenten every built block', () => {
    expect(offered('kunnskapsassistenten')).toEqual([
      'threads',
      'settings',
      'chat',
      'filter',
      'approach',
      'sources',
      'document-view',
    ]);
  });

  it('offers no Filter for a collection with no fields to filter by (genki-guide)', () => {
    expect(offered('genki-guide')).not.toContain('filter');
    expect(offerOf('filter', facts('genki-guide')).unmet).toEqual(['service:filter-fields']);
  });

  it('offers no Chat to a service that does not answer in a chat (klarsprak)', () => {
    expect(offerOf('chat', facts('klarsprak')).unmet).toEqual(['service:chat']);
    expect(offerOf('sources', facts('klarsprak')).unmet).toEqual(['service:datasets|documents']);
  });

  it('offers Document view only where Sources would be: a service that searches documents', () => {
    expect(offerOf('document-view', facts('klarsprak')).unmet).toEqual([
      'service:datasets|documents',
    ]);
    expect(offerOf('document-view', facts('kunnskapsassistenten')).offered).toBe(true);
  });

  it('offers no Approach when the way of working reports no steps', () => {
    expect(offered('kunnskapsassistenten', { steps: false })).not.toContain('approach');
  });

  it('offers Approach while nobody knows whether steps come', () => {
    expect(needMet(facts('kunnskapsassistenten'), 'service:steps')).toBe(true);
  });

  it('hides the variant picker for a service with one variant', () => {
    expect(optionOfferOf('chat', 'variantPicker', facts('kunnskapsassistenten'))).toEqual({
      offered: false,
      planned: false,
      unmet: ['service:variants'],
    });
  });

  it('offers no Threads without the conversations channel', () => {
    const noThreads = factsFromModels(models, 'kunnskapsassistenten', { channels: ['facets'] });
    expect(offerOf('threads', noThreads).unmet).toEqual(['channel:conversations']);
  });

  it('never offers a block that is not built, and says it is coming', () => {
    expect(offerOf('notes', facts('kunnskapsassistenten'))).toEqual({
      offered: false,
      planned: true,
      unmet: [],
    });
    expect(offerOf('projects', facts('kunnskapsassistenten')).unmet).toEqual(['genki:projects']);
  });
});

describe('a family of services as variants', () => {
  it('counts the pickable rows of every service in the family, as kunnskapsassistenten’s picker', () => {
    const ka = factsFromModels(models, 'kunnskapsassistenten', {
      channels,
      family: (service) => service.startsWith('kunnskapsassistenten'),
    });
    expect(ka?.variants).toEqual([
      'kunnskapsassistenten__default',
      'kunnskapsassistenten-demo__default',
    ]);
    expect(optionOfferOf('chat', 'variantPicker', ka).offered).toBe(true);
  });
});

describe('the facts of a draft', () => {
  const filtersOf = (dataset: string) => byggereglerFilters[dataset];
  const given = { channels: ['conversations', 'facets'] as Channel[], filtersOf };
  const draftOffered = (definition: unknown) =>
    blockIds.filter((id) => offerOf(id, factsFromDefinition(definition, given)).offered);

  it('reads a draft’s datasets from its definition, and their multiselect fields from each dataset', () => {
    expect(factsFromDefinition(draftWithDataset, given)).toEqual({
      service: 'byggesak',
      title: 'Byggesaksveileder',
      chat: true,
      datasets: [{ tenant: 'felles', key: 'byggeregler', filterFields: ['kommune', 'aar'] }],
      documents: false,
      variants: ['byggesak__standard'],
      channels: ['conversations', 'facets'],
    });
  });

  it('takes no filter fields from the definition, whose filters are the default values', () => {
    const facts = factsFromDefinition(draftWithDataset, { channels: given.channels });
    expect(facts?.datasets).toEqual([{ tenant: 'felles', key: 'byggeregler', filterFields: [] }]);
    expect(offerOf('filter', facts).unmet).toEqual(['service:filter-fields']);
  });

  it('counts only the variants a draft lets the reader pick in a chat', () => {
    expect(factsFromDefinition(draftWithDataset, given)?.variants).toEqual(['byggesak__standard']);
  });

  it('offers no Chat to a draft that is not exposed to a chat', () => {
    expect(factsFromDefinition(draftWithFields, given)?.chat).toBe(false);
    expect(draftOffered(draftWithFields)).not.toContain('chat');
  });

  it('offers Sources and Document view to a draft that reads attached documents, and no Filter', () => {
    const offered = draftOffered(draftWithDocuments);
    expect(offered).toContain('sources');
    expect(offered).toContain('document-view');
    expect(offered).not.toContain('filter');
  });

  it('names a draft by its name when it has no id yet, and finds a dataset without a tenant in its own', () => {
    const facts = factsFromDefinition(draftWithDocuments, given);
    expect(facts?.service).toBe('vedleggsleser');
    expect(facts?.datasets).toEqual([{ tenant: 'eksempel', key: 'notater', filterFields: [] }]);
  });

  it('offers no Feedback on a draft whose frontend is given no feedback channel', () => {
    const facts = factsFromDefinition(draftWithDataset, given);
    expect(optionOfferOf('chat', 'feedback', facts).unmet).toEqual(['channel:feedback']);
  });

  it('knows nothing of a draft without an id or a name', () => {
    expect(factsFromDefinition({ spec: { output: { kind: 'answer' } } }, given)).toBeUndefined();
    expect(modelRowsFromDefinition(undefined)).toEqual([]);
  });

  it('lists a draft as `/v1/models` rows, so the try view reads the same facts as the builder', () => {
    const rows = modelRowsFromDefinition(draftWithDataset, filtersOf);
    expect(rows.map((row) => row.id)).toEqual(['byggesak__standard', 'byggesak__kort']);
    expect(rows[0]?._datasets?.[0]?.filters?.[1]).toEqual({
      field: 'aar',
      kinds: ['multiselect', 'contains'],
      'value-type': 'integer',
    });
    expect(factsFromModels(rows, 'byggesak', given)).toEqual(
      factsFromDefinition(draftWithDataset, given),
    );
  });
});
