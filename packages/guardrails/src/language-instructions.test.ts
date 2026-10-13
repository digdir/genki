import { describe, expect, it } from 'vitest';
import type { Input, Part } from '@genai/contracts';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import type { ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import {
  assembleLanguage,
  guardStrategy,
  PROVENANCE_MIME,
  type GuardStrategyOptions,
  type Language,
  type Provenance,
} from './index.js';

const result = (content: string): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
  servedModel: 'm',
});

const planningAndAnswering = (seen: ChatRequest[], received: unknown[]): Strategy<unknown> => ({
  id: 'fake',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (ctx: InvocationContext, input: Input, config: unknown) {
    received.push(config);
    const model = await ctx.use<ModelPort>('model', { kind: 'model', id: 'm', tenant: 't' });
    await model.chat({ messages: [{ role: 'system', content: 'Plan the search.' }] });
    const system = (config as { strategy: { instructions: string } }).strategy.instructions;
    const answer = await model.chat({
      purpose: 'answer',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: (input.data as { query: string }).query },
      ],
    });
    yield {
      type: 'kernel.result',
      data: [{ mime: 'text/plain', body: { kind: 'text', text: answer.content } }],
    };
  },
});

const run = async (
  config: Record<string, unknown>,
  query: string,
  options: GuardStrategyOptions = {},
) => {
  const seen: ChatRequest[] = [];
  const received: unknown[] = [];
  const port: ModelPort = {
    info: () => ({ id: 'm', residency: 'eu', capabilities: [] }),
    chat: async (request) => {
      seen.push(request);
      return result('Svar.');
    },
    chatStream: async function* () {
      yield { kind: 'done', result: result('Svar.') };
    },
  };
  const ctx = {
    task: 'task-1',
    tenant: 't',
    service: {
      capability: { id: 't/s/default', version: '1' },
      strategy: { id: 'fake', version: '1' },
      configHash: 'h',
    },
    capability: { oversight: { aiDisclosure: 'Svaret er laget med kunstig intelligens.' } },
    use: async () => port,
    state: { checkpoint: async () => {} },
  } as unknown as InvocationContext;
  const strategy = guardStrategy(planningAndAnswering(seen, received), options);
  const events: Emitted[] = [];
  for await (const e of strategy.run(
    ctx,
    { data: { query } },
    { model: { primary: 'm' }, ...config },
  ))
    events.push(e);
  const parts = events.find((e) => e.type === 'kernel.result')?.data as Part[];
  const text = parts.find((p) => p.mime === 'text/plain');
  const provenance = parts.find((p) => p.mime === PROVENANCE_MIME);
  return {
    planner: seen[0],
    answer: seen[1],
    received: received[0] as { strategy: Record<string, unknown> },
    text: text?.body.kind === 'text' ? text.body.text : undefined,
    provenance: (provenance?.body.kind === 'json' ? provenance.body.json : undefined) as Provenance,
  };
};

const english = 'What is the deadline for the grant and how should the agency apply?';
const bokmal = 'Hva er fristen for å søke om tilskudd, og hvordan skal virksomheten søke?';
const houseStyle =
  (texts: Partial<Record<Language, string>>, layer: 'platform' | 'tenant' = 'platform') =>
  (_c: unknown, _i: unknown, _config: unknown, language: Language) =>
    texts[language] ? { text: texts[language] as string, layer } : undefined;

