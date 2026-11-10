import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets } from '@genai/kernel';
import {
  applyParameterRules,
  ModelRouter,
  parameterRuleProblems,
  rejectedParameter,
  type ChatRequest,
  type ChatResult,
  type ModelAdapter,
  type ModelClassification,
} from './index.js';
import { testContext } from './testing.js';

const setup = (
  dropped?: ChatResult['droppedParameters'],
  priceOf?: ConstructorParameters<typeof ModelRouter>[0]['priceOf'],
) => {
  const seen: ChatRequest[] = [];
  const adapter: ModelAdapter = {
    apis: [
      {
        id: 'proto/chat@1',
        kind: 'chat',
        family: 'proto',
        modelOptions: z.strictObject({}),
        default: true,
      },
    ],
    connect: () => ({
      chat: async (_m, request) => {
        seen.push(request);
        return {
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
          servedModel: 'm',
          ...(dropped ? { droppedParameters: dropped } : {}),
        };
      },
      chatStream: async function* () {},
    }),
  };
  const saved: Record<string, ModelClassification> = {};
  const noticed: string[] = [];
  const router = new ModelRouter({
    catalog: {
      endpoints: {
        e: {
          baseURL: 'https://e.example',
          families: { proto: '' },
          auth: { kind: 'api-key', secret: 'secret://env/key' },
        },
      },
      models: [
        {
          id: 'e/m',
          endpoint: 'e',
          deployment: 'm',
          residency: 'eu',
          capabilities: ['stream', 'reasoning'],
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({ KEY: 'k' }),
    ...(priceOf ? { priceOf } : {}),
    classifications: {
      load: async () => structuredClone(saved),
      save: async (id, c) => {
        saved[id] = structuredClone(c);
      },
    },
    onParameterDropped: (model, parameter) => noticed.push(`${model}:${parameter}`),
  });
  const chat = (request: Partial<ChatRequest> = {}) =>
    router
      .open({ kind: 'model', id: 'e/m' }, testContext().ctx)
      .chat({ messages: [{ role: 'user', content: 'hei' }], ...request });
  return { router, seen, saved, noticed, chat };
};

describe('model parameter rules', () => {
  it('removes a parameter the operator marked unsupported before the provider sees it', async () => {
    const { router, seen, chat } = setup();
    await router.classify('e/m', { parameters: { temperature: { mode: 'unsupported' } } });

    await chat({ temperature: 0.7, maxTokens: 50 });

    expect(seen[0]).not.toHaveProperty('temperature');
    expect(seen[0]?.maxTokens).toBe(50);
  });

  it('sends the fixed value even when the service did not set the parameter', async () => {
    const { router, seen, chat } = setup();
    await router.classify('e/m', { parameters: { temperature: { mode: 'fixed', value: 1 } } });

    await chat();
    await chat({ temperature: 0.2 });

    expect(seen.map((r) => r.temperature)).toEqual([1, 1]);
  });

  it('describes the rules so the console and the service builder can show them', async () => {
    const { router } = setup();
    await router.classify('e/m', { parameters: { temperature: { mode: 'unsupported' } } });

    expect(router.describe()[0]?.parameters).toEqual({ temperature: { mode: 'unsupported' } });
    expect(router.open({ kind: 'model', id: 'e/m' }, testContext().ctx).info().parameters).toEqual({
      temperature: { mode: 'unsupported' },
    });
  });

  it('records a parameter the provider had to drop as a suggestion without changing the rules', async () => {
    const { router, saved, noticed, chat } = setup(['temperature']);

    await chat({ temperature: 0.1 });
    await chat({ temperature: 0.1 });

    const [model] = router.describe();
    expect(Object.keys(model?.rejectedParameters ?? {})).toEqual(['temperature']);
    expect(model?.parameters).toEqual({});
    expect(model?.classified).toBe(false);
    expect(saved['e/m']?.observed?.temperature).toBeDefined();
    expect(noticed).toEqual(['e/m:temperature']);
  });

  it('describes the price the catalog holds for a model so the console can show it', () => {
    const { router } = setup(undefined, () => ({
      inputPerThousand: 0.02,
      outputPerThousand: 0.08,
    }));

    expect(router.describe()[0]?.price).toEqual({
      inputPerThousand: 0.02,
      outputPerThousand: 0.08,
    });
  });

  it('does not mark the residency as confirmed when only a parameter rule is saved', async () => {
    const { router } = setup();

    await router.classify('e/m', { parameters: { temperature: { mode: 'unsupported' } } });
    await router.classify('e/m', { parameters: {} });

    expect(router.describe()[0]?.classified).toBe(false);
  });

  it('clears the suggestion once the operator sets a rule for that parameter', async () => {
    const { router, chat } = setup(['temperature']);
    await chat({ temperature: 0.1 });

    await router.classify('e/m', { parameters: { temperature: { mode: 'unsupported' } } });

    expect(router.describe()[0]?.rejectedParameters).toEqual({});
  });

  it('does not hand the dropped-parameter notice on to callers', async () => {
    const { chat } = setup(['temperature']);

    expect(await chat({ temperature: 0.1 })).not.toHaveProperty('droppedParameters');
  });

  it('rejects a fixed value the parameter cannot take', () => {
    expect(parameterRuleProblems({ temperature: { mode: 'fixed', value: 5 } })).toHaveLength(1);
    expect(parameterRuleProblems({ reasoning: { mode: 'fixed', value: 'max' } })).toHaveLength(1);
    expect(parameterRuleProblems({ reasoning: { mode: 'fixed', value: 'low' } })).toEqual([]);
  });

  it('leaves the request alone without rules', () => {
    const request = { messages: [], temperature: 0.3 };
    expect(applyParameterRules(request, undefined)).toBe(request);
  });
});

describe('rejected parameters', () => {
  const mistral = (detail: object[]) => `422 ${JSON.stringify({ detail })}`;

  it('reads a validation error that forbids max_completion_tokens as a refusal of that parameter', () => {
    const message = mistral([
      {
        type: 'extra_forbidden',
        loc: ['body', 'max_completion_tokens'],
        msg: 'Extra inputs are not permitted',
        input: 4000,
      },
    ]);
    expect(rejectedParameter(422, message)).toBe('max_completion_tokens');
  });

  it('reads the parameter an unsupported-parameter error names first as the refused one', () => {
    const message =
      "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
    expect(rejectedParameter(400, message)).toBe('max_tokens');
  });

  it('does not read a token refusal from a value error on the token limit next to a forbidden other field', () => {
    const message = mistral([
      {
        type: 'less_than_equal',
        loc: ['body', 'max_completion_tokens'],
        msg: 'Input should be less than or equal to 1000',
        input: 4000,
      },
      {
        type: 'extra_forbidden',
        loc: ['body', 'stream_options'],
        msg: 'Extra inputs are not permitted',
      },
    ]);
    expect(rejectedParameter(422, message)).toBeUndefined();
  });

  it('does not read a token refusal when the error names another parameter', () => {
    const message =
      "400 Unsupported parameter: 'reasoning_effort'. Use 'max_completion_tokens' without it.";
    expect(rejectedParameter(400, message, 'reasoning_effort')).toBeUndefined();
  });

  it('does not read a refusal from other statuses', () => {
    expect(rejectedParameter(500, "Unsupported parameter: 'max_tokens'.")).toBeUndefined();
  });

  it('reads a long run of braces and refusal words in linear time', () => {
    const started = performance.now();
    rejectedParameter(422, `${'}unknown max_'.repeat(50_000)}max_tokens`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
