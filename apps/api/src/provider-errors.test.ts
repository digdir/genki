import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Principal } from '@genai/contracts';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir } from './testkit.js';
import { toTimeline } from './timeline.js';

const replyYaml = (id: string, output: string, result: string) => `
id: example/${id}@1
operation: ${id}
status: described
summary: A made-up API that answers a question.
api:
  family: example
  version: '2026-11-01'
request:
  method: POST
  path: /${id}
  body:
    model: $deployment
    question: $input.question
input:
  object:
    question: text
output: ${output}
wire:
  request:
    object:
      model: plain
      question: text
  response:
    object:
      text: text
result: ${result}
usage:
  requests: 1
stream: none
`;

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

const reason = 'Tjenesten svarer med tekst';
const key = 'lab-key-4f9c2e7a1b';

const boot = async (reply: () => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  const booted = await bootPlatform({
    people,
    fakeKey: key,
    descriptors: descriptorRegistry([
      ...loadDescriptors().list(),
      parseDescriptor(replyYaml('reply', '{ object: { text: text } }', '{ text: $response.text }')),
      parseDescriptor(replyYaml('say', 'text', '$response.text')),
    ]),
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
          operations: ['chat', 'reply', 'say'],
        },
      ],
    },
  });
  for (const kind of ['reply', 'say'])
    expect(
      (
        await booted.send(`/operator/operation-kinds/${kind}/maturity`, 'drift', {
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
  return booted;
};

type Booted = Awaited<ReturnType<typeof boot>>;

const publish = async (booted: Booted, descriptor: string) => {
  const id = descriptor.replace(/^example\/|@1$/g, '');
  const flowed = await booted.platform.definitions.publish(
    {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: digdir, id, name: 'Svar' },
      spec: {
        purpose: 'Svar på et spørsmål',
        input: { query: 'tekst' },
        steps: [
          {
            id: 'svar',
            name: 'Svar',
            block: 'call-operation@1',
            params: { descriptor },
            input: { question: '{{input.query}}' },
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
      metadata: { tenant: digdir, id, name: 'Svar' },
      spec: {
        purpose: 'Svar til saksbehandlere',
        audience: ['employees'],
        riskClass: 'minimal',
        input: { accepts: ['text/plain'] },
        output: { kind: 'answer' },
        strategy: { id: 'step-flow', version: 1, config: { flow: `${id}@1` } },
        model: { primary: 'lab/small', residency: 'norway' },
        guardrails: { 'pii-before-model': { categories: ['national-id'], restore: true } },
        exposure: { rest: true, openai: true },
      },
    },
    'test',
    'test',
  );
  expect(published.ok ? [] : published.errors).toEqual([]);
  return `${id}__default`;
};

const ask = async (booted: Booted, model: string) => {
  const response = await booted.send('/v1/chat/completions', 'saksbehandling', {
    body: { model, messages: [{ role: 'user', content: 'Hva er klokka?' }] },
  });
  return { task: response.headers.get('genai-task') ?? '', text: await response.text() };
};

const failedRun = async ({ platform }: Booted, model: string) => {
  const started = await platform.kernel.invoke(caller, `${digdir}/${model.replace('__', '/')}`, {
    data: { query: 'Hva er klokka?' },
  });
  await started.result.catch(() => undefined);
  return started.task;
};

const eventsOf = async ({ platform }: Booted, task: string, audit = true) => {
  const events: Event[] = [];
  for await (const e of await platform.kernel.events(
    audit ? { kind: 'operator', issuer: 'platform', subject: 'audit-reader' } : caller,
    task,
    audit ? { audience: 'audit' } : {},
  ))
    events.push(e);
  return events;
};

const errorOf = (events: Event[], audience?: 'audit') =>
  events.find((e) => e.type === 'kernel.error' && e.audience === audience)?.data;

describe('a provider error on a call-operation step', () => {
  const outage = 'upstream connect error or disconnect/reset before headers';

  it("keeps the provider's status and plain-text error body for the audit, and the client sees only that the service failed", async () => {
    const booted = await boot(() => ({ status: 503, text: outage }));
    const model = await publish(booted, 'example/reply@1');
    expect((await ask(booted, model)).text).not.toContain('upstream');
    const task = await failedRun(booted, model);
    expect(errorOf(await eventsOf(booted, task, false))).toEqual({
      code: 'strategy_error',
      message: 'the service failed',
    });
    expect(errorOf(await eventsOf(booted, task), 'audit')).toEqual({
      code: 'strategy_error',
      message: 'step svar failed: the model is unavailable',
      provider: { status: 503, body: outage },
    });
  });

  it('a plain-text error body on a 4xx answer is the error message for the audit', async () => {
    const booted = await boot(() => ({ status: 400, text: 'question is too long' }));
    const task = await failedRun(booted, await publish(booted, 'example/reply@1'));
    expect(errorOf(await eventsOf(booted, task), 'audit')).toMatchObject({
      message: 'step svar failed: question is too long',
      provider: { status: 400, body: 'question is too long' },
    });
  });

  it('keeps the error body of a refused credential without the key, cut at 500 characters', async () => {
    const booted = await boot(() => ({
      status: 401,
      json: { error: { message: `key ${key} is not valid here` }, padding: 'x'.repeat(900) },
    }));
    const task = await failedRun(booted, await publish(booted, 'example/reply@1'));
    const provider = (errorOf(await eventsOf(booted, task), 'audit') as { provider: never })
      .provider as { status: number; body: string };
    expect(provider.status).toBe(401);
    expect(provider.body).toHaveLength(500);
    expect(provider.body).toContain('key [redacted] is not valid here');
    expect(JSON.stringify(await eventsOf(booted, task))).not.toContain(key);
  });

  it("the run timeline shows the provider's status and error body only to those who manage the service", async () => {
    const booted = await boot(() => ({ status: 503, text: outage }));
    const task = await failedRun(booted, await publish(booted, 'example/reply@1'));
    const run = await booted.platform.kernel.task(caller, task);
    const events = await eventsOf(booted, task);
    const timeline = (details: boolean) =>
      toTimeline(run, events, new Date('2026-11-10T10:00:00Z'), undefined, { details });
    expect(timeline(true).steps.find((s) => s.type === 'error')?.blocks).toContainEqual({
      kind: 'quote',
      label: 'Leverandøren svarte 503',
      text: outage,
    });
    const plain = timeline(false);
    expect(JSON.stringify(plain)).not.toContain('upstream');
  });
});

describe('a flow that ends on a non-streamed call-operation step', () => {
  const answer = 'Klokka er tolv.';
  const contentOf = (text: string) =>
    (JSON.parse(text) as { choices: { message: { content: string } }[] }).choices[0]?.message
      .content;

  it('answers with the text field of the result, not its JSON', async () => {
    const booted = await boot(() => ({ status: 200, json: { text: answer } }));
    const { text } = await ask(booted, await publish(booted, 'example/reply@1'));
    expect(contentOf(text)).toBe(answer);
  });

  it('answers with the result when the result is text', async () => {
    const booted = await boot(() => ({ status: 200, json: { text: answer } }));
    const { text } = await ask(booted, await publish(booted, 'example/say@1'));
    expect(contentOf(text)).toBe(answer);
  });
});