describe('language instructions', () => {
  it('appends house style and then the service text for the language after the service instructions', async () => {
    const { answer, provenance } = await run(
      {
        strategy: {
          instructions: 'Du svarer om tilskudd.',
          languageInstructions: { en: 'Call the grant "the relocation grant".' },
        },
      },
      english,
      { houseStyle: houseStyle({ en: 'Answer in English.' }) },
    );
    expect(answer?.messages[0]?.content).toBe(
      'Du svarer om tilskudd.\n\nAnswer in English.\n\nCall the grant "the relocation grant".',
    );
    expect(provenance.language).toMatchObject({
      answer: 'en',
      layers: ['instructions', 'house-style@platform', 'language-instructions.en'],
    });
  });

  it('records the tenant layer when the tenant house style overrides the platform one', async () => {
    const { answer, provenance } = await run({ strategy: { instructions: 'Base.' } }, bokmal, {
      houseStyle: houseStyle({ nb: 'Skriv som Lånekassen.' }, 'tenant'),
    });
    expect(answer?.messages[0]?.content).toBe('Base.\n\nSkriv som Lånekassen.');
    expect(provenance.language?.layers).toContain('house-style@tenant');
  });

  it('gives planner calls neither house style nor service text', async () => {
    const { planner } = await run(
      { strategy: { instructions: 'Base.', languageInstructions: { nb: 'Bruk du-form.' } } },
      bokmal,
      { houseStyle: houseStyle({ nb: 'Svar på bokmål.' }) },
    );
    expect(planner?.messages).toEqual([{ role: 'system', content: 'Plan the search.' }]);
    expect(planner?.purpose).toBeUndefined();
  });

  it('uses the full prompt for the language when instructions are given per language', async () => {
    const { answer, received, provenance } = await run(
      { strategy: { instructions: { nb: 'Bokmålsledetekst.', en: 'English prompt.' } } },
      english,
    );
    expect(answer?.messages[0]?.content).toBe('English prompt.\n\nAnswer in English.');
    expect(received.strategy.instructions).toBe('English prompt.');
    expect(received.strategy).not.toHaveProperty('languageInstructions');
    expect(provenance.language?.layers[0]).toBe('instructions.en');
  });

  it('answers a question in a language the service does not list in its first language with one line saying so', async () => {
    const { answer, text, provenance } = await run(
      { languages: ['nb'], strategy: { instructions: 'Base.' } },
      english,
    );
    expect(answer?.messages[0]?.content).toBe('Base.\n\nSvar på bokmål.');
    expect(text).toBe(
      'Denne tjenesten svarer ikke på språket i spørsmålet, så jeg svarer på bokmål.\n\nSvar.',
    );
    expect(provenance.language).toMatchObject({ answer: 'nb', fallback: true });
  });

  it('never counts a question whose language cannot be detected as unsupported', async () => {
    const { text, provenance } = await run(
      { languages: ['nb'], strategy: { instructions: 'Base.' } },
      'Digdir lanserte Altinn Studio i Oslo i 2024.',
    );
    expect(text).toBe('Svar.');
    expect(provenance.language).toBeUndefined();
  });

  it('does not inject the fallback line into structured output', async () => {
    const { text } = await run(
      { languages: ['nb'], output: { kind: 'fields' }, strategy: { instructions: 'Base.' } },
      english,
    );
    expect(text).toBe('Svar.');
  });

  it('answers nynorsk for a service that lists bokmål, since both are Norwegian', async () => {
    const { answer, provenance } = await run(
      { strategy: { instructions: 'Base.' } },
      'Kva er fristen for å søkje om tilskot, og korleis skal verksemda gjere det?',
    );
    expect(answer?.messages[0]?.content).toBe('Base.\n\nSvar på nynorsk.');
    expect(provenance.language?.fallback).toBeUndefined();
  });

  it('changes the text hash in provenance when a house style text changes', async () => {
    const config = { strategy: { instructions: 'Base.' } };
    const a = await run(config, bokmal, { houseStyle: houseStyle({ nb: 'Versjon 1.' }) });
    const b = await run(config, bokmal, { houseStyle: houseStyle({ nb: 'Versjon 2.' }) });
    expect(a.provenance.language?.textHash).not.toBe(b.provenance.language?.textHash);
  });

  it('keeps the service instructions as is when no language is chosen', () => {
    const assembled = assembleLanguage(
      { strategy: { instructions: 'Base.' } },
      undefined,
      undefined,
    );
    expect(assembled.instruction).toBeUndefined();
    expect(assembled.config).toEqual({ strategy: { instructions: 'Base.' } });
  });
});
