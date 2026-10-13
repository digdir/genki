import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { textPart, type Event, type Principal } from '@genai/contracts';
import { serviceDefinition, toCapabilities } from '@genai/definitions';
import { createKernel, type Capability, type PortProvider } from '@genai/kernel';
import {
  ModelError,
  type Capability as ModelCapability,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from '@genai/port-model';
import { singleCall, singleCallConfig, type SingleCallRuntimeConfig } from './index.js';

const examples = join(import.meta.dirname, '..', '..', 'definitions', 'examples');
const definitions = readdirSync(examples)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => ({ file: f, parsed: parseYaml(readFileSync(join(examples, f), 'utf8')) as unknown }))
  .filter(({ parsed }) => (parsed as { kind?: string }).kind !== 'StepFlow')
  .map(({ file, parsed }) => ({ file, definition: serviceDefinition.parse(parsed) }))
  .filter(({ definition }) => definition.spec.strategy.id === 'single-call');

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '999888777' };

const answer = (content: string): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 4, outputTokens: 2, requests: 1 },
  servedModel: 'served',
});

type Script = (request: ChatRequest, signal: AbortSignal) => Promise<ChatResult>;

const models = (
  scripts: Record<string, { script: Script; capabilities?: ModelCapability[]; deltas?: string[] }>,
) => {
  const seen: { model: string; request: ChatRequest; streamed: boolean }[] = [];
  const provider: PortProvider<ModelPort> = {
    open: (ref, ctx) => {
      const entry = scripts[ref.id];
      if (!entry) throw new Error(`no model ${ref.id}`);
      return {
        info: () => ({ id: ref.id, residency: 'norway', capabilities: entry.capabilities ?? [] }),
        chat: async (request) => {
          seen.push({ model: ref.id, request, streamed: false });
          const result = await entry.script(request, ctx.signal);
          await ctx.meter(result.usage, ref);
          return result;
        },
        chatStream: async function* (request) {
          seen.push({ model: ref.id, request, streamed: true });
          for (const text of entry.deltas ?? []) yield { kind: 'delta' as const, text };
          yield { kind: 'done' as const, result: await entry.script(request, ctx.signal) };
        },
      };
    },
  };
  return { provider, seen };
};

