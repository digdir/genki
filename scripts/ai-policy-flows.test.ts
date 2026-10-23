import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FlowRetrieval } from '../packages/strategy-step-flow/src/services.js';
import {
  chunk,
  fakeModels,
  loadFlow,
  run,
  stubRetrieval,
  textOf,
} from '../packages/strategy-step-flow/src/harness.test-utils.js';

const flow = loadFlow(
  join(import.meta.dirname, '../apps/api/config/local/flows/ai-policy-comparison.yaml'),
);

const jurisdictionRetrieval = (length: number) => {
  const base = stubRetrieval([]);
  return {
    ...base,
    factory: (_ctx: unknown, config: unknown): FlowRetrieval => {
      const backend = base.factory(_ctx, config);
      const topK = (config as { knowledge: { retrieval: { retrieveTopK: number } } }).knowledge
        .retrieval.retrieveTopK;
      return {
        ...backend,
        retrieve: async (queries, options, signal) => {
          await backend.retrieve(queries, options, signal);
          const name = String(options.filters?.jurisdiction?.[0]);
          return {
            chunks: Array.from({ length: topK }, (_, i) => {
              const marker = `EVIDENCE-${name}-${i}`;
              return chunk(`${name}-${i}`, {
                title: `${name} ${'t'.repeat(200)}`,
                content: marker + 'x'.repeat(length - marker.length),
              });
            }),
          };
        },
      };
    },
  };
};

describe('the AI policy comparison flow', () => {
  it('does not search the entire register when every requested jurisdiction is unknown', async () => {
    const retrieval = stubRetrieval([chunk('unrelated')]);
    const models = fakeModels({
      primary: [
        JSON.stringify({
          jurisdictions: [],
          missing: ['Greenland', 'Faroe Islands'],
          notCompared: [],
          queries: ['AI'],
        }),
        'Unrelated answer [1].',
      ],
    });

    const out = await run({ flows: [flow], entry: 'ai-policy-comparison@1', models, retrieval });

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls).toEqual([]);
    expect(models.seen).toHaveLength(1);
    expect(textOf(out.result)).toContain('Greenland');
    expect(textOf(out.result)).toContain('Faroe Islands');
    expect(textOf(out.result)).toContain('ikke i listen');
    expect(textOf(out.result)).toContain('KI-regelverksguiden');
  });

  it('searches each known jurisdiction separately when the question also includes an unknown one', async () => {
    const retrieval = stubRetrieval([chunk('known')]);
    const models = fakeModels({
      primary: [
        JSON.stringify({
          jurisdictions: ['Norway', 'Sweden'],
          missing: ['Greenland'],
          notCompared: [],
          queries: ['AI'],
        }),
        'Comparison [1].',
      ],
    });

    const out = await run({ flows: [flow], entry: 'ai-policy-comparison@1', models, retrieval });

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls.filter((c) => c.method === 'retrieve').map((c) => c.args[1])).toEqual([
      { filters: { jurisdiction: ['Norway'] } },
      { filters: { jurisdiction: ['Sweden'] } },
    ]);
    expect(models.seen[1]?.request.messages.at(-1)?.content).toContain('Greenland');
    expect(textOf(out.result)).toBe('Comparison [1].');
  });

  it('retains all twelve maximum-length record chunks from four jurisdictions in synthesis', async () => {
    const names = ['Norway', 'Sweden', 'Denmark', 'Germany'];
    // The supplied longest-record bound for v1.18 is about 6,220 characters.
    // Add long titles as well, so this exercises the context wrapper's overhead.
    const retrieval = jurisdictionRetrieval(6220);
    const models = fakeModels({
      primary: [
        JSON.stringify({ jurisdictions: names, missing: [], notCompared: [], queries: ['AI'] }),
        'Comparison [1].',
      ],
    });

    const out = await run({ flows: [flow], entry: 'ai-policy-comparison@1', models, retrieval });

    expect(out.task.status).toBe('completed');
    const prompt = models.seen[1]?.request.messages.at(-1)?.content ?? '';
    for (const name of names)
      for (let i = 0; i < 3; i++) {
        const marker = `EVIDENCE-${name}-${i}`;
        expect(prompt.includes(marker), marker).toBe(true);
      }
    expect(prompt.length).toBeGreaterThan(12 * 6220);
    expect(retrieval.configs[0]).toMatchObject({ knowledge: { retrieval: { retrieveTopK: 3 } } });
    expect(retrieval.calls.some((c) => c.method === 'rerank')).toBe(false);
  });

  it('reports a fifth requested jurisdiction even if synthesis omits it', async () => {
    const names = ['Norway', 'Sweden', 'Denmark', 'Germany'];
    const retrieval = jurisdictionRetrieval(100);
    const models = fakeModels({
      primary: [
        (request) => {
          expect(request.jsonSchema?.schema).toMatchObject({
            properties: { jurisdictions: { maxItems: 4 } },
            required: expect.arrayContaining(['notCompared']),
          });
          expect(request.messages.at(-1)?.content).toContain('notCompared');
          return JSON.stringify({
            jurisdictions: names,
            missing: [],
            notCompared: ['Iceland'],
            queries: ['AI'],
          });
        },
        'Comparison [1].',
      ],
    });

    const out = await run(
      { flows: [flow], entry: 'ai-policy-comparison@1', models, retrieval },
      { data: { query: 'Compare Norway, Sweden, Denmark, Germany and Iceland on AI.' } },
    );

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls.filter((c) => c.method === 'retrieve').map((c) => c.args[1])).toEqual(
      names.map((name) => ({ filters: { jurisdiction: [name] } })),
    );
    expect(models.seen[1]?.request.messages.at(-1)?.content).toContain('Iceland');
    expect(textOf(out.result)).toContain('Iceland');
    expect(textOf(out.result)).toContain('Ikke sammenlignet');
    expect(textOf(out.result)).toContain('fire');
    expect(textOf(out.result)).not.toContain('ikke i listen');
  });
});
