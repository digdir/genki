import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type GateRecord } from '@genai/kernel';
import { ModelError, ModelRouter, type DecisionRequest } from '@genai/port-model';
import { fakeHttp, testContext, type FakeServer } from '@genai/port-model/testing';
import { droppedFields } from './decisions.js';
import { openAiChat } from './index.js';

interface Fixture {
  request: { model: string } & DecisionRequest;
  response: Record<string, unknown>;
}

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'decisions', `${name}.json`), 'utf8'),
  ) as Fixture;

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const serve = async (response: unknown, status = 200) => {
  const server = await fakeHttp(() => ({ status, json: response }));
  servers.push(server);
  return server;
};

const router = (url: string, operations = ['chat', 'decide']) =>
  new ModelRouter({
    catalog: {
      endpoints: {
        'foundry-openai': {
          protocol: 'openai-chat',
          baseURL: `${url}/openai/v1`,
          auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/test-key' },
        },
      },
      models: [
        {
          id: 'foundry-openai/gpt-6-luna',
          endpoint: 'foundry-openai',
          deployment: 'gpt-6-luna',
          residency: 'eu',
          capabilities: ['stream'],
          operations,
        },
      ],
    },
    adapters: [openAiChat],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
    priceOf: () => ({ inputPerThousand: 0.0011125, outputPerThousand: 0.0055624 }),
    maxRetries: 0,
  });

const opened = (r: ModelRouter) => {
  const { ctx, metered } = testContext();
  const audit: GateRecord[] = [];
  const port = r.decisions().open(
    { kind: 'model', id: 'foundry-openai/gpt-6-luna' },
    {
      ...ctx,
      audit: async (record) => {
        audit.push(record);
      },
    },
  );
  return { port, metered, audit };
};

const requestOf = ({ request }: Fixture): DecisionRequest => ({
  input: request.input,
  questions: request.questions,
});

describe('the decide operation on openai-chat', () => {
  for (const name of ['predicate', 'choice-and-score', 'refusal']) {
    it(`sends the documented ${name} request to /openai/v1/decisions and reads its answers`, async () => {
      const recorded = fixture(name);
      const { url, seen } = await serve(recorded.response);
      const { port } = opened(router(url));
      const result = await port.decide(requestOf(recorded));
      expect(seen[0]?.path).toBe('/openai/v1/decisions');
      expect(seen[0]?.headers['api-key']).toBe('test-key');
      expect(seen[0]?.body).toEqual(recorded.request);
      expect(result.answers).toEqual(recorded.response.answers);
      expect(result.calibrated).toBe(true);
    });
  }

  it('a decide call goes through the gate and is metered', async () => {
    const recorded = fixture('predicate');
    const { url } = await serve(recorded.response);
    const { port, metered, audit } = opened(router(url));
    await port.decide(requestOf(recorded));
    expect(metered).toEqual([
      {
        usage: { inputTokens: 162, outputTokens: 0, requests: 1, costMicroNok: 180 },
        model: { kind: 'model', id: 'foundry-openai/gpt-6-luna' },
      },
    ]);
    expect(audit).toEqual([
      {
        port: 'decision',
        operation: 'decide',
        model: 'foundry-openai/gpt-6-luna',
        endpoint: 'foundry-openai',
        residency: 'eu',
        outcome: 'ok',
        usage: { inputTokens: 162, outputTokens: 0, requests: 1, costMicroNok: 180 },
      },
    ]);
  });

  it('a refusal for a question is an answer, not an error', async () => {
    const recorded = fixture('refusal');
    const { url } = await serve(recorded.response);
    const { port, audit } = opened(router(url));
    const result = await port.decide(requestOf(recorded));
    expect(result.answers[1]).toEqual({ type: 'refusal', name: 'customer_lying' });
    expect(audit[0]?.outcome).toBe('ok');
  });

  it('an unknown field in a decide response is dropped and counted', async () => {
    const recorded = fixture('unknown-fields');
    const { url } = await serve(recorded.response);
    const { port, audit } = opened(router(url));
    const result = await port.decide(requestOf(recorded));
    expect(result.answers).toEqual([
      { type: 'predicate', name: 'refund_requested', probability: 0.95 },
    ]);
    expect(JSON.stringify(result)).not.toContain('decision_abc123');
    expect(audit[0]).toMatchObject({ outcome: 'ok', dropped: 3 });
  });

  it('an unknown field in a decide request is refused before it leaves', async () => {
    const recorded = fixture('predicate');
    const { url, seen } = await serve(recorded.response);
    for (const extra of [
      { previous_response_id: 'resp_123' },
      { image_url: 'https://example.com/photo.jpg' },
      { store: true },
    ]) {
      const { port, audit } = opened(router(url));
      const error = await port
        .decide({ ...requestOf(recorded), ...extra } as DecisionRequest)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).code).toBe('bad_request');
      expect(audit).toEqual([expect.objectContaining({ outcome: 'refused', refusal: 'shape' })]);
    }
    expect(seen).toHaveLength(0);
  });

  it('an image in decide input is refused before it leaves, so no URL reaches the provider', async () => {
    const { url, seen } = await serve(fixture('predicate').response);
    const { port, audit } = opened(router(url));
    const error = await port
      .decide({
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://contoso.com/photo2.jpg' }],
          },
        ],
        questions: [{ type: 'predicate', name: 'damage', instructions: 'Is it damaged?' }],
      } as unknown as DecisionRequest)
      .catch((e: unknown) => e);
    expect((error as ModelError).code).toBe('refused');
    expect(audit[0]).toMatchObject({ outcome: 'refused', refusal: 'media' });
    expect(seen).toHaveLength(0);
  });

  it('a model without the decide operation refuses decide as unsupported', async () => {
    const { url, seen } = await serve(fixture('predicate').response);
    const { port } = opened(router(url, ['chat']));
    const error = await port.decide(requestOf(fixture('predicate'))).catch((e: unknown) => e);
    expect((error as ModelError).code).toBe('unsupported');
    expect(seen).toHaveLength(0);
  });

  it('a response whose answers do not match the questions fails as unavailable', async () => {
    const recorded = fixture('predicate');
    const { url } = await serve({
      ...recorded.response,
      answers: [{ type: 'predicate', name: 'something_else', probability: 0.5 }],
    });
    const { port, audit } = opened(router(url));
    const error = await port.decide(requestOf(recorded)).catch((e: unknown) => e);
    expect((error as ModelError).code).toBe('unavailable');
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('counts every field the closed shape does not keep, at any depth', () => {
    expect(
      droppedFields({ a: 1, b: { c: 1, d: [{ e: 1, f: 2 }] } }, { a: 1, b: { d: [{ e: 1 }] } }),
    ).toBe(2);
  });
});
