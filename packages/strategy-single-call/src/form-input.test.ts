import { describe, expect, it } from 'vitest';
import { formTextPart, textPart, type Input, type Principal } from '@genai/contracts';
import { createKernel, type PortProvider } from '@genai/kernel';
import type { ChatRequest, ModelPort } from '@genai/port-model';
import { singleCall, type SingleCallRuntimeConfig } from './index.js';

const tenant = '999888777';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const config: SingleCallRuntimeConfig = {
  strategy: { instructions: 'Vurder kort.' },
  output: { kind: 'answer' },
  model: { primary: 'foundry/gpt-4o' },
};

const userPrompt = async (input: Input) => {
  const seen: ChatRequest[] = [];
  const provider: PortProvider<ModelPort> = {
    open: (ref) => ({
      info: () => ({ id: ref.id, residency: 'norway', capabilities: [] }),
      chat: async (request) => {
        seen.push(request);
        return {
          content: 'Vurdert.',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
          servedModel: ref.id,
        };
      },
      chatStream: async function* () {
        yield* [];
        throw new Error('not streamed');
      },
    }),
  };
  const kernel = createKernel({
    strategies: [singleCall],
    capabilities: [
      {
        descriptor: {
          id: 'svc',
          version: '1',
          tenant,
          title: 'svc',
          description: 'svc',
          input: {},
          interaction: ['unary'],
          accepts: [],
          produces: [],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
        },
        strategy: { id: 'single-call', version: '1' },
        config,
        grants: [{ port: 'model', ref: { kind: 'model', id: 'foundry/gpt-4o', tenant } }],
      },
    ],
    ports: { model: provider },
    policy: { decide: async () => ({ allow: true }) },
  });
  await (
    await kernel.invoke(kari, 'svc', input)
  ).result;
  return seen[0]?.messages.at(-1)?.content;
};

const lines = 'Departement: Kunnskapsdepartementet\nVirksomhet: Udir';

describe('single-call with form input', () => {
  it('sends the labelled lines once, without the form values as JSON', async () => {
    expect(
      await userPrompt({
        data: { ministry: 'Kunnskapsdepartementet', agency: 'Udir', query: lines },
        parts: [formTextPart(lines)],
      }),
    ).toBe(lines);
  });

  it('still appends data as JSON for callers that send data without a form', async () => {
    expect(
      await userPrompt({ data: { query: 'Hei', ref: 'sak-1' }, parts: [textPart('Hei')] }),
    ).toBe('Hei\n\n{"query":"Hei","ref":"sak-1"}');
  });
});
