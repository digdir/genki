import { describe, expect, it } from 'vitest';
import { flowDatasetProblems, missingDatasetProblems } from './dataset-needs.js';
import type { ServiceDefinition, StepFlowDefinition } from './schema.js';

const service = (
  datasets: string[],
  variants: ServiceDefinition['spec']['variants'] = ['default'],
): ServiceDefinition =>
  ({
    kind: 'Service',
    metadata: { tenant: '991825827', id: 's' },
    spec: {
      strategy: { id: 'agent-loop', version: 1, config: {} },
      variants,
      knowledge: { datasets: datasets.map((dataset) => ({ dataset })) },
    },
  }) as unknown as ServiceDefinition;

const flow = {
  kind: 'StepFlow',
  spec: {
    steps: [
      {
        id: 'loop',
        repeat: { until: 'x', max: 2, steps: [{ id: 'sok', block: 'retrieve@1' }] },
      },
      { id: 'skriv', block: 'template@1' },
    ],
  },
} as unknown as StepFlowDefinition;

const rag = (s: { id: string }) => s.id === 'rag-single-shot';
const retrieve = (block: string) => block === 'retrieve@1';

describe('services that need a dataset', () => {
  it('an agent-loop service without a dataset has no dataset problem', () => {
    expect(missingDatasetProblems(service([]), rag)).toEqual([]);
  });

  it('a variant that runs a rag strategy without a dataset is a problem', () => {
    const variants = [
      'default',
      { id: 'rag', strategy: { id: 'rag-single-shot', version: 1, config: {} } },
    ] as unknown as ServiceDefinition['spec']['variants'];

    expect(missingDatasetProblems(service([], variants), rag)).toEqual([
      {
        path: 'spec.variants[1].strategy',
        message: 'rag-single-shot searches a dataset, and spec.knowledge.datasets is empty',
      },
    ]);
    expect(missingDatasetProblems(service(['kudos'], variants), rag)).toEqual([]);
  });

  it('a flow step nested in a loop that searches needs a dataset', () => {
    expect(flowDatasetProblems(service([]), flow, 'f@1', retrieve)).toEqual([
      {
        path: 'spec.knowledge.datasets',
        message:
          'the step flow f@1 searches a dataset in step sok (retrieve@1), and spec.knowledge.datasets is empty',
      },
    ]);
    expect(flowDatasetProblems(service(['kudos']), flow, 'f@1', retrieve)).toEqual([]);
  });
});
