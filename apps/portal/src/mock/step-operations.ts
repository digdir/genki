import type { StepOperation } from '../data/step-operations';

export const exampleStepOperations: StepOperation[] = [
  {
    id: 'example/generate-image@1',
    operation: 'generate-image',
    summary: 'Lager et bilde ut fra en tekst som beskriver det.',
    status: 'described',
    input: [
      { name: 'prompt', type: 'text', required: true },
      { name: 'size', type: 'choice', required: false, values: ['small', 'large'] },
    ],
    media: ['image/png'],
    models: [
      {
        id: 'aivar/borealis-27b',
        name: 'Borealis-27B',
        residency: 'norway',
        processorRecord: true,
      },
      {
        id: 'foundry-openai/gpt-4.1',
        name: 'GPT-4.1',
        residency: 'eu',
        processorRecord: false,
      },
    ],
  },
];

export const examplePng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
