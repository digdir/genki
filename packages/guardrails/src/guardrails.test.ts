import { describe, expect, it } from 'vitest';
import { textPart, type Event, type Input, type Part, type Principal } from '@genai/contracts';
import {
  createKernel,
  InMemoryEventLog,
  type Capability,
  type InvocationContext,
  type PortProvider,
  type Strategy,
} from '@genai/kernel';
import type { ChatChunk, ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import {
  createVault,
  guardModel,
  guardStrategy,
  guardrailSchemas,
  piiSafeEventLog,
  PROVENANCE_MIME,
  SOURCES_MIME,
  type CustomRuleHooks,
  type Language,
  type Provenance,
  type WrittenStandard,
} from './index.js';

const tenant = '999888777';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const fnr = '15838510075';

const result = (content: string): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 5, outputTokens: 5, requests: 1 },
  servedModel: 'gpt-4o-2024-11-20',
});

type Reply = (request: ChatRequest) => string;

const fakeModel = (reply: Reply) => {
  const seen: ChatRequest[] = [];
  const port: ModelPort = {
    info: () => ({ id: 'm', residency: 'eu', capabilities: ['stream', 'json-schema'] }),
    chat: async (request) => {
      seen.push(request);
      return result(reply(request));
    },
    chatStream: async function* (request): AsyncIterable<ChatChunk> {
      seen.push(request);
      yield { kind: 'done', result: result(reply(request)) };
    },
  };
  const provider: PortProvider<ModelPort> = { open: () => port };
  return { provider, seen };
};

interface Answer {
  text: string;
  cite?: boolean;
}

const answering = (answer: (question: string) => Answer, calls: { runs: number }) => {
  const strategy: Strategy<unknown> = {
    id: 'answer',
    version: '1',
    requires: { kernel: 1, ports: ['model'], features: [] },
    run: async function* (ctx: InvocationContext, input: Input) {
      calls.runs += 1;
      const question = (input.data as { query: string }).query;
      const model = await ctx.use<ModelPort>('model', { kind: 'model', id: 'm', tenant });
      const reply = await model.chat({
        purpose: 'answer',
        messages: [
          { role: 'system', content: 'Du svarer på spørsmål.' },
          { role: 'user', content: question },
        ],
      });
      const planned = answer(reply.content);
      yield { type: 'kernel.part.delta', data: { text: planned.text } };
      yield { type: 'kernel.notice', data: { kind: 'retrieval', note: `søkte etter ${question}` } };
      const sources: Part = {
        mime: SOURCES_MIME,
        body: {
          kind: 'json',
          json: { sources: [{ chunkId: 'c1', title: 'Tildelingsbrev 2025' }] },
        },
      };
      const text: Part = {
        ...textPart(planned.text),
        ...(planned.cite ? { meta: { citations: [{ index: 1, chunkId: 'c1' }] } } : {}),
      };
      yield { type: 'kernel.result', data: [text, sources] };
    },
  };
  return strategy;
};

const setup = (
  guardrails: Record<string, unknown>,
  reply: Reply,
  answer: (q: string) => Answer,
  rules?: CustomRuleHooks,
  writtenStandard?: WrittenStandard,
  language?: Language,
) => {
  const model = fakeModel(reply);
  const calls = { runs: 0 };
  const log = new InMemoryEventLog();
  const strategy = guardStrategy(answering(answer, calls), {
    describe: async () => ({
      service: {
        capability: { id: `${tenant}/ka/default`, version: '3' },
        strategy: { id: 'answer', version: '1' },
        configHash: 'abc123',
      },
      aiDisclosure: 'Svaret er laget med kunstig intelligens.',
    }),
    ...(rules ? { rules } : {}),
    ...(writtenStandard ? { writtenStandard: () => writtenStandard } : {}),
    ...(language ? { answerLanguage: () => language } : {}),
  });
  const capability: Capability = {
    descriptor: {
      id: `${tenant}/ka/default`,
      version: '3',
      tenant,
      title: 'KA',
      description: 'KA',
      input: {},
      interaction: ['stream'],
      accepts: ['text/plain'],
      produces: ['text/plain'],
      emits: [],
      oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
    },
    strategy: { id: 'answer', version: '1' },
    config: { model: { primary: 'm', tenant }, guardrails },
    grants: [{ port: 'model', ref: { kind: 'model', id: 'm', tenant } }],
  };
  const categories = (guardrails['pii-out-of-log'] as { categories: string[] } | undefined)
    ?.categories as never;
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [capability],
    ports: { model: model.provider },
    policy: { decide: async () => ({ allow: true }) },
    log: piiSafeEventLog(log, { categoriesFor: () => categories }),
  });
  const ask = async (query: string) => {
    const run = await kernel.invoke(kari, capability.descriptor.id, { data: { query } });
    const parts = await run.result.catch(() => undefined);
    const events: Event[] = [];
    for await (const e of await kernel.events(kari, run.task, { audience: 'audit' }))
      events.push(e);
    return { run, parts, events };
  };
  return { kernel, ask, model, calls };
};

