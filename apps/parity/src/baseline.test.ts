import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareBaselines, parseQuestions, runBaseline, writeBaselines } from './baseline.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const retrieval = async (chunksFor: (query: string) => unknown[]) => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { params: { arguments: { query: string } } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [],
            structuredContent: { chunks: chunksFor(body.params.arguments.query) },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    name: 'old',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: 'k',
  };
};

const questions = parseQuestions([
  { id: 'q10', question: 'Hva sier tildelingsbrevet?', dataset: 'kudos' },
  { id: 'q2', question: 'Hvem eier Altinn?', dataset: 'kudos' },
  { id: 1, question: 'Hva er ID-porten?' },
]);

describe('retrieval baseline', () => {
  it('writes one file per dataset that is identical across runs, ties sorted by id', async () => {
    let flip = false;
    const target = await retrieval(() => {
      flip = !flip;
      const tie = [
        { chunk_id: 'c-b', score: 0.5 },
        { chunk_id: 'c-a', score: 0.5 },
      ];
      return [
        { chunk_id: 'c-top', score: 0.9 },
        ...(flip ? tie : tie.reverse()),
        { chunk_id: 'c-low', score: 0.1 },
      ];
    });
    const one = await mkdtemp(join(tmpdir(), 'baseline-'));
    const two = await mkdtemp(join(tmpdir(), 'baseline-'));

    await writeBaselines(one, await runBaseline(target, questions));
    await writeBaselines(two, await runBaseline(target, questions));

    const first = await readFile(join(one, 'kudos.json'), 'utf8');
    expect(first).toBe(await readFile(join(two, 'kudos.json'), 'utf8'));
    expect(await readFile(join(one, 'default.json'), 'utf8')).toBe(
      await readFile(join(two, 'default.json'), 'utf8'),
    );
    const parsed = JSON.parse(first) as { questions: { id: string; ids: string[] }[] };
    expect(parsed.questions.map((q) => q.id)).toEqual(['q2', 'q10']);
    expect(parsed.questions[0]?.ids).toEqual(['c-top', 'c-a', 'c-b', 'c-low']);
    expect(first).not.toMatch(/generatedAt|recordedAt/);
  });

  it('records a failing question instead of stopping the run', async () => {
    const target = await retrieval((q) =>
      q.includes('Altinn') ? (null as unknown as unknown[]) : [{ chunk_id: 'c1' }],
    );

    const [kudos] = await runBaseline(
      target,
      questions.filter((q) => q.dataset === 'kudos'),
    );

    expect(kudos?.questions.find((q) => q.id === 'q2')?.error).toMatch(/structuredContent.chunks/);
    expect(kudos?.questions.find((q) => q.id === 'q10')?.ids).toEqual(['c1']);
  });

  it('matches two baselines up to tie order and reports real ranking changes', () => {
    const old = {
      dataset: 'kudos',
      target: 'old',
      probe: 'p',
      questions: [
        { id: 'q1', question: 'a', ids: ['c1', 'c2', 'c3'], scores: [0.9, 0.5, 0.5] },
        { id: 'q2', question: 'b', ids: ['c1', 'c2'] },
      ],
    };
    const fresh = {
      ...old,
      target: 'new',
      questions: [
        { id: 'q1', question: 'a', ids: ['c1', 'c3', 'c2'], scores: [0.9, 0.5, 0.5] },
        { id: 'q2', question: 'b', ids: ['c2', 'c9'] },
      ],
    };

    const results = compareBaselines(old, fresh);

    expect(results[0]?.differences).toEqual([]);
    expect(results[1]?.differences).toHaveLength(1);
    expect(results[1]?.overlapAt10).toBe(0.5);
  });

  it('refuses a question list without text', () => {
    expect(() => parseQuestions([{ id: 'x' }])).toThrow(/no text/);
  });
});
