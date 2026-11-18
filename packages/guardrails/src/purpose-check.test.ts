import { describe, expect, it } from 'vitest';
import { textPart, type Event, type Input, type Part, type Principal } from '@genai/contracts';
import {
  createKernel,
  InMemoryEventLog,
  type Capability,
  type InvocationContext,
  type Strategy,
} from '@genai/kernel';
import {
  gatedDecision,
  gatedModel,
  type DecisionAnswer,
  type DecisionRequest,
  type ModelPort,
} from '@genai/port-model';
import { guardrailSchemas, guardStrategy } from './index.js';

const tenant = '999888777';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const fnr = '15838510075';
const decider = 'foundry-openai/gpt-6-luna';

const answering = (calls: { runs: number }): Strategy<unknown> => ({
  id: 'answer',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (_ctx: InvocationContext, input: Input) {
    calls.runs += 1;
    const question = (input.data as { query: string }).query;
    yield { type: 'kernel.result', data: [textPart(`Svar på ${question}`)] };
  },
});

const setup = (guardrails: Record<string, unknown>, answer: DecisionAnswer) => {
  const sent: DecisionRequest[] = [];
  const calls = { runs: 0 };
  const model: ModelPort = {
    info: () => ({ id: 'm', residency: 'eu', capabilities: [] }),
    chat: async () => {
      throw new Error('not used');
    },
    chatStream: async function* () {
      yield* [];
      throw new Error('not used');
    },
  };
  const strategy = guardStrategy(answering(calls), { decisions: true });
  const capability: Capability = {
    descriptor: {
      id: `${tenant}/stotte/default`,
      version: '1',
      tenant,
      title: 'Støtte',
      description: 'Svarer på spørsmål om tilskudd til lag og foreninger.',
      input: {},
      interaction: ['unary'],
      accepts: ['text/plain'],
      produces: ['text/plain'],
      emits: [],
      oversight: { interrupts: true, riskClass: 'limited', aiDisclosure: 'KI' },
    },
    strategy: { id: 'answer', version: '1' },
    config: { model: { primary: 'm', tenant }, guardrails },
    grants: [
      { port: 'model', ref: { kind: 'model', id: 'm', tenant } },
      { port: 'decision', ref: { kind: 'model', id: decider, tenant } },
    ],
  };
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [capability],
    ports: {
      model: { open: (_ref, ctx) => gatedModel(model, ctx) },
      decision: {
        open: (_ref, ctx) =>
          gatedDecision(
            {
              info: () => ({ id: decider, residency: 'eu', capabilities: [] }),
              decide: async (request) => {
                sent.push(request);
                return {
                  answers: [answer],
                  usage: { inputTokens: 40, outputTokens: 0, requests: 1 },
                  servedModel: 'gpt-6-luna',
                  calibrated: true,
                };
              },
            },
            ctx,
          ),
      },
    },
    policy: { decide: async () => ({ allow: true }) },
    log: new InMemoryEventLog(),
  });
  const read = async (task: string, audience?: 'audit') => {
    const events: Event[] = [];
    for await (const e of await kernel.events(kari, task, audience ? { audience } : {}))
      events.push(e);
    return events;
  };
  const ask = async (query: string) => {
    const run = await kernel.invoke(kari, capability.descriptor.id, { data: { query } });
    const parts = await run.result.catch(() => undefined);
    return { run, parts, events: await read(run.task, 'audit') };
  };
  return { kernel, ask, sent, calls, read };
};

const predicate = (probability: number): DecisionAnswer => ({
  type: 'predicate',
  name: 'within_purpose',
  probability,
});
const refused: DecisionAnswer = { type: 'refusal', name: 'within_purpose' };

const textOf = (parts: Part[] | undefined) =>
  parts?.find((p) => p.mime === 'text/plain' && p.body.kind === 'text')?.body as
    { text: string } | undefined;

const decisionsIn = (events: Event[]) =>
  events
    .filter((e) => e.type === 'kernel.notice' && (e.data as { kind?: string }).kind === 'decision')
    .map((e) => e.data as Record<string, unknown>);

const check = { model: decider, threshold: 0.8 };