const textOf = (parts: Part[] | undefined) =>
  parts?.find((p) => p.mime === 'text/plain' && p.body.kind === 'text')?.body as
    { text: string } | undefined;

const provenanceOf = (parts: Part[] | undefined) =>
  (parts?.find((p) => p.mime === PROVENANCE_MIME)?.body as { json: Provenance } | undefined)?.json;

const cited = (text: string): Answer => ({ text, cite: true });

describe('guardrail configuration', () => {
  it('accepts the shapes the service definitions use and refuses unknown settings', () => {
    expect(
      guardrailSchemas.get('pii-before-model')?.safeParse({ categories: ['national-id'] }).success,
    ).toBe(true);
    expect(guardrailSchemas.get('require-sources')?.safeParse(true).success).toBe(true);
    expect(guardrailSchemas.get('language')?.safeParse({ mode: 'same' }).success).toBe(true);
    expect(guardrailSchemas.get('refuse-topics')?.safeParse(['valg']).success).toBe(true);
    expect(guardrailSchemas.get('human-approval')?.safeParse(true).success).toBe(true);
    expect(
      guardrailSchemas.get('pii-before-model')?.safeParse({ categories: ['shoe-size'] }).success,
    ).toBe(false);
  });
});

describe('every answer', () => {
  it('carries the AI disclosure and a provenance record with the served model and sources', async () => {
    const { ask } = setup(
      {},
      () => 'svar',
      () => cited('Digdir skal samordne [1].'),
    );

    const { run, parts } = await ask('Hva sier tildelingsbrevet?');

    expect(parts?.find((p) => p.mime === 'text/plain')?.meta?.aiDisclosure).toBe(
      'Svaret er laget med kunstig intelligens.',
    );
    expect(provenanceOf(parts)).toEqual({
      task: run.task,
      service: {
        capability: { id: `${tenant}/ka/default`, version: '3' },
        strategy: { id: 'answer', version: '1' },
        configHash: 'abc123',
      },
      models: ['gpt-4o-2024-11-20'],
      sources: ['c1'],
      aiDisclosure: 'Svaret er laget med kunstig intelligens.',
    });
  });
});

describe('pii-before-model and pii-out-of-log', () => {
  it('masks the national id before the model, restores it in the answer, and keeps it out of the log', async () => {
    const { ask, model } = setup(
      {
        'pii-before-model': { categories: ['national-id'] },
        'pii-out-of-log': { categories: ['national-id'] },
      },
      (request) => `Du spurte om ${request.messages[1]?.content.split(' ').at(-1) ?? ''}`,
      (reply) => cited(`${reply} [1]`),
    );

    const { parts, events } = await ask(`Hva er status for ${fnr}`);

    expect(JSON.stringify(model.seen)).not.toContain(fnr);
    expect(model.seen[0]?.messages[1]?.content).toContain('«NATIONAL_ID_1»');
    expect(textOf(parts)?.text).toBe(`Du spurte om ${fnr} [1]`);
    expect(JSON.stringify(events)).not.toContain(fnr);
    expect(JSON.stringify(events)).toContain('[REDACTED:national-id]');
  });

  it('refuses before calling the model when told to refuse', async () => {
    const { ask, model, calls } = setup(
      { 'pii-before-model': { categories: ['national-id'], action: 'refuse' } },
      () => 'svar',
      () => cited('svar [1]'),
    );

    const { parts } = await ask(`Hva er status for ${fnr}?`);

    expect(textOf(parts)?.text).toMatch(/personopplysninger/);
    expect(model.seen).toHaveLength(0);
    expect(calls.runs).toBe(0);
  });
});

