import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KnowledgePort } from '@genai/port-knowledge';
import { measureProfiles } from './profiles.js';
import {
  jaccard,
  overlap,
  parseToolRun,
  patternMatches,
  recallAt,
  refuses,
  runQuality,
  summarizeAnswers,
  summarizeRetrieval,
  TooManyErrors,
  type QualityCase,
  type RunRecord,
  type ToolRun,
} from './quality.js';
import { renderMarkdown } from './quality-report.js';

const factual: QualityCase = {
  id: 'q1',
  question: 'Hvor mange oppdrag?',
  tags: ['factual'],
  reference: 'Fem oppdrag.',
  answerPattern: '(?i)\\bfem\\b',
  sources: [{ chunkId: 'c1', document: 'd1', position: 3 }],
};
const uncovered: QualityCase = {
  id: 'q2',
  question: 'Tildeling i 2031?',
  tags: ['not-covered'],
  grounding: 'refusal-expected',
  reference: 'Kildene dekker ikke dette.',
  answerPattern: null,
  sources: [],
};

const run = (over: Partial<ToolRun> = {}): ToolRun => ({
  ms: 1000,
  status: 200,
  isError: false,
  text: '',
  chunks: [],
  links: [],
  insufficient: false,
  ...over,
});

describe('reading a tool result', () => {
  it('takes text, chunks with document and position, links, and the insufficient flag', () => {
    const parsed = parseToolRun(
      200,
      {
        result: {
          content: [
            { type: 'text', text: 'Fem oppdrag [1].' },
            { type: 'resource_link', uri: 'digdir://doc/d1' },
          ],
          structuredContent: {
            chunks: [{ chunk_id: 'c1', doc_num: 'd1', chunk_index: 3 }, { doc_num: 'x' }],
            search_attribution: { phrase: 10 },
          },
          _meta: { insufficient: true },
        },
      },
      1234,
    );

    expect(parsed).toMatchObject({
      ms: 1234,
      isError: false,
      text: 'Fem oppdrag [1].',
      chunks: [{ chunkId: 'c1', document: 'd1', position: 3 }],
      links: ['digdir://doc/d1'],
      insufficient: true,
      attribution: { phrase: 10 },
    });
  });

  it('treats JSON-RPC errors, isError results and non-200 answers as errors', () => {
    expect(parseToolRun(200, { error: { code: -32602, message: 'nope' } }, 1)).toMatchObject({
      isError: true,
      error: 'nope',
    });
    expect(
      parseToolRun(
        200,
        { result: { isError: true, content: [{ type: 'text', text: 'failed' }] } },
        1,
      ),
    ).toMatchObject({
      isError: true,
      error: 'failed',
    });
    expect(parseToolRun(500, undefined, 1).isError).toBe(true);
  });
});