describe('purpose-check', () => {
  it('lets a question the model is sure is within the purpose through to the strategy', async () => {
    const { ask, calls } = setup({ 'purpose-check': check }, predicate(0.93));
    const { parts, events } = await ask('Kan korpset søke om tilskudd?');
    expect(calls.runs).toBe(1);
    expect(textOf(parts)?.text).toBe('Svar på Kan korpset søke om tilskudd?');
    expect(decisionsIn(events)).toEqual([
      {
        kind: 'decision',
        rule: 'purpose-check',
        operation: 'decide',
        model: decider,
        question: 'within_purpose',
        answer: 'within',
        refusal: false,
        threshold: 0.8,
        outcome: 'continue',
        decidedBy: 'model',
        probability: 0.93,
        calibrated: true,
      },
    ]);
  });

  it('refuses a question the model is sure is outside the purpose', async () => {
    const { ask, calls } = setup({ 'purpose-check': check }, predicate(0.05));
    const { parts } = await ask('Hvem vinner valget?');
    expect(calls.runs).toBe(0);
    expect(textOf(parts)?.text).toBe('Dette ligger utenfor formålet til tjenesten.');
  });

  it('a below-threshold purpose check goes to a person, never to no', async () => {
    const { kernel, ask, calls } = setup({ 'purpose-check': check }, predicate(0.55));
    const { run, parts, events } = await ask('Kan jeg få hjelp med en søknad?');

    expect(parts).toBeUndefined();
    expect(calls.runs).toBe(0);
    expect((await kernel.task(kari, run.task)).status).toBe('interrupted');
    expect(decisionsIn(events)[0]).toMatchObject({ answer: 'uncertain', outcome: 'person' });
    const interrupt = events.find((e) => e.type === 'kernel.interrupt')?.data;
    expect(interrupt).toMatchObject({ id: 'purpose-review', reason: 'review' });

    const resumed = await kernel.resume(kari, run.task, 'purpose-review', {
      data: { within: true },
    });
    expect(textOf(await resumed.result)?.text).toBe('Svar på Kan jeg få hjelp med en søknad?');
    expect(calls.runs).toBe(1);
  });

  it('a refusal from the model goes to a person, and a person may say it is outside', async () => {
    const { kernel, ask, read } = setup({ 'purpose-check': check }, refused);
    const { run, events } = await ask('Noe modellen ikke vil svare på.');
    expect(decisionsIn(events)[0]).toMatchObject({
      answer: 'refused',
      refusal: true,
      outcome: 'person',
    });
    expect(decisionsIn(events)[0]).not.toHaveProperty('probability');

    const resumed = await kernel.resume(kari, run.task, 'purpose-review', {
      data: { within: false },
    });
    expect(textOf(await resumed.result)?.text).toBe(
      'En person har vurdert at dette ligger utenfor formålet til tjenesten.',
    );
    expect(decisionsIn(await read(run.task, 'audit')).at(-1)).toMatchObject({
      answer: 'outside',
      decidedBy: 'person',
    });
  });

  it('lets an uncertain answer through when the service says so, and still records it', async () => {
    const { ask, calls } = setup(
      { 'purpose-check': { ...check, uncertain: 'allow' } },
      predicate(0.6),
    );
    const { events } = await ask('Kanskje i formålet?');
    expect(calls.runs).toBe(1);
    expect(decisionsIn(events)[0]).toMatchObject({ answer: 'uncertain', outcome: 'continue' });
  });

  it('has no rule that turns an unsure answer into no', () => {
    const schema = guardrailSchemas.get('purpose-check');
    expect(schema?.safeParse({ model: decider, uncertain: 'refuse' }).success).toBe(false);
    expect(schema?.safeParse({ model: decider, refusal: 'refuse' }).success).toBe(false);
    expect(schema?.safeParse({ model: decider, threshold: 0.5 }).success).toBe(false);
    expect(schema?.safeParse({ model: decider }).success).toBe(true);
  });

  it('a national id in decide input never goes upstream', async () => {
    const { ask, sent } = setup(
      {
        'pii-before-model': { categories: ['national-id'] },
        'purpose-check': check,
      },
      predicate(0.9),
    );
    const { events } = await ask(`Kan ${fnr} søke om tilskudd?`);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(fnr);
    expect(sent[0]?.input).toContain('«NATIONAL_ID_1»');
    const gateCalls = events.filter((e) => e.type === 'kernel.gate.call').map((e) => e.data);
    expect(gateCalls).toEqual([
      expect.objectContaining({ port: 'decision', operation: 'decide', outcome: 'ok' }),
    ]);
  });
});