describe('require-sources', () => {
  it('replaces an answer without a valid citation with the refusal text, and keeps a cited one', async () => {
    const uncited = setup(
      { 'require-sources': true },
      () => 'x',
      () => ({ text: 'Digdir skal samordne.' }),
    );
    const outOfRange = setup(
      { 'require-sources': true },
      () => 'x',
      () => ({ text: 'Digdir skal samordne [4].' }),
    );
    const ok = setup(
      { 'require-sources': true },
      () => 'x',
      () => ({ text: 'Digdir skal samordne [1].' }),
    );

    expect(textOf((await uncited.ask('Hva?')).parts)?.text).toMatch(/fant ikke kilder/);
    expect(textOf((await outOfRange.ask('Hva?')).parts)?.text).toMatch(/fant ikke kilder/);
    expect(textOf((await ok.ask('Hva?')).parts)?.text).toBe('Digdir skal samordne [1].');
  });

  it('holds streamed text until the answer has passed, so a refused answer never reaches the client', async () => {
    const { ask } = setup(
      { 'require-sources': true },
      () => 'x',
      () => ({ text: 'Ukildet påstand.' }),
    );

    const { events } = await ask('Hva?');
    const streamed = events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text);

    expect(streamed.join('')).not.toContain('Ukildet påstand');
  });
});

describe('language', () => {
  it('tells the model which language to use and rewrites an answer in the wrong one', async () => {
    const { ask, model } = setup(
      { language: { mode: 'same' } },
      (request) =>
        request.messages[0]?.content.startsWith('Skriv om')
          ? 'Digdir skal ikkje gjere dette åleine, men saman med kommunane [1].'
          : 'Digdir skal ikke gjøre dette alene, men sammen med kommunene [1].',
      (reply) => cited(reply),
    );

    const { parts } = await ask('Kva skal Digdir gjere, og korleis skal det skje?');

    expect(model.seen[0]?.messages[0]?.content).toContain('Svar på nynorsk.');
    expect(
      model.seen.some((r) => r.messages[0]?.content.startsWith('Skriv om teksten til nynorsk')),
    ).toBe(true);
    expect(textOf(parts)?.text).toBe(
      'Digdir skal ikkje gjere dette åleine, men saman med kommunane [1].',
    );
  });
});

describe('written standard setting', () => {
  it('tells the model to answer in nynorsk when a nynorsk question meets the user setting', async () => {
    const { ask, model } = setup(
      {},
      () => 'Fristen er 1. mars [1].',
      (reply) => cited(reply),
      undefined,
      'user',
    );

    const { parts } = await ask('Kva er fristen for å søkje om tilskot?');

    expect(model.seen[0]?.messages[0]?.content).toContain('Svar på nynorsk.');
    expect(model.seen).toHaveLength(1);
    expect(textOf(parts)?.text).toBe('Fristen er 1. mars [1].');
  });

  it('follows a bokmål question and a fixed nynorsk setting', async () => {
    const user = setup({}, () => 'svar [1]', cited, undefined, 'user');
    await user.ask('Hva er fristen for å søke om tilskudd?');
    expect(user.model.seen[0]?.messages[0]?.content).toContain('Svar på bokmål.');

    const fixed = setup({}, () => 'svar [1]', cited, undefined, 'nynorsk');
    await fixed.ask('Hva er fristen for å søke om tilskudd?');
    expect(fixed.model.seen[0]?.messages[0]?.content).toContain('Svar på nynorsk.');
  });

  it('lets the service guardrail language win over the setting', async () => {
    const { ask, model } = setup(
      { language: { mode: 'nb', rewrite: false } },
      () => 'svar [1]',
      cited,
      undefined,
      'nynorsk',
    );
    await ask('Kva er fristen?');
    expect(model.seen[0]?.messages[0]?.content).toContain('Svar på bokmål.');
    expect(model.seen[0]?.messages[0]?.content).not.toContain('nynorsk');
  });
});

describe('answers in English', () => {
  it('answers in English with English platform texts when the person reads English', async () => {
    const english = setup(
      { 'require-sources': true },
      () => 'x',
      () => ({ text: 'Unsourced claim.' }),
      undefined,
      undefined,
      'en',
    );

    const { parts } = await english.ask('What is the deadline?');

    expect(english.model.seen[0]?.messages[0]?.content).toContain('Answer in English.');
    expect(textOf(parts)?.text).toBe(
      'I found no sources that support an answer, so I will not answer this.',
    );
    expect(provenanceOf(parts)?.aiDisclosure).toBe(
      'This answer was made with artificial intelligence.',
    );
  });

  it('keeps tenant-written refusal texts as written and lets a fixed service language win', async () => {
    const custom = setup(
      { 'require-sources': { message: 'Vi fant ikke noe om dette.' } },
      () => 'x',
      () => ({ text: 'Unsourced.' }),
      undefined,
      undefined,
      'en',
    );
    expect(textOf((await custom.ask('What?')).parts)?.text).toBe('Vi fant ikke noe om dette.');

    const fixed = setup({ language: { mode: 'en', rewrite: false } }, () => 'svar [1]', cited);
    await fixed.ask('Hva er fristen for å søke om tilskudd?');
    expect(fixed.model.seen[0]?.messages[0]?.content).toContain('Answer in English.');
  });

  it('rejects a held answer in the language it was written for', async () => {
    const { kernel, ask } = setup(
      { 'human-approval': true },
      () => 'x',
      () => cited('Draft [1].'),
      undefined,
      undefined,
      'en',
    );
    const { run, events } = await ask('Write an answer.');
    const interrupt = events.find((e) => e.type === 'kernel.interrupt')?.data as
      { prompt: Part[] } | undefined;
    expect(textOf(interrupt?.prompt)?.text).toMatch(/must be approved before it is sent/);

    const resumed = await kernel.resume(kari, run.task, 'human-approval', {
      data: { approved: false },
    });
    expect(textOf(await resumed.result)?.text).toBe('The answer was not approved.');
  });
});

