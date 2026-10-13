import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anthropicJudge,
  meanWithCi,
  openAiAsker,
  runSweep,
  type Answer,
  type Judge,
} from './sweep.js';
import type { Target } from './types.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const system = async (
  name: string,
  answer: (question: string) => Record<string, unknown>,
): Promise<Target> => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer(body.messages[0]?.content ?? '')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    name,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: 'k',
  };
};

const reply = (content: string, model = 'gpt-4o-2024-11-20') => ({
  model,
  choices: [{ message: { role: 'assistant', content } }],
  citations: ['https://kudos.dfo.no/d1'],
});

const judge = (scoreOf: (answer: Answer) => number): Judge & { seen: Answer[] } => {
  const seen: Answer[] = [];
  return {
    id: 'fake',
    model: 'judge-model',
    seen,
    score: async (_c, answer) => {
      seen.push(answer);
      return { score: scoreOf(answer) };
    },
  };
};

const cases = [
  { id: 'q1', question: 'Hva er Kudos?' },
  { id: 'q2', question: 'Hva er Altinn?' },
];

describe('sweep runner', () => {
  it('asks both systems over HTTP, scores with one judge and compares in pairs', async () => {
    const old = await system('old', () => reply('godt svar'));
    const next = await system('new', () => reply('bedre svar'));
    const j = judge((a) => (a.text === 'bedre svar' ? 0.9 : 0.6));

    const report = await runSweep({
      targets: [old, next],
      cases,
      ask: openAiAsker('ka'),
      judge: j,
      repeats: 2,
    });

    expect(report.valid).toBe(true);
    expect(j.seen).toHaveLength(8);
    expect(j.seen[0]).toEqual({
      text: 'godt svar',
      citations: ['https://kudos.dfo.no/d1'],
      servedModel: 'gpt-4o-2024-11-20',
    });
    expect(report.targets.map((t) => t.mean)).toEqual([0.6, 0.9]);
    expect(report.paired.meanDifference).toBeCloseTo(0.3);
    expect(report.paired.n).toBe(2);
  });

  it('marks the comparison invalid when the systems were served by different models', async () => {
    const old = await system('old', () => reply('svar', 'gpt-4o-2024-08-06'));
    const next = await system('new', () => reply('svar', 'gpt-4o-2024-11-20'));

    const report = await runSweep({
      targets: [old, next],
      cases,
      ask: openAiAsker('ka'),
      judge: judge(() => 0.5),
      repeats: 1,
    });

    expect(report.valid).toBe(false);
    expect(report.problems.join(' ')).toMatch(/served models differ/);
  });

  it('fails loudly on errors and out-of-range judge scores instead of skipping them quietly', async () => {
    const old = await system('old', () => reply('svar'));
    const next = await system('new', () => ({ error: 'boom' }));

    const report = await runSweep({
      targets: [old, next],
      cases,
      ask: openAiAsker('ka'),
      judge: judge(() => 1.5),
      repeats: 1,
    });

    expect(report.valid).toBe(false);
    expect(report.targets.map((t) => t.errors)).toEqual([2, 2]);
    expect(report.problems.join(' ')).toMatch(/outside 0\.\.1/);
  });

  it('computes a t-based confidence interval', () => {
    const { mean, ci } = meanWithCi([0.5, 0.7, 0.6, 0.8]);
    expect(mean).toBeCloseTo(0.65);
    expect(ci[0]).toBeCloseTo(0.4446, 3);
    expect(ci[1]).toBeCloseTo(0.8554, 3);
  });
});

describe('anthropic judge', () => {
  it('sends the rubric as the system prompt with Anthropic headers and reads the score from the text', async () => {
    let seen: { headers: Record<string, unknown>; body: Record<string, unknown> } | undefined;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            content: [
              { type: 'text', text: 'Vurdering: {"score": 0.75, "reasons": "mostly right"}' },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const judge = anthropicJudge({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`,
      apiKey: 'judge-key',
      model: 'claude-test',
    });

    const result = await judge.score({ id: 'q1', question: 'Hva?', reference: 'Svar' }, {
      text: 'Svar [1]',
      citations: ['c1'],
    } as Answer);

    expect(result).toEqual({ score: 0.75, reasons: 'mostly right' });
    expect(seen?.headers['x-api-key']).toBe('judge-key');
    expect(seen?.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen?.body).toMatchObject({ model: 'claude-test' });
    expect(seen?.body).not.toHaveProperty('temperature');
    expect(String(seen?.body.system)).toContain('Score the answer from 0 to 1');
  });
});
