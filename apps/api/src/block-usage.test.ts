import { describe, expect, it } from 'vitest';
import type { ServiceDefinition } from '@genai/definitions';
import { serviceReferences } from './block-usage.js';

describe('block usage', () => {
  it('reads a service stored before tools and skills existed', () => {
    const stored = {
      apiVersion: 'genai/v1',
      kind: 'Service',
      metadata: { tenant: '991825827', id: 'gammel' },
      spec: {
        purpose: 'Svar med kilder',
        riskClass: 'minimal',
        input: { accepts: ['text/plain'] },
        output: { kind: 'answer' },
        strategy: { id: 'single-call', version: 1, config: {} },
        knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
        model: { primary: 'foundry/gpt', residency: 'global' },
      },
    } as unknown as ServiceDefinition;

    expect(serviceReferences(stored)).toEqual(
      expect.arrayContaining([
        { kind: 'model', id: 'foundry/gpt' },
        { kind: 'dataset', id: 'digdir/kudos' },
      ]),
    );
  });
});
