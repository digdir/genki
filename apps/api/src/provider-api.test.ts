import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { bootPlatform, digdir } from './testkit.js';

const streamYaml = readFileSync(
  join(
    import.meta.dirname,
    '../../../packages/operations/src/testdata/descriptors/example/stream-events@1.yaml',
  ),
  'utf8',
);

const caller: Principal = {
  kind: 'agency-system',
  issuer: 'test',
  subject: 'saksbehandling',
  tenant: digdir,
  scopes: ['legacy:query'],
};

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  saksbehandling: caller,
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reason = 'Tjenesten strømmer svar';

const pieces = (text: string, width: number) =>
  Array.from({ length: Math.ceil(text.length / width) }, (_, i) =>
    text.slice(i * width, (i + 1) * width),
  );

const boot = async () => {
  const server = await fakeHttp((body) => ({
    status: 200,
    sse: [
      ...pieces(String(body.question), 4).map((text) => ({ event: 'token', data: { text } })),
      { event: 'stats', data: { input: 5, output: 2 } },
      { event: 'finished', data: {} },
    ],
  }));
  servers.push(server);
  const booted = await bootPlatform({
    people,
    descriptors: descriptorRegistry([...loadDescriptors().list(), parseDescriptor(streamYaml)]),
    models: {
      endpoints: {
        lab: {
          families: { example: '' },
          baseURL: `${server.url}/v1`,
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
        },
      },
      models: [
        {
          id: 'lab/small',
          endpoint: 'lab',
          deployment: 'small',
          residency: 'norway',
          capabilities: ['json-schema'],
          operations: ['chat', 'stream-events'],
        },
      ],
    },
  });
  expect(
    (
      await booted.send('/operator/operation-kinds/stream-events/maturity', 'drift', {
        body: { maturity: 'production' },
        reason,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await booted.send('/operator/model-endpoints/lab/processor-record', 'drift', {
        method: 'PUT',
        reason,
        body: {
          agreement: 'DPA-2026-17, signed 2026-09-01',
          subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
          retention: { days: 0, note: 'No abuse monitoring' },
        },
      })
    ).status,
  ).toBe(200);
  return { ...booted, server };
};

const publish = async (booted: Awaited<ReturnType<typeof boot>>, restore: boolean) => {
  const flowed = await booted.platform.definitions.publish(
    {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: digdir, id: 'strom', name: 'Strøm' },
      spec: {
        purpose: 'Strøm et svar',
        input: { query: 'tekst' },
        steps: [
          {
            id: 'say',
            name: 'Svar',
            block: 'call-operation@1',
            params: { descriptor: 'example/stream-events@1', stream: true },
            input: { question: '{{input.query}}' },
          },
          {
            id: 'answer',
            name: 'Svar',
            block: 'answer@1',
            input: { text: '{{steps.say.output.result.answer}}' },
          },
        ],
      },
    },
    'test',
    'test',
  );
  expect(flowed.ok ? [] : flowed.errors).toEqual([]);
  const published = await booted.platform.definitions.publish(
    {
      apiVersion: 'genai/v1',
      kind: 'Service',
      metadata: { tenant: digdir, id: 'strom', name: 'Strøm' },
      spec: {
        purpose: 'Strøm svar til saksbehandlere',
        audience: ['employees'],
        riskClass: 'minimal',
        input: { accepts: ['text/plain'] },
        output: { kind: 'answer' },
        strategy: { id: 'step-flow', version: 1, config: { flow: 'strom@1' } },
        model: { primary: 'lab/small', residency: 'norway' },
        guardrails: { 'pii-before-model': { categories: ['national-id'], restore } },
        exposure: { rest: true, openai: true },
      },
    },
    'test',
    'test',
  );
  expect(published.ok ? [] : published.errors).toEqual([]);
};

const streamedText = (raw: string) =>
  raw
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] })
    .map((c) => c.choices?.[0]?.delta?.content ?? '')
    .join('');

describe('a streamed descriptor step on /v1/chat/completions (B)', () => {
  const ask = async (booted: Awaited<ReturnType<typeof boot>>, content: string) => {
    const response = await booted.send('/v1/chat/completions', 'saksbehandling', {
      body: { model: 'strom__default', stream: true, messages: [{ role: 'user', content }] },
    });
    return { response, text: await response.text() };
  };

  it('the text deltas of the provider stream reach the answer stream as they come', async () => {
    const booted = await boot();
    await publish(booted, true);
    const { response, text } = await ask(booted, 'Hei, hvordan går det med deg i dag?');
    expect(response.status).toBe(200);
    expect(streamedText(text)).toContain('Hei, hvordan går det');
    const deltas = text.split('\n').filter((l) => l.startsWith('data: {"'));
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it('a national id never reaches the provider, and the gate restores it across the events of the stream', async () => {
    const booted = await boot();
    await publish(booted, true);
    const { text } = await ask(booted, `Mitt fødselsnummer er ${syntheticNationalId} takk`);
    const seen = JSON.stringify(booted.server.seen.map((s) => s.body));
    expect(seen).not.toContain(syntheticNationalId);
    expect(streamedText(text)).toContain(syntheticNationalId);
  });
});
