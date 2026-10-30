import { manifest, type FakeReply, type PluginRegistration } from '@genai/plugins';
import {
  embeddingContract,
  embeddingContractTarget,
  embeddingContractVersion,
  type EmbeddingContractFixture,
} from '@genai/port-embedding/contract';
import {
  modelContract,
  modelContractTarget,
  modelContractVersion,
  type ModelContractFixture,
  type ModelScenario,
} from '@genai/port-model/contract';
import { openAiChat, openAiEmbeddings } from './index.js';

const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

const failure = (status: number): FakeReply => ({
  status,
  json: { error: { message: `HTTP ${status}`, type: 'contract', code: null } },
});

const completion = (scenario: Exclude<ModelScenario, { kind: 'status' }>) => ({
  id: 'kontrakt',
  object: 'chat.completion',
  created: 0,
  model: 'contract-model-2026',
  choices: [
    {
      index: 0,
      message:
        scenario.kind === 'text'
          ? { role: 'assistant', content: scenario.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: scenario.id,
                  type: 'function',
                  function: { name: scenario.name, arguments: scenario.arguments },
                },
              ],
            },
      finish_reason: scenario.kind === 'text' ? 'stop' : 'tool_calls',
    },
  ],
  usage,
});

const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) => ({
  id: 'kontrakt',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'contract-model-2026',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

export const openAiChatFixture: ModelContractFixture = {
  adapter: openAiChat,
  basePath: '/v1',
  reply: (scenario, body) => {
    if (scenario.kind === 'status') return failure(scenario.status);
    if (body.stream !== true) return { status: 200, json: completion(scenario) };
    const text = scenario.kind === 'text' ? scenario.text : '';
    const half = Math.ceil(text.length / 2);
    return {
      status: 200,
      sse: [
        { data: chunk({ role: 'assistant', content: text.slice(0, half) }, null) },
        { data: chunk({ content: text.slice(half) }, 'stop') },
        { data: { ...chunk({}, null), choices: [], usage } },
        { data: '[DONE]' },
      ],
    };
  },
};

export const openAiResponsesFixture: ModelContractFixture = {
  adapter: openAiChat,
  basePath: '/v1',
  modelOptions: { api: 'responses' },
  reply: (scenario, body, path) => {
    if (path !== '/v1/responses' || body.store !== false || 'previous_response_id' in body)
      return failure(400);
    if (scenario.kind === 'status') return failure(scenario.status);
    const output =
      scenario.kind === 'tool'
        ? [
            {
              type: 'function_call',
              call_id: scenario.id,
              name: scenario.name,
              arguments: scenario.arguments,
            },
          ]
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: scenario.text, annotations: [] }],
            },
          ];
    const response = {
      id: 'contract-response',
      object: 'response',
      status: 'completed',
      model: 'contract-model-2026',
      output,
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    };
    if (body.stream !== true) return { status: 200, json: response };
    const text = scenario.kind === 'text' ? scenario.text : '';
    const half = Math.ceil(text.length / 2);
    return {
      status: 200,
      sse: [
        { data: { type: 'response.output_text.delta', delta: text.slice(0, half) } },
        { data: { type: 'response.output_text.delta', delta: text.slice(half) } },
        { data: { type: 'response.completed', response } },
      ],
    };
  },
};

export const openAiEmbeddingsFixture: EmbeddingContractFixture = {
  adapter: openAiEmbeddings,
  basePath: '/v1',
  inputs: (body) => (Array.isArray(body.input) ? body.input.map(String) : [String(body.input)]),
  vectors: (vectors, inputTokens) => ({
    status: 200,
    json: {
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: 'contract-embedder',
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
    },
  }),
  failure,
};

export const openAiPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'model',
      id: 'model.openai-chat',
      version: '1',
      contract: modelContractVersion,
      title: 'OpenAI-kompatibel chat',
      description:
        'Chat Completions and stateless Responses over OpenAI-compatible endpoints, also Azure AI Foundry.',
      capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
      configSchema: {
        type: 'object',
        properties: {
          api: { type: 'string', enum: ['chat-completions', 'responses'] },
          tokenParam: { type: 'string', enum: ['max_tokens', 'max_completion_tokens'] },
        },
      },
      secrets: ['api-key'],
    }),
    suite: modelContract,
    target: () => modelContractTarget(openAiChatFixture),
  } as PluginRegistration,
  {
    manifest: manifest({
      kind: 'embedding',
      id: 'embedding.openai-embeddings',
      version: '1',
      contract: embeddingContractVersion,
      title: 'OpenAI-kompatible embeddinger',
      description: 'Embeddings over the OpenAI-compatible protocol, also Azure AI Foundry.',
      capabilities: ['batch'],
      configSchema: {
        type: 'object',
        properties: { apiVersion: { type: 'string' }, sendDimensions: { type: 'boolean' } },
      },
      secrets: ['api-key'],
    }),
    suite: embeddingContract,
    target: () => embeddingContractTarget(openAiEmbeddingsFixture),
  } as PluginRegistration,
];