describe('metrics', () => {
  it('finds an expected source by chunk id or by document and position, within the top k', () => {
    expect(recallAt([{ chunkId: 'x' }, { chunkId: 'c1' }], factual.sources, 2)).toBe(1);
    expect(recallAt([{ chunkId: 'x' }, { chunkId: 'c1' }], factual.sources, 1)).toBe(0);
    expect(
      recallAt([{ chunkId: 'renamed', document: 'd1', position: 3 }], factual.sources, 5),
    ).toBe(1);
    expect(recallAt([{ chunkId: 'c1' }], [], 5)).toBeUndefined();
  });

  it('measures overlap against the shorter list and stability as Jaccard', () => {
    expect(overlap(['a', 'b', 'c'], ['b', 'x'], 10)).toBe(0.5);
    expect(overlap([], ['a'], 10)).toBeUndefined();
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('applies answer patterns with the (?i) prefix and recognises refusals', () => {
    expect(patternMatches('(?i)\\bfem\\b', 'FEM oppdrag')).toBe(1);
    expect(patternMatches('\\bfem\\b', 'FEM oppdrag')).toBe(0);
    expect(patternMatches(null, 'x')).toBeUndefined();
    expect(refuses(run({ text: 'Kildene dekker ikke dette.' }))).toBe(true);
    expect(refuses(run({ insufficient: true }))).toBe(true);
    expect(refuses(run({ text: 'Jeg har ikke funnet spesifikke opplysninger om 2031.' }))).toBe(
      true,
    );
    expect(refuses(run({ text: 'Jeg kunne ikke finne informasjon om dette.' }))).toBe(true);
    expect(refuses(run({ text: 'Fem oppdrag.' }))).toBe(false);
  });
});

const rec = (
  kind: RunRecord['kind'],
  caseId: string,
  target: string,
  repeat: number,
  r: ToolRun,
  score?: number,
): RunRecord => ({
  kind,
  caseId,
  target,
  repeat,
  run: r,
  ...(score === undefined ? {} : { judgement: { score } }),
});

describe('summaries', () => {
  it('summarises retrieval per system with recall, overlap, stability and a paired difference', () => {
    const records = [
      rec('retrieval', 'q1', 'old', 0, run({ chunks: [{ chunkId: 'c9' }, { chunkId: 'c1' }] })),
      rec('retrieval', 'q1', 'old', 1, run({ chunks: [{ chunkId: 'c9' }] })),
      rec('retrieval', 'q1', 'new', 0, run({ chunks: [{ chunkId: 'c1' }, { chunkId: 'c9' }] })),
      rec('retrieval', 'q1', 'new', 1, run({ chunks: [{ chunkId: 'c1' }, { chunkId: 'c9' }] })),
    ];

    const summary = summarizeRetrieval([factual], records, ['old', 'new']);

    expect(summary.systems[0].recallAt10).toBe(0.5);
    expect(summary.systems[1].recallAt10).toBe(1);
    expect(summary.systems[1].stability).toBe(1);
    expect(summary.overlapAt10).toBe(1);
    expect(summary.recallDifference?.mean).toBe(0.5);
  });

  it('summarises answers: judge scores, refusals on uncovered questions, citations and a paired difference', () => {
    const records = [
      rec(
        'answer',
        'q1',
        'old',
        0,
        run({ text: 'Fem.', chunks: [{ chunkId: 'c1', document: 'd1' }] }),
        0.8,
      ),
      rec('answer', 'q1', 'new', 0, run({ text: 'Tre.', chunks: [] }), 0.2),
      rec('answer', 'q2', 'old', 0, run({ text: 'Kildene dekker ikke dette.' }), 1),
      rec('answer', 'q2', 'new', 0, run({ text: 'Det blir 3 milliarder.' }), 0),
      rec('answer', 'q1', 'new', 1, run({ isError: true })),
    ];

    const summary = summarizeAnswers([factual, uncovered], records, ['old', 'new']);
    const [old, next] = summary.systems;

    expect(old.score?.mean).toBeCloseTo(0.9);
    expect(next.score?.mean).toBeCloseTo(0.1);
    expect(old.refusalOnNotCovered).toBe(1);
    expect(next.refusalOnNotCovered).toBe(0);
    expect(old.patternMatch).toBe(1);
    expect(old.citesExpectedDocument).toBe(1);
    expect(next.citesAnything).toBe(0);
    expect(next.errors).toBe(1);
    expect(summary.paired?.meanDifference).toBeCloseTo(-0.8);
    expect(
      renderMarkdown({
        provisional: true,
        testSet: { source: 'draft.yaml', status: 'draft', cases: 2 },
        generatedAt: 'now',
        repeats: 1,
        answers: summary,
        notes: [],
      }),
    ).toContain('**Provisional.**');
  });
});

describe('running the comparison', () => {
  const targets = [
    { name: 'old', baseUrl: 'http://old' },
    { name: 'new', baseUrl: 'http://new' },
  ] as [{ name: string; baseUrl: string }, { name: string; baseUrl: string }];

  it('writes every call to the run file, judges answers, and resumes without repeating finished calls', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'quality-')), 'runs.jsonl');
    let calls = 0;
    const judged: string[] = [];
    const options = {
      cases: [factual],
      targets,
      kinds: ['retrieval', 'answer'] as const,
      repeats: 2,
      concurrency: 2,
      file,
      call: async () => {
        calls += 1;
        return run({ text: 'Fem.', chunks: [{ chunkId: 'c1' }] });
      },
      judge: {
        id: 'j',
        model: 'judge',
        score: async (c: { id: string }) => {
          judged.push(c.id);
          return { score: 1 };
        },
      },
    };

    const first = await runQuality({ ...options, kinds: [...options.kinds] });
    const second = await runQuality({ ...options, kinds: [...options.kinds] });

    expect(first).toHaveLength(8);
    expect(calls).toBe(8);
    expect(judged).toHaveLength(4);
    expect(second).toHaveLength(8);
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(8);
  });

  it('stops when more than a tenth of the calls fail', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'quality-')), 'runs.jsonl');
    const many = Array.from({ length: 30 }, (_, i) => ({ ...factual, id: `q${i}` }));

    await expect(
      runQuality({
        cases: many,
        targets,
        kinds: ['retrieval'],
        repeats: 1,
        concurrency: 1,
        file,
        call: async () => run({ isError: true, error: 'down' }),
      }),
    ).rejects.toBeInstanceOf(TooManyErrors);
  });
});

describe('search profiles', () => {
  it('measures which profile finds the expected source, and which found it alone', async () => {
    const knowledge = {
      searchMany: async (requests: { profile?: string }[]) =>
        requests.map((r) => ({
          hits:
            r.profile === 'phrase'
              ? [{ id: 'c1', score: 1, text: '', fields: {} }]
              : [{ id: 'x', score: 1, text: '', fields: {} }],
        })),
    } as unknown as KnowledgePort;

    const summary = await measureProfiles(
      [factual, uncovered],
      knowledge,
      ['phrase', 'content'],
      30,
    );

    expect(summary.cases).toBe(1);
    expect(summary.recall).toEqual({ phrase: 1, content: 0 });
    expect(summary.onlyFoundBy).toEqual({ phrase: 1, content: 0 });
    expect(summary.union).toBe(1);
  });
});
