import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('the AI policy comparison flow', () => {
  it('does not search the entire register when every requested jurisdiction is unknown', async () => {
    const retrieval = stubRetrieval([chunk('unrelated')]);
    const models = fakeModels({
      primary: [
        JSON.stringify({
          jurisdictions: [],
          missing: ['Greenland', 'Faroe Islands'],
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
});
