import { manifest, type FakeReply, type PluginRegistration } from '@genai/plugins';
import {
  modelContract,
  modelContractTarget,
  modelContractVersion,
  type ModelContractFixture,
} from '@genai/port-model/contract';
import { anthropicMessages } from './index.js';

const usage = { input_tokens: 20, output_tokens: 9 };

const message = (content: unknown[], stopReason: string | null) => ({
  id: 'msg_kontrakt',
  type: 'message',
  role: 'assistant',
  model: 'contract-model-2026',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage,
});

const frame = (data: Record<string, unknown>) => ({ event: data.type as string, data });

const failure = (status: number): FakeReply => ({
  status,
  json: { type: 'error', error: { type: 'contract_error', message: `HTTP ${status}` } },
});

export const anthropicMessagesFixture: ModelContractFixture = {
  adapter: anthropicMessages,
  basePath: '/anthropic',
  reply: (scenario, body) => {
    if (scenario.kind === 'status') return failure(scenario.status);
    if (body.stream !== true)
      return {
        status: 200,
        json:
          scenario.kind === 'text'
            ? message([{ type: 'text', text: scenario.text }], 'end_turn')
            : message(
                [
                  {
                    type: 'tool_use',
                    id: scenario.id,
                    name: scenario.name,
                    input: JSON.parse(scenario.arguments) as unknown,
                  },
                ],
                'tool_use',
              ),
      };
    const text = scenario.kind === 'text' ? scenario.text : '';
    const half = Math.ceil(text.length / 2);
    return {
      status: 200,
      sse: [
        frame({ type: 'message_start', message: message([], null) }),
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text.slice(0, half) },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text.slice(half) },
        }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 9 },
        }),
        frame({ type: 'message_stop' }),
      ],
    };
  },
};

export const anthropicPlugins: PluginRegistration[] = [
  {
    manifest: manifest({
      kind: 'model',
      id: 'model.anthropic-messages',
      version: '1',
      contract: modelContractVersion,
      title: 'Anthropic Messages',
      description: 'Chat over the Anthropic Messages protocol, also through Azure AI Foundry.',
      capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
      configSchema: {
        type: 'object',
        properties: { defaultMaxTokens: { type: 'integer', minimum: 1 } },
      },
      secrets: ['api-key'],
    }),
    suite: modelContract,
    target: () => modelContractTarget(anthropicMessagesFixture),
  } as PluginRegistration,
];
