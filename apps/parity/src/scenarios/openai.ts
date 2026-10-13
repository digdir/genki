import { toolName } from '../scope.js';
import type { Scenario } from '../types.js';

const chat = (stream: boolean, model: string) => ({
  method: 'POST' as const,
  path: '/v1/chat/completions',
  body: {
    model,
    stream,
    messages: [{ role: 'user', content: 'Hva sier evalueringene om digitalisering i staten?' }],
  },
});

export const openAiScenarios: Scenario[] = [
  {
    id: 'v1.models',
    title: '/v1/models lists agent and mode pairs with the fields KA parses',
    steps: [
      { name: 'models', mode: 'exact', request: () => ({ method: 'GET', path: '/v1/models' }) },
    ],
  },
  {
    id: 'v1.no-key',
    title: '/v1/models without a key is 401 in the OpenAI error format',
    steps: [
      {
        name: 'no-key',
        mode: 'exact',
        request: () => ({ method: 'GET', path: '/v1/models', auth: false }),
      },
    ],
  },
  {
    id: 'v1.unknown-model',
    title: 'an unknown model is refused with model_not_found',
    steps: [
      { name: 'unknown', mode: 'exact', request: () => chat(false, 'no.such-agent__nothing') },
    ],
  },
  {
    id: 'v1.chat',
    title: 'a blocking chat completion answers',
    needs: ['dataset', 'llm'],
    steps: [
      { name: 'chat', mode: 'shape', request: (_, side) => chat(false, toolName('agent', side)) },
    ],
  },
  {
    id: 'v1.chat-stream',
    title: 'a streaming chat completion sends the answer and [DONE]',
    needs: ['dataset', 'llm'],
    steps: [
      {
        name: 'chat-stream',
        mode: 'shape',
        request: (_, side) => chat(true, toolName('agent', side)),
      },
    ],
  },
];
