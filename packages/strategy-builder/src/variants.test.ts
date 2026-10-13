import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginSchemas } from '@genai/definitions';
import type { ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import {
  runTurn,
  type BuilderEvent,
  type BuilderTurnInput,
  type RecipeInfo,
  type TurnPorts,
} from './index.js';

const tenant = '991825827';

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    ['agent-loop@1', z.looseObject({})],
    [
      'step-flow@1',
      z.strictObject({
        flow: z.string().regex(/^[a-z0-9][a-z0-9.-]*@\d+$/),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    ],
  ]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(['retrieve@1', 'rerank@1', 'synthesize@1', 'answer@1']),
  models: new Map([['norsk-modell', { residency: 'norway' as const, capabilities: ['tools'] }]]),
};

const label = (nb: string, en: string) => ({ nb, en });

const ordered: RecipeInfo = {
  ref: 'ordered-sources-answer@1',
  title: label('Søk i bestemte dokumenttyper i rekkefølge, så svar', 'Search in order'),
  summary: label('Velg denne når noen dokumenter skal veie tyngst.', 'Pick this when'),
  purpose: 'Search the chosen document types in order, then answer',
  settings: {
    type: 'object',
    properties: {
      documentTypes: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        'x-label': label('Dokumenttyper, i rekkefølge', 'Document types, in order'),
      },
      answerLength: {
        type: 'string',
        enum: ['short', 'medium', 'long'],
        default: 'short',
        'x-label': label('Lengde på svaret', 'Length of the answer'),
      },
    },
  },
};

const service = () => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'kunnskapsassistenten', name: 'Kunnskapsassistenten' },
  spec: {
    purpose: 'Svar med kilder fra offentlige rapporter',
    riskClass: 'limited',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer', withSources: true },
    strategy: { id: 'agent-loop', version: 1, config: {} },
    model: { primary: 'norsk-modell', residency: 'norway' },
  },
});

const input = (overrides: Partial<BuilderTurnInput> = {}): BuilderTurnInput => ({
  target: 'service',
  tenant,
  message: 'Lag en variant som sjekker årsrapportene først, så evalueringene, og svarer kort',
  intent: 'chat',
  draft: service(),
  model: 'norsk-modell',
  systemPrompt: 'Du er byggeassistenten.',
  stream: false,
  context: {
    available: [
      { kind: 'model', id: 'norsk-modell', name: 'Norsk modell', dataLocation: 'norway' },
    ],
    refused: [],
    blockedResidencies: [],
    recipes: [ordered],
  },
  ...overrides,
});

const call = (name: string, args: unknown) => ({ id: name, name, arguments: JSON.stringify(args) });

const recorded = (steps: Partial<ChatResult>[]) => {
  const seen: ChatRequest[] = [];
  const model: ModelPort = {
    info: () => ({ id: 'norsk-modell', residency: 'norway', capabilities: ['tools'] }),
    chat: async (request) => {
      seen.push(structuredClone(request));
      const step = steps[seen.length - 1] ?? { content: 'Ferdig.' };
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        servedModel: 'norsk-modell',
      };
    },
    chatStream: async function* () {
      yield* [];
      throw new Error('not streamed');
    },
  };
  return { model, seen };
};

const run = async (turn: BuilderTurnInput, ports: TurnPorts) => {
  const generator = runTurn({ input: turn, plugins, ports, newId: () => 'p1' });
  const events: BuilderEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { result: next.value, events };
    events.push(next.value);
  }
};

const variant = (extra: Record<string, unknown>) =>
  call('propose_variant', {
    title: 'Ny variant «Årsrapporter først»',
    detail: 'Søker i Årsrapport, så Evaluering, og svarer kort.',
    variant: {
      id: 'arsrapporter-forst',
      title: label('Årsrapporter først', 'Annual reports first'),
    },
    ...extra,
  });