describe('refuse-topics', () => {
  it('refuses a question on a refused topic before the strategy runs', async () => {
    const { ask, calls } = setup(
      { 'refuse-topics': ['partipolitikk'] },
      (request) => (request.jsonSchema ? JSON.stringify({ topic: 'partipolitikk' }) : 'svar'),
      () => cited('svar [1]'),
    );

    const { parts } = await ask('Hvilket parti bør jeg stemme på?');

    expect(textOf(parts)?.text).toMatch(/kan ikke besvares/);
    expect(calls.runs).toBe(0);
  });

  it('lets other questions through and fails closed when the classifier breaks', async () => {
    const allowed = setup(
      { 'refuse-topics': ['partipolitikk'] },
      (request) => (request.jsonSchema ? JSON.stringify({ topic: 'none' }) : 'svar'),
      () => cited('Digdir samordner [1].'),
    );
    const broken = setup(
      { 'refuse-topics': ['partipolitikk'] },
      (request) => (request.jsonSchema ? 'ikke json' : 'svar'),
      () => cited('svar [1]'),
    );

    expect(textOf((await allowed.ask('Hva gjør Digdir?')).parts)?.text).toBe(
      'Digdir samordner [1].',
    );
    expect(textOf((await broken.ask('Hva gjør Digdir?')).parts)?.text).toMatch(/kan ikke besvares/);
  });
});

describe('human-approval', () => {
  it('pauses before the answer is released and releases it once approved, recording who actually responded', async () => {
    const { kernel, ask } = setup(
      { 'human-approval': true },
      () => 'x',
      () => cited('Utkast til svar [1].'),
    );

    const { run, parts, events } = await ask('Skriv et svar til innbyggeren.');

    expect(parts).toBeUndefined();
    expect((await kernel.task(kari, run.task)).status).toBe('interrupted');
    expect(events.some((e) => e.type === 'kernel.part.delta')).toBe(false);

    const resumed = await kernel.resume(kari, run.task, 'human-approval', {
      data: { approved: true, approver: 'saksbehandler-1' },
    });
    const released = await resumed.result;

    expect(textOf(released)?.text).toBe('Utkast til svar [1].');
    expect(provenanceOf(released)).toMatchObject({
      approved: true,
      approver: `${kari.kind}:${kari.issuer}:${kari.subject}`,
    });
  });

  it('answers with the rejection text when the answer is not approved', async () => {
    const { kernel, ask } = setup(
      { 'human-approval': true },
      () => 'x',
      () => cited('Utkast [1].'),
    );
    const { run } = await ask('Skriv et svar.');

    const resumed = await kernel.resume(kari, run.task, 'human-approval', {
      data: { approved: false },
    });
    const released = await resumed.result;

    expect(textOf(released)?.text).toBe('Svaret ble ikke godkjent.');
    expect(provenanceOf(released)).toMatchObject({ approved: false, sources: [] });
  });
});

describe('model wrapper', () => {
  it('restores a masked value even when the stream splits its token across chunks', async () => {
    const vault = createVault(['national-id']);
    vault.mask(`fnr ${fnr}`);
    const port: ModelPort = {
      info: () => ({ id: 'm', residency: 'eu', capabilities: ['stream'] }),
      chat: async () => result(''),
      chatStream: async function* () {
        yield { kind: 'delta', text: 'Gjelder «NATIONAL' };
        yield { kind: 'delta', text: '_ID_1» og ' };
        yield { kind: 'delta', text: 'ingen andre.' };
        yield { kind: 'done', result: result('Gjelder «NATIONAL_ID_1» og ingen andre.') };
      },
    };
    const chunks: ChatChunk[] = [];
    for await (const c of guardModel(port, { vault }).chatStream({ messages: [] })) chunks.push(c);

    expect(chunks.flatMap((c) => (c.kind === 'delta' ? [c.text] : [])).join('')).toBe(
      `Gjelder ${fnr} og ingen andre.`,
    );
    expect(chunks.at(-1)).toMatchObject({
      kind: 'done',
      result: { content: `Gjelder ${fnr} og ingen andre.` },
    });
  });
});

