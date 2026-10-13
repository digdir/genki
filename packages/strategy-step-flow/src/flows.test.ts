import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { textPart, type Part } from '@genai/contracts';
import type { Strategy } from '@genai/kernel';
import { describe, expect, it } from 'vitest';
import { builtinBlocks } from './builtins.js';
import {
  chunk,
  fakeModels,
  loadDefinition,
  loadFlow,
  notices,
  run,
  stubRetrieval,
} from './harness.test-utils.js';
import { checkFlow } from './validate.js';

const examples = join(import.meta.dirname, '..', 'examples');
const allFlows = () =>
  readdirSync(join(examples, 'flows')).map((f) => loadFlow(join(examples, 'flows', f)));

const sourcesOf = (parts: unknown) =>
  (
    (parts as Part[]).find((p) => p.mime === 'application/vnd.genai.sources+json')?.body as {
      json: { sources: { chunkId: string }[] };
    }
  ).json.sources;

const answerOf = (parts: unknown) => (parts as Part[])[0];

describe('ported headless-rag flows', () => {
  it('fact-checker: retrieves on the claim itself, reranks, and verifies with the evidence prompt', async () => {
    const retrieval = stubRetrieval(
      [chunk('c1'), chunk('c2'), chunk('c3')],
      [chunk('c3'), chunk('c1')],
    );
    const models = fakeModels({ primary: ['Påstanden stemmer, se [2] og [1].'] });

    const out = await run(
      { flows: allFlows(), entry: 'fact-checker@1', models, retrieval },
      { data: { claim: 'Digdir har fått økt bevilgning i 2025' } },
    );

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls.map((c) => c.method)).toEqual(['retrieve', 'rerank']);
    expect(retrieval.calls[0]?.args[0]).toEqual(['Digdir har fått økt bevilgning i 2025']);
    const prompt = models.seen[0]?.request.messages[1]?.content ?? '';
    expect(
      prompt.startsWith(
        'Based on the evidence, verify if the following claim is true, false, or uncertain.',
      ),
    ).toBe(true);
    expect(prompt).toContain(
      'Evidence:\n[1] \n```\nTitle: Dokument c3\n### Kapittel\n```\n\nTekst for c3.',
    );
    expect(prompt).toContain('Claim: Digdir har fått økt bevilgning i 2025');
    expect(models.seen[0]?.request.messages[0]?.content).toBe(
      'You are a helpful assistant. The date this conversation was created at is 6. oktober 2026 (Norwegian time).',
    );
    expect(answerOf(out.result)).toEqual({
      mime: 'text/plain',
      body: { kind: 'text', text: 'Påstanden stemmer, se [2] og [1].' },
      meta: {
        citations: [
          { index: 1, chunkId: 'c3' },
          { index: 2, chunkId: 'c1' },
        ],
      },
    });
    expect(sourcesOf(out.result).map((s) => s.chunkId)).toEqual(['c3', 'c1']);
    expect(notices(out.events)).toContainEqual(expect.objectContaining({ kind: 'retrieval' }));
  });

  it('ai-overview: plans, reranks, passes the evidence gate and keeps a cited overview', async () => {
    const strong = [
      chunk('c1', { rerankScore: 0.9, document: 'd1' }),
      chunk('c2', { rerankScore: 0.8, document: 'd2' }),
      chunk('c3', { rerankScore: 0.2, document: 'd3' }),
    ];
    const retrieval = stubRetrieval(strong);
    const models = fakeModels({ primary: ['Digdir skal samordne digitaliseringen [1][2].'] });

    const out = await run({ flows: allFlows(), entry: 'ai-overview@1', models, retrieval });

    expect(retrieval.calls.map((c) => c.method)).toEqual(['plan', 'retrieve', 'rerank']);
    expect(models.seen[0]?.request.maxTokens).toBe(400);
    expect(models.seen[0]?.request.messages[1]?.content).toContain(
      'Write an AI overview: a direct answer',
    );
    expect(answerOf(out.result)).toMatchObject({
      body: { kind: 'text', text: 'Digdir skal samordne digitaliseringen [1][2].' },
      meta: { overviewDeclined: false, overviewDeclineReason: null },
    });
  });

  it('ai-overview: declines before any model call when retrieval is thin', async () => {
    const retrieval = stubRetrieval([chunk('c1', { rerankScore: 0.9 })]);
    const models = fakeModels({});

    const out = await run({ flows: allFlows(), entry: 'ai-overview@1', models, retrieval });

    expect(out.task.status).toBe('completed');
    expect(models.seen).toHaveLength(0);
    expect(answerOf(out.result)).toMatchObject({
      body: { kind: 'text', text: '' },
      meta: { overviewDeclined: true, overviewDeclineReason: 'too-few-sources' },
    });
  });

  it('ai-overview: throws the answer away when the model declines or cites nothing', async () => {
    const strong = () =>
      stubRetrieval([chunk('c1', { rerankScore: 0.9 }), chunk('c2', { rerankScore: 0.85 })]);

    const sentinel = await run({
      flows: allFlows(),
      entry: 'ai-overview@1',
      models: fakeModels({ primary: ['INSUFFICIENT.'] }),
      retrieval: strong(),
    });
    const uncited = await run({
      flows: allFlows(),
      entry: 'ai-overview@1',
      models: fakeModels({ primary: ['Et svar uten kilder.'] }),
      retrieval: strong(),
    });

    expect(answerOf(sentinel.result)).toMatchObject({
      meta: { overviewDeclineReason: 'model-declined' },
    });
    expect(answerOf(uncited.result)).toMatchObject({ meta: { overviewDeclineReason: 'uncited' } });
  });

  it('retrieve-only: plans, retrieves and reranks without calling a model', async () => {
    const retrieval = stubRetrieval([chunk('c1'), chunk('c2')]);
    const models = fakeModels({});

    const out = await run({ flows: allFlows(), entry: 'retrieve-only@1', models, retrieval });

    expect(models.seen).toHaveLength(0);
    expect(sourcesOf(out.result).map((s) => s.chunkId)).toEqual(['c1', 'c2']);
  });

  describe('agent flows', () => {
    const recordingAgent = () => {
      const configs: Record<string, unknown>[] = [];
      const agent: Strategy<unknown> = {
        id: 'agent-loop',
        version: '1',
        requires: { kernel: 1, ports: ['model'], features: [] },
        run: async function* (_ctx, input, config) {
          configs.push(config as Record<string, unknown>);
          yield { type: 'kernel.part.delta', data: { text: 'Svar ' } };
          yield {
            type: 'kernel.result',
            data: [
              textPart(`Svar på ${String((input.data as { query: string }).query)} [1]`),
              {
                mime: 'application/vnd.genai.sources+json',
                body: { kind: 'json', json: { sources: [{ chunkId: 'c9' }] } },
              },
            ],
          };
        },
      };
      return { agent, configs };
    };

    it.each([
      ['agent-rag@1', {}, undefined],
      [
        'research-assistant@1',
        { vars: { variant: 'bundled' } },
        { retrieveTopK: 150, rerank: { candidateK: 60 } },
      ],
      [
        'altinn-docs-tuned@1',
        {},
        {
          retrieveTopK: 100,
          strategies: [{ name: 'phrase', profiles: ['phrase'] }],
          merge: { weights: { phrase: 1, content: 0, metadata: 0 }, caps: { phrase: 5 } },
          rerank: { candidateK: 20 },
        },
      ],
    ])(
      "%s runs the agent loop with the agent's retrieval settings",
      async (entry, strategy, retrieval) => {
        const { agent, configs } = recordingAgent();

        const out = await run(
          { flows: allFlows(), entry, agent, strategy },
          { data: { query: 'Hva er Altinn?' } },
        );

        expect(out.task.status).toBe('completed');
        expect(out.events.filter((e) => e.type === 'kernel.part.delta')).toHaveLength(1);
        expect((out.result as Part[])[0]).toEqual(textPart('Svar på Hva er Altinn? [1]'));
        expect(configs[0]?.knowledge).toEqual({
          datasets: [{ dataset: 'digdir/kudos' }],
          retrieval: { maxPerDocument: 10, ...retrieval },
        });
        expect(notices(out.events)).toContainEqual(
          expect.objectContaining({
            stage: 'agent',
            variant: (strategy as { vars?: { variant?: string } }).vars?.variant ?? 'faithful',
          }),
        );
      },
    );
  });
});

describe('examples', () => {
  it.each(readdirSync(join(examples, 'flows')))(
    'flow %s validates and has no dangling references',
    (file) => {
      const definition = loadFlow(join(examples, 'flows', file));
      expect(checkFlow(definition, builtinBlocks())).toEqual([]);
    },
  );

  it.each(readdirSync(join(examples, 'services')))(
    'service %s validates against the definitions schema',
    (file) => {
      const definition = loadDefinition(join(examples, 'services', file));
      expect(definition.kind).toBe('Service');
    },
  );

  it('every service points at a flow that exists', () => {
    const flows = new Set(allFlows().map((f) => `${f.metadata.id}@1`));
    for (const file of readdirSync(join(examples, 'services'))) {
      const service = loadDefinition(join(examples, 'services', file));
      if (service.kind !== 'Service') continue;
      expect(flows.has((service.spec.strategy.config as { flow: string }).flow)).toBe(true);
    }
  });
});