const capability = (config: SingleCallRuntimeConfig): Capability => ({
  descriptor: {
    id: 'svc',
    version: '1',
    tenant: '999888777',
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
  grants: [
    { port: 'model', ref: { kind: 'model', id: config.model.primary, tenant: '999888777' } },
    ...(config.model.fallback
      ? [{ port: 'model', ref: { kind: 'model', id: config.model.fallback, tenant: '999888777' } }]
      : []),
  ],
});

const kernelFor = (config: SingleCallRuntimeConfig, provider: PortProvider<ModelPort>) =>
  createKernel({
    strategies: [singleCall],
    capabilities: [capability(config)],
    ports: { model: provider },
    policy: { decide: async () => ({ allow: true }) },
  });

const collect = async (events: AsyncIterable<Event>) => {
  const out: Event[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const answerConfig: SingleCallRuntimeConfig = {
  strategy: { instructions: 'Skriv kort.', temperature: 0.2, maxTokens: 200, reasoning: 'low' },
  output: { kind: 'answer' },
  model: { primary: 'foundry/gpt-4o', fallback: 'aivar/borealis' },
};

const fieldsConfig: SingleCallRuntimeConfig = {
  strategy: { instructions: 'Hent ut feltene.' },
  output: {
    kind: 'fields',
    fields: [
      { name: 'applicant', type: 'string', description: 'Søker' },
      { name: 'amount', type: 'number', description: 'Beløp' },
      { name: 'missing', type: 'list', description: 'Mangler' },
    ],
  },
  model: { primary: 'foundry/gpt-4o' },
};

describe('single-call config', () => {
  it.each(definitions.map((d) => [d.file, d.definition] as const))(
    'accepts the strategy config of %s',
    (_file, definition) => {
      expect(singleCallConfig.safeParse(definition.spec.strategy.config).success).toBe(true);
    },
  );

  it('refuses config keys it does not know', () => {
    expect(singleCallConfig.safeParse({ instructions: 'x', tools: [] }).success).toBe(false);
  });
});

describe('single-call strategy', () => {
  it('answers with one call, passing instructions, input and generation options to the model', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': { script: async () => answer('Kort svar.') },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('Hva er klarspråk?')] });

    expect(await run.result).toEqual([textPart('Kort svar.')]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toEqual({
      purpose: 'answer',
      messages: [
        { role: 'system', content: 'Skriv kort.' },
        { role: 'user', content: 'Hva er klarspråk?' },
      ],
      temperature: 0.2,
      maxTokens: 200,
      reasoning: 'low',
    });
    expect((await kernel.task(kari, run.task)).usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      requests: 1,
    });
  });

  it('streams text deltas when the model can stream', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => answer('Første avsnitt.'),
        capabilities: ['stream'],
        deltas: ['Første ', 'avsnitt.'],
      },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });
    const events = await collect(run.events);

    expect(events.filter((e) => e.type === 'kernel.part.delta').map((e) => e.data)).toEqual([
      { text: 'Første ' },
      { text: 'avsnitt.' },
    ]);
    expect(await run.result).toEqual([textPart('Første avsnitt.')]);
    expect(seen[0]?.streamed).toBe(true);
  });

  it('asks for structured output and returns the fields as a JSON part', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => answer('{"applicant":"Ola AS","amount":125000,"missing":["budsjett"]}'),
        capabilities: ['stream', 'json-schema'],
      },
    });
    const kernel = kernelFor(fieldsConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('Søknad fra Ola AS ...')] });

    expect(await run.result).toEqual([
      {
        mime: 'application/json',
        body: {
          kind: 'json',
          json: { applicant: 'Ola AS', amount: 125000, missing: ['budsjett'] },
        },
      },
    ]);
    expect(seen[0]?.streamed).toBe(false);
    expect(seen[0]?.request.jsonSchema).toEqual({
      name: 'fields',
      schema: {
        type: 'object',
        properties: {
          applicant: { type: 'string', description: 'Søker' },
          amount: { type: 'number', description: 'Beløp' },
          missing: { type: 'array', items: { type: 'string' }, description: 'Mangler' },
        },
        required: ['applicant', 'amount', 'missing'],
        additionalProperties: false,
      },
    });
  });

  it('lets the model leave an optional field empty with null, and asks for every required one', async () => {
    const optional: SingleCallRuntimeConfig = {
      ...fieldsConfig,
      output: {
        kind: 'fields',
        fields: [
          { name: 'applicant', type: 'string', description: 'Søker' },
          { name: 'missing', type: 'list', description: 'Mangler', required: false },
        ],
      },
    };
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => answer('{"applicant":"Ola AS","missing":null}'),
        capabilities: ['stream', 'json-schema'],
      },
    });
    const kernel = kernelFor(optional, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('Søknad fra Ola AS ...')] });

    expect(await run.result).toEqual([
      {
        mime: 'application/json',
        body: { kind: 'json', json: { applicant: 'Ola AS', missing: null } },
      },
    ]);
    expect(seen[0]?.request.jsonSchema?.schema).toMatchObject({
      properties: {
        missing: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
          description: 'Mangler',
        },
      },
      required: ['applicant', 'missing'],
    });
  });

  it.each([
    ['text that is not JSON', 'Beklager, jeg kan ikke.'],
    ['JSON with the wrong field types', '{"applicant":"Ola AS","amount":"mye","missing":[]}'],
  ])('fails the task with an error event when the model returns %s', async (_label, content) => {
    const { provider } = models({ 'foundry/gpt-4o': { script: async () => answer(content) } });
    const kernel = kernelFor(fieldsConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });
    await expect(run.result).rejects.toThrow();
    const events = await collect(await kernel.events(kari, run.task, { audience: 'audit' }));

    expect((await kernel.task(kari, run.task)).status).toBe('failed');
    expect(
      events.find((e) => e.type === 'kernel.error' && e.audience === 'audit')?.data,
    ).toMatchObject({
      code: 'strategy_error',
    });
  });

  it('tries the fallback model once when the primary is rate limited or unavailable', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => {
          throw new ModelError('rate_limited', 'slow down');
        },
      },
      'aivar/borealis': { script: async () => answer('Fra reserven.') },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });

    expect(await run.result).toEqual([textPart('Fra reserven.')]);
    expect(seen.map((s) => s.model)).toEqual(['foundry/gpt-4o', 'aivar/borealis']);
  });

  it('does not fall back on a request the model refuses', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => {
          throw new ModelError('bad_request', 'too long');
        },
      },
      'aivar/borealis': { script: async () => answer('aldri') },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });

    await expect(run.result).rejects.toThrow();
    expect(seen.map((s) => s.model)).toEqual(['foundry/gpt-4o']);
  });

  it('does not fall back once streamed text has reached the client', async () => {
    const { provider, seen } = models({
      'foundry/gpt-4o': {
        script: async () => {
          throw new ModelError('unavailable', 'dropped');
        },
        capabilities: ['stream'],
        deltas: ['Halvt '],
      },
      'aivar/borealis': { script: async () => answer('aldri') },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });

    await expect(run.result).rejects.toThrow();
    expect(seen.map((s) => s.model)).toEqual(['foundry/gpt-4o']);
  });

  it('passes the cancellation signal to the model and ends cancelled', async () => {
    let signalled = false;
    const { provider } = models({
      'foundry/gpt-4o': {
        script: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              signalled = true;
              reject(new ModelError('cancelled', 'cancelled'));
            });
          }),
      },
    });
    const kernel = kernelFor(answerConfig, provider);

    const run = await kernel.invoke(kari, 'svc', { parts: [textPart('x')] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await kernel.cancel(kari, run.task);

    await expect(run.result).rejects.toThrow();
    expect(signalled).toBe(true);
    expect((await kernel.task(kari, run.task)).status).toBe('cancelled');
  });

  it('runs a compiled example through the kernel', async () => {
    const klarsprak = definitions.find((d) => d.file === 'klarsprak.yaml')?.definition;
    if (!klarsprak) throw new Error('klarsprak example missing');
    const compiled = toCapabilities(klarsprak, 1)[0];
    if (!compiled) throw new Error('klarsprak compiled to nothing');
    const { provider } = models({
      'foundry/gpt-4o': {
        script: async () => answer('{"text":"Klar tekst.","changes":["kortere setninger"]}'),
      },
    });
    const kernel = createKernel({
      strategies: [singleCall],
      capabilities: [compiled.capability],
      ports: { model: provider },
      policy: { decide: async () => ({ allow: true }) },
    });
    const caller: Principal = { ...kari, tenant: '991825827' };

    const run = await kernel.invoke(caller, compiled.capability.descriptor.id, {
      parts: [textPart('Uklar tekst.')],
    });

    expect(await run.result).toEqual([
      {
        mime: 'application/json',
        body: { kind: 'json', json: { text: 'Klar tekst.', changes: ['kortere setninger'] } },
      },
    ]);
  });

  it('refuses input it cannot read and document output it cannot produce', async () => {
    const { provider } = models({ 'foundry/gpt-4o': { script: async () => answer('x') } });
    const blob = {
      mime: 'application/pdf',
      body: { kind: 'blob' as const, ref: { kind: 'blob', id: 'b1' } },
    };

    const pdf = await kernelFor(answerConfig, provider).invoke(kari, 'svc', { parts: [blob] });
    const document = await kernelFor(
      { ...answerConfig, output: { kind: 'document' } },
      provider,
    ).invoke(kari, 'svc', {
      parts: [textPart('x')],
    });

    await expect(pdf.result).rejects.toThrow();
    await expect(document.result).rejects.toThrow();
  });
});