describe('custom-rules', () => {
  it('refuses a question matching a tenant regex rule before the strategy runs, and audits which rule fired', async () => {
    const { ask, calls, model } = setup(
      { 'custom-rules': [{ id: 'no-case-numbers', kind: 'regex', pattern: '\\bsak \\d{4}/\\d+' }] },
      () => 'svar',
      () => cited('svar [1]'),
    );

    const { parts, events } = await ask('Hva skjedde i sak 2024/113?');

    expect(textOf(parts)?.text).toBe('Dette kan ikke besvares i denne tjenesten.');
    expect(calls.runs).toBe(0);
    expect(model.seen).toHaveLength(0);
    expect(events.find((e) => e.type === 'x.guardrails.rule')?.data).toEqual({
      rule: 'no-case-numbers',
      stage: 'input',
      outcome: 'refused',
    });
  });

  it('masks denylisted words in the answer without touching words that only contain them', async () => {
    const { ask } = setup(
      {
        'custom-rules': [
          {
            id: 'internal-names',
            kind: 'denylist',
            terms: ['Prosjekt Ørn'],
            stage: 'output',
            action: 'mask',
          },
        ],
      },
      () => 'svar',
      () => cited('Prosjekt Ørn og Prosjekt Ørnulf er nevnt [1].'),
    );

    const { parts } = await ask('Hva er nevnt?');

    expect(textOf(parts)?.text).toBe('[fjernet] og Prosjekt Ørnulf er nevnt [1].');
  });

  it('asks the model as a judge with the tenant prompt and refuses the answer it blocks', async () => {
    const { ask, model } = setup(
      {
        'custom-rules': [
          {
            id: 'no-advice',
            kind: 'llm-judge',
            prompt: 'Blokker svar som gir juridiske råd.',
            stage: 'output',
            message: 'Vi gir ikke juridiske råd.',
          },
        ],
      },
      (request) => (request.jsonSchema ? '{"verdict":"block"}' : 'svar'),
      () => cited('Du bør saksøke [1].'),
    );

    const { parts } = await ask('Bør jeg saksøke?');

    expect(textOf(parts)?.text).toBe('Vi gir ikke juridiske råd.');
    expect(model.seen.at(-1)?.messages[0]?.content).toContain(
      'Blokker svar som gir juridiske råd.',
    );
  });

  it('runs mandatory rules from the resolver even when the service lists none, and fails closed when an external check breaks', async () => {
    const hooks: CustomRuleHooks = {
      resolve: async (_ctx, entries) => [
        {
          id: 'platform-floor',
          kind: 'mcp-check',
          tool: 'checker.scan@1',
          stage: 'input',
          onError: 'refuse',
        },
        ...(entries as never[]),
      ],
      external: async () => {
        throw new Error('the checker is down');
      },
    };
    const { ask, calls } = setup(
      {},
      () => 'svar',
      () => cited('svar [1]'),
      hooks,
    );

    const { parts } = await ask('Hei');

    expect(textOf(parts)?.text).toBe('Dette kan ikke besvares i denne tjenesten.');
    expect(calls.runs).toBe(0);
  });

  it('lets an answer through when an external check allows it', async () => {
    const seen: string[] = [];
    const hooks: CustomRuleHooks = {
      resolve: async () => [
        { id: 'scan', kind: 'mcp-check', tool: 'checker.scan@1', stage: 'both', onError: 'refuse' },
      ],
      external: async (_ctx, _rule, text) => {
        seen.push(text);
        return { allow: true };
      },
    };
    const { ask } = setup(
      {},
      () => 'svar',
      () => cited('Alt i orden [1].'),
      hooks,
    );

    const { parts } = await ask('Hei');

    expect(textOf(parts)?.text).toBe('Alt i orden [1].');
    expect(seen).toEqual(['Hei', 'Alt i orden [1].']);
  });

  it('refuses an invalid rule in the service definition', () => {
    const schema = guardrailSchemas.get('custom-rules');
    expect(schema?.safeParse(['shared-rule']).success).toBe(true);
    expect(schema?.safeParse([{ id: 'x', kind: 'regex', pattern: '(' }]).success).toBe(false);
    expect(schema?.safeParse([{ id: 'x', kind: 'shell', command: 'rm' }]).success).toBe(false);
  });
});
