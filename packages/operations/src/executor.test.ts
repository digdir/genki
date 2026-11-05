import { describe, expect, it } from 'vitest';
import type { Usage } from '@genai/contracts';
import { createGate, GateError, type GateRecord, type PortContext } from '@genai/kernel';
import { parseDescriptor } from './descriptor.js';
import { describedCall, OperationError, type WireExchange } from './executor.js';

const classifyYaml = `
id: example/classify@1
operation: classify
status: review
summary: A made-up classification API, used to try a new kind.
api:
  family: openai
  version: 2026-10-01
  headers:
    example-beta: classify-2026-10-01
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
    labels: $input.labels
input:
  object:
    text: text
    labels: [plain]
output:
  object:
    label: plain
    score: { number: { min: 0, max: 1 } }
wire:
  request:
    object:
      model: plain
      text: text
      labels: [plain]
  response:
    object:
      model?: plain
      label: plain
      score: { number: { min: 0, max: 1 } }
      usage:
        object:
          input_tokens: { number: { integer: true, min: 0 } }
result:
  label: $response.label
  score: $response.score
usage:
  inputTokens: $response.usage.input_tokens
  requests: 1
stream: none
`;

const classify = parseDescriptor(classifyYaml);

const answer = { model: 'small', label: 'billing', score: 0.9, usage: { input_tokens: 12 } };

const setup = (
  reply: unknown = answer,
  status = 200,
  extra: { guards?: PortContext['guards']; observe?: (e: WireExchange) => void } = {},
) => {
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(reply), { status });
  };
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'ola' },
    task: 't1',
    signal: new AbortController().signal,
    meter: async (usage) => {
      metered.push(usage);
    },
    audit: async (record) => {
      audit.push(record);
    },
    ...(extra.guards ? { guards: extra.guards } : {}),
  };
  const call = (input: unknown) =>
    describedCall(
      {
        gate: createGate(),
        ctx,
        target: {
          port: 'operation',
          operation: classify.operation,
          model: { kind: 'model', id: 'lab/small' },
          endpoint: 'lab',
          residency: 'eu',
          admission: 'admitted',
        },
        descriptor: classify,
        endpoint: {
          baseURL: 'https://models.example.test/v1/',
          credential: { kind: 'api-key', header: 'api-key', key: async () => 'secret-key' },
          fetch: fetcher,
        },
        deployment: 'small',
        ...(extra.observe ? { observe: extra.observe } : {}),
      },
      input,
    );
  return { call, sent, audit, metered };
};

describe('the descriptor executor', () => {
  it('a descriptor call goes through the gate and is metered and audited', async () => {
    const { call, sent, audit, metered } = setup();
    const result = await call({ text: 'I was charged twice', labels: ['billing', 'other'] });
    expect(result).toEqual({ label: 'billing', score: 0.9 });
    expect(sent).toEqual([
      {
        url: 'https://models.example.test/v1/classifications',
        headers: expect.objectContaining({
          'api-key': 'secret-key',
          'example-beta': 'classify-2026-10-01',
          'content-type': 'application/json',
        }) as Record<string, string>,
        body: { model: 'small', text: 'I was charged twice', labels: ['billing', 'other'] },
      },
    ]);
    expect(metered).toEqual([{ inputTokens: 12, requests: 1 }]);
    expect(audit).toEqual([
      {
        port: 'operation',
        operation: 'classify',
        model: 'lab/small',
        endpoint: 'lab',
        descriptor: 'example/classify@1',
        residency: 'eu',
        outcome: 'ok',
        usage: { inputTokens: 12, requests: 1 },
      },
    ]);
  });

  it('an unknown response field from a descriptor call is dropped and counted', async () => {
    const { call, audit } = setup({ ...answer, id: 'cls_123', reasoning: 'because' });
    const result = await call({ text: 'x', labels: ['a'] });
    expect(result).toEqual({ label: 'billing', score: 0.9 });
    expect(JSON.stringify(result)).not.toContain('cls_123');
    expect(audit[0]).toMatchObject({ outcome: 'ok', dropped: 2 });
  });

  it('an input field the descriptor shape does not allow is refused before anything leaves', async () => {
    const { call, sent, audit } = setup();
    const error = await call({ text: 'x', labels: ['a'], store: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateError);
    expect((error as GateError).refusal).toBe('shape');
    expect(sent).toEqual([]);
    expect(audit[0]).toMatchObject({ outcome: 'refused', refusal: 'shape' });
  });

  it('a descriptor call refuses image, audio and file content', async () => {
    const { call, sent } = setup();
    const error = await call({
      text: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      labels: ['a'],
    }).catch((e: unknown) => e);
    expect((error as GateError).refusal).toBe('media');
    expect(sent).toEqual([]);
  });

  it('an answer outside the wire shape fails the call', async () => {
    const { call, audit } = setup({ label: 'billing', score: 7, usage: { input_tokens: 1 } });
    await expect(call({ text: 'x', labels: ['a'] })).rejects.toThrow(/outside its wire shape/);
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('a provider error status reaches the caller with its status', async () => {
    const { call, audit } = setup({ error: { message: 'slow down' } }, 429);
    const error = await call({ text: 'x', labels: ['a'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ status: 429, message: 'slow down' });
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('an observed call records the exchange as the masked input and the raw answer', async () => {
    const seen: WireExchange[] = [];
    const masker = { mask: (t: string) => t.replaceAll('kari@example.no', '[EMAIL]') };
    const { call } = setup({ ...answer, id: 'cls_1' }, 200, {
      guards: [{ masker }],
      observe: (e) => seen.push(e),
    });
    await call({ text: 'Skriv til kari@example.no', labels: ['a'] });
    expect(seen).toEqual([
      {
        deployment: 'small',
        input: { text: 'Skriv til [EMAIL]', labels: ['a'] },
        request: {
          method: 'POST',
          path: '/classifications',
          body: { model: 'small', text: 'Skriv til [EMAIL]', labels: ['a'] },
        },
        response: { status: 200, body: { ...answer, id: 'cls_1' } },
        result: { label: 'billing', score: 0.9 },
        usage: { inputTokens: 12, requests: 1 },
        dropped: 1,
      },
    ]);
  });
});