describe('single-call skills', () => {
  const skill = {
    ref: 'klarsprak@2',
    name: 'klarsprak',
    description: 'Skriv om tekst til klarspråk.',
    instructions: 'Bruk korte setninger.',
    examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt.' }],
  };

  const systemPrompt = async (config: SingleCallRuntimeConfig) => {
    const { provider, seen } = models({ 'foundry/gpt-4o': { script: async () => answer('Ok.') } });
    await (
      await kernelFor(config, provider).invoke(kari, 'svc', { parts: [textPart('x')] })
    ).result;
    return seen[0]?.request;
  };

  it('a service without skills gets exactly the same prompt as before', async () => {
    const before = await systemPrompt(answerConfig);

    expect(await systemPrompt({ ...answerConfig, skills: [] })).toEqual(before);
    expect(before?.messages[0]).toEqual({ role: 'system', content: 'Skriv kort.' });
  });

  it('appends a Ferdigheter section with the instructions and examples of each skill', async () => {
    const request = await systemPrompt({ ...answerConfig, skills: [skill] });

    expect(request?.messages[0]?.content).toBe(
      'Skriv kort.\n\n# Ferdigheter\n\n## klarsprak\nSkriv om tekst til klarspråk.\n\nBruk korte setninger.\n\nEksempler:\nInn: Vedtaket er fattet.\nForventet resultat: Vi har bestemt.',
    );
  });
});
