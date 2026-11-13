import { describe, expect, it } from 'vitest';
import { blockIds } from './catalogue.js';
import {
  factsFromModels,
  needMet,
  offerOf,
  optionOfferOf,
  servicesIn,
  type Channel,
  type ModelRow,
} from './facts.js';
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