describe('the builder assistant for variants', () => {
  it('gives the model the recipes and their settings schema for a service', async () => {
    const { model, seen } = recorded([{ content: 'Ok.' }]);

    await run(input(), { model });

    const system = seen[0]?.messages[0]?.content ?? '';
    expect(system).toContain('propose_variant');
    expect(system).toContain('"ref": "ordered-sources-answer@1"');
    expect(seen[0]?.tools?.map((t) => t.name)).toContain('propose_variant');
  });

  it('from a plain sentence proposes a new variant with a recipe and its settings, as a level-1 change that is not applied', async () => {
    const { model } = recorded([
      {
        toolCalls: [
          variant({
            recipe: 'ordered-sources-answer@1',
            settings: { documentTypes: ['Årsrapport', 'Evaluering'], answerLength: 'short' },
          }),
        ],
      },
      { content: 'Jeg har foreslått varianten.' },
    ]);

    const { result } = await run(input(), { model });

    expect(result.rejected).toBeUndefined();
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal).toMatchObject({
      level: 1,
      kind: 'change',
      section: 'variants',
      title: 'Ny variant «Årsrapporter først»',
      appliedToDraft: false,
      validation: { ok: true },
      patch: [
        {
          op: 'add',
          path: '/spec/variants',
          value: [
            'default',
            {
              id: 'arsrapporter-forst',
              title: { nb: 'Årsrapporter først', en: 'Annual reports first' },
              strategy: {
                id: 'step-flow',
                version: 1,
                config: {
                  flow: 'ordered-sources-answer@1',
                  settings: { documentTypes: ['Årsrapport', 'Evaluering'], answerLength: 'short' },
                },
              },
            },
          ],
        },
      ],
    });
    expect(proposal?.flows).toBeUndefined();
  });

  it('adds the variant after the ones the draft already has', async () => {
    const draft = service();
    const withVariants = { ...draft, spec: { ...draft.spec, variants: ['default', 'mini'] } };
    const { model } = recorded([
      { toolCalls: [variant({ recipe: 'ordered-sources-answer@1', settings: {} })] },
    ]);

    const { result } = await run(input({ draft: withVariants }), { model });

    expect(result.proposals[0]?.patch?.[0]).toMatchObject({ op: 'add', path: '/spec/variants/-' });
    expect(result.proposals[0]?.after).toMatchObject({
      spec: { variants: ['default', 'mini', { id: 'arsrapporter-forst' }] },
    });
  });

  it('refuses settings the recipe does not allow, and the model may try again', async () => {
    const { model, seen } = recorded([
      {
        toolCalls: [
          variant({ recipe: 'ordered-sources-answer', settings: { answerLength: 'very short' } }),
        ],
      },
      {
        toolCalls: [
          variant({ recipe: 'ordered-sources-answer', settings: { answerLength: 'short' } }),
        ],
      },
    ]);

    const { result } = await run(input(), { model });

    expect(result.rejected?.[0]).toMatchObject({ code: 'VALIDATION_RULE' });
    expect(result.rejected?.[0]?.reason).toContain(
      'answerLength must be one of short, medium, long',
    );
    expect(seen[1]?.messages.at(-1)?.content).toContain('Avvist av plattformen');
    expect(result.proposals).toHaveLength(1);
  });

  it('refuses a recipe the organisation does not have', async () => {
    const { model } = recorded([{ toolCalls: [variant({ recipe: 'finnes-ikke@1' })] }]);

    const { result } = await run(input(), { model });

    expect(result.proposals).toEqual([]);
    expect(result.rejected?.[0]).toMatchObject({ code: 'VALIDATION_UNKNOWN_REFERENCE' });
  });

  it('proposes a new step flow with the variant when no recipe fits', async () => {
    const steps = [
      { id: 'retrieve', block: 'retrieve@1', input: { query: '{{input.query}}' } },
      {
        id: 'svar',
        block: 'synthesize@1',
        input: { query: '{{input.query}}', contextDocs: '{{retrieve.chunks}}' },
      },
    ];
    const { model } = recorded([
      { toolCalls: [variant({ flow: { purpose: 'Søk og svar kort', steps } })] },
    ]);

    const { result } = await run(input(), { model });

    const proposal = result.proposals[0];
    expect(proposal?.flows).toEqual([
      {
        apiVersion: 'genai/v1',
        kind: 'StepFlow',
        metadata: {
          tenant,
          id: 'kunnskapsassistenten-arsrapporter-forst',
          name: 'Årsrapporter først',
        },
        spec: { purpose: 'Søk og svar kort', steps },
      },
    ]);
    expect(proposal?.after).toMatchObject({
      spec: {
        variants: [
          'default',
          { strategy: { config: { flow: 'kunnskapsassistenten-arsrapporter-forst@1' } } },
        ],
      },
    });
  });

  it('refuses a new step flow with an unknown building block', async () => {
    const { model } = recorded([
      {
        toolCalls: [
          variant({ flow: { purpose: 'Feil', steps: [{ id: 'x', block: 'finnes-ikke@1' }] } }),
        ],
      },
    ]);

    const { result } = await run(input(), { model });

    expect(result.proposals).toEqual([]);
    expect(result.rejected?.[0]?.reason).toContain(
      'unknown building block or version finnes-ikke@1',
    );
  });
});

describe('the builder assistant for step flows', () => {
  const flow = () => ({
    apiVersion: 'genai/v1',
    kind: 'StepFlow',
    metadata: { tenant, id: 'sok-og-svar' },
    spec: {
      purpose: 'Søk og svar',
      steps: [{ id: 'retrieve', block: 'retrieve@1', input: { query: '{{input.query}}' } }],
    },
  });

  it('proposes changes to a step flow draft and checks them against the step flow schema', async () => {
    const { model, seen } = recorded([
      {
        toolCalls: [
          call('propose_change', {
            title: 'Svar fra treffene',
            patch: [
              {
                op: 'add',
                path: '/spec/steps/-',
                value: {
                  id: 'svar',
                  block: 'synthesize@1',
                  input: { query: '{{input.query}}', contextDocs: '{{retrieve.chunks}}' },
                },
              },
            ],
          }),
        ],
      },
    ]);

    const { result } = await run(
      input({ target: 'stepflow', draft: flow(), message: 'Legg til et svar til slutt' }),
      { model },
    );

    expect(seen[0]?.tools?.map((t) => t.name)).not.toContain('propose_variant');
    expect(seen[0]?.messages[0]?.content).toContain('Utkastet er en stegflyt (kind: StepFlow).');
    expect(seen[0]?.messages[0]?.content).toContain('retrieve@1, rerank@1, synthesize@1, answer@1');
    expect(result.proposals[0]).toMatchObject({ level: 1, validation: { ok: true } });
  });
});
