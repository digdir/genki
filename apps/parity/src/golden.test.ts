import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autoFilterDetections, compareToggle, scoreRetrieval } from './bench.js';
import {
  headlessRetriever,
  platformAttributor,
  platformRetriever,
  type Retriever,
} from './diagnostics.js';
import { parseEdn } from './edn.js';
import {
  goldenStages,
  parseToolRun,
  runQuality,
  servedModels,
  summarizeAnswers,
  type QualityCase,
  type RunRecord,
  type ToolRun,
} from './quality.js';
import { loadTestSet } from './testsets.js';

const testsets = join(import.meta.dirname, '..', '..', '..', 'packages', 'eval', 'testsets');

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const serve = async (
  handle: (
    url: string,
    headers: IncomingHttpHeaders,
    body: string,
  ) => { status?: number; type?: string; body: string },
) => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const out = handle(req.url ?? '', req.headers, body);
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'application/json' });
      res.end(out.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
};

const golden: QualityCase = {
  id: 'g1',
  question: 'Hva skjedde i 2024?',
  tags: ['year-2024'],
  reference: 'Noe.',
  answerPattern: null,
  sources: [{ chunkId: 'c2', document: 'd2', position: 1 }],
};

const run = (over: Partial<ToolRun> = {}): ToolRun => ({
  ms: 10,
  status: 200,
  isError: false,
  text: 'Svar [1].',
  chunks: [{ chunkId: 'c2', document: 'd2', position: 1 }],
  links: [],
  insufficient: false,
  ...over,
});

describe('golden sets', () => {
  it.each([
    ['headless-rag-website-118.yaml', 118, 'public-docs-agent__default'],
    ['headless-rag-ue-42.yaml', 42, 'public-docs-agent__default'],
  ])(
    '%s loads as a parity test set with a target profile for both systems',
    async (file, count, newAgent) => {
      const set = await loadTestSet(join(testsets, file));

      expect(set.cases).toHaveLength(count);
      expect(set.profile.corpus).toBe('digdir/public-docs');
      expect(set.profile.old.arguments).toEqual({
        tenant: 'digdir',
        dataset_config_key: 'default',
      });
      expect(set.profile.new.agent).toBe(newAgent);
      expect(set.cases.every((c) => c.question.length > 0)).toBe(true);
      expect(set.cases.filter((c) => c.sources.length > 0).length).toBeGreaterThan(count / 2);
    },
  );

  it('a golden set with cases marked for review is reported as provisional', async () => {
    const set = await loadTestSet(join(testsets, 'headless-rag-ue-42.yaml'));

    expect(set.status).toBe('imported');
    expect(set.provisional).toBe(true);
  });

  it('a test set without a target profile is refused instead of guessing the tools', async () => {
    await expect(loadTestSet(join(testsets, 'headless-rag-ue-42.yaml'), {})).rejects.toThrow(
      /no target profile/,
    );
  });

  it('each system is asked with its own tool and scope arguments from the profile', async () => {
    const calls: { target: string; tool: string; args: unknown }[] = [];
    await runQuality({
      cases: [golden],
      targets: [
        { name: 'old', baseUrl: 'http://old' },
        { name: 'new', baseUrl: 'http://new' },
      ],
      kinds: ['retrieval'],
      repeats: 1,
      concurrency: 1,
      file: join(await import('node:os').then((o) => o.tmpdir()), `golden-${Date.now()}.jsonl`),
      tools: {
        old: { agent: 'a', probe: 'old-probe', arguments: { tenant: 'digdir' } },
        new: { agent: 'a', probe: 'new-probe', arguments: {} },
      },
      call: async (target, tool, _question, args) => {
        calls.push({ target: target.name, tool, args });
        return run();
      },
    });

    expect(calls).toEqual([
      { target: 'old', tool: 'old-probe', args: { tenant: 'digdir' } },
      { target: 'new', tool: 'new-probe', args: {} },
    ]);
  });
});

describe('served model', () => {
  const answer = (target: string, servedModel?: string): RunRecord => ({
    kind: 'answer',
    caseId: 'g1',
    target,
    repeat: 0,
    run: run(servedModel ? { servedModel } : {}),
  });

  it('the tool result records the model the system reports in _meta', () => {
    const parsed = parseToolRun(
      200,
      { result: { content: [], _meta: { model: 'foundry-openai/gpt-4o' } } },
      5,
      'task-1',
    );

    expect(parsed).toMatchObject({ servedModel: 'foundry-openai/gpt-4o', task: 'task-1' });
  });

  it('the report flags a system that does not report its model, and uses a declared one only as declared', () => {
    const summary = servedModels([answer('old'), answer('new', 'gpt-4o')], ['old', 'new'], {
      old: 'gpt-4o',
    });

    expect(summary.systems).toEqual([
      { target: 'old', models: ['gpt-4o'], source: 'declared' },
      { target: 'new', models: ['gpt-4o'], source: 'reported' },
    ]);
    expect(summary.problems).toEqual([
      'old does not report its served model; gpt-4o is declared by the operator',
    ]);
  });

  it('the report flags different served models', () => {
    const summary = servedModels([answer('old', 'gpt-5'), answer('new', 'gpt-4o')], ['old', 'new']);

    expect(summary.problems).toContain('served models differ: gpt-5 vs gpt-4o');
  });

  it('an unknown served model is a problem, not a silent gap', () => {
    expect(servedModels([answer('old'), answer('new')], ['old', 'new']).problems).toEqual([
      'the served model of old is unknown',
      'the served model of new is unknown',
    ]);
  });
});

describe('stage attribution', () => {
  it('a golden chunk is placed in the search pool, displayed and read stages separately', () => {
    expect(
      goldenStages(
        {
          pool: [{ chunkId: 'c1' }, { chunkId: 'c2' }],
          displayed: [{ chunkId: 'c1' }],
          read: [],
        },
        golden.sources,
      ),
    ).toEqual({ inPool: true, displayed: false, read: false });
  });

  it('answer runs on the platform carry stages from the operator attribution route', async () => {
    let seen: IncomingHttpHeaders | undefined;
    const url = await serve((path, headers) => {
      seen = headers;
      return path === '/tenants/991825827/diagnostics/tasks/t1/attribution'
        ? {
            body: JSON.stringify({
              pool: [{ chunkId: 'c2' }],
              displayed: [{ chunkId: 'c2' }],
              read: [{ chunkId: 'c9' }],
            }),
          }
        : { status: 404, body: '{}' };
    });
    const access = { baseUrl: url, token: 'op', supportSession: 's1', tenant: '991825827' };
    const records = await runQuality({
      cases: [golden],
      targets: [
        { name: 'old', baseUrl: 'http://old' },
        { name: 'new', baseUrl: 'http://new' },
      ],
      kinds: ['answer'],
      repeats: 1,
      concurrency: 1,
      file: join(await import('node:os').then((o) => o.tmpdir()), `stages-${Date.now()}.jsonl`),
      call: async (target) => run(target.name === 'new' ? { task: 't1' } : {}),
      attribute: platformAttributor(access, 'new'),
    });

    expect(records.find((r) => r.target === 'new')?.stages).toEqual({
      inPool: true,
      displayed: true,
      read: false,
    });
    expect(records.find((r) => r.target === 'old')?.stages).toBeUndefined();
    expect(seen?.authorization).toBe('Bearer op');
    expect(seen?.['support-session']).toBe('s1');
    expect(summarizeAnswers([golden], records, ['old', 'new']).systems[1].stages).toEqual({
      runs: 1,
      inPool: 1,
      displayed: 1,
      read: 0,
    });
  });
});

describe('fixed-query retrieval', () => {
  it('reads the headless-rag debug route, which answers in EDN', async () => {
    let path = '';
    let key: string | string[] | undefined;
    const url = await serve((p, headers) => {
      path = p;
      key = headers['x-debug-api-key'];
      return {
        type: 'application/edn',
        body: '{:found-count 2, :chunks [{:chunk_id "c1" :doc_num "d1" :chunk_index 0 :score 0.9} {:chunk_id "c2", :doc_num "d2", :chunk_index 1}], :search-attribution {:auto-filter-applied {:field "concerned_years" :values ["2024"]}}}',
      };
    });
    const result = await headlessRetriever(
      { baseUrl: url, debugKey: 'dk' },
      { tenant: 'digdir', datasetConfigKey: 'default' },
    )({ queries: ['Hva, egentlig?'], rerank: true });

    expect(key).toBe('dk');
    expect(new URL(path, url).searchParams.get('q')).toBe('Hva, egentlig?');
    expect(new URL(path, url).searchParams.get('rerank-with-colbert')).toBe('true');
    expect(result.chunks).toEqual([
      { chunkId: 'c1', document: 'd1', position: 0, score: 0.9 },
      { chunkId: 'c2', document: 'd2', position: 1 },
    ]);
    expect(result.detectedFilter).toEqual({ field: 'concerned_years', values: ['2024'] });
  });

  it('calls the platform diagnostics route as an operator in a support session, with overrides', async () => {
    let request: { path: string; headers: IncomingHttpHeaders; body: unknown } | undefined;
    const url = await serve((path, headers, body) => {
      request = { path, headers, body: JSON.parse(body) };
      return {
        body: JSON.stringify({
          chunks: [{ chunkId: 'c2', document: 'd2', position: 1 }],
          trace: { expansion: { rerank: { status: 'reranked' } } },
        }),
      };
    });
    const result = await platformRetriever(
      { baseUrl: url, token: 'op', supportSession: 's1', tenant: '991825827' },
      { service: 'public-docs-retrieve-only' },
    )({ queries: ['q'], rerank: true, autoFilter: false });

    expect(request?.path).toBe('/tenants/991825827/diagnostics/retrieve');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.body).toEqual({
      service: 'public-docs-retrieve-only',
      queries: ['q'],
      overrides: { rerank: true, autoFilter: false },
    });
    expect(result).toMatchObject({ chunks: [{ chunkId: 'c2' }], rerank: 'reranked' });
  });

  it('a refused diagnostics call fails the case instead of scoring it as a miss', async () => {
    const url = await serve(() => ({ status: 404, body: '{"title":"Not found"}' }));
    const score = await scoreRetrieval(
      [golden],
      platformRetriever(
        { baseUrl: url, token: 'op', supportSession: 'gone', tenant: '991825827' },
        { service: 's' },
      ),
    );

    expect(score.errors).toBe(1);
    expect(score.perCase[0]?.error).toMatch(/HTTP 404: Not found/);
  });

  it('the rerank benchmark compares off and on, and gates on the golden rank', async () => {
    const retriever: Retriever = async (request) => ({
      ms: 1,
      chunks: request.rerank
        ? [{ chunkId: 'c2', document: 'd2', position: 1 }]
        : Array.from({ length: 12 }, (_, i) => ({ chunkId: i === 11 ? 'c2' : `x${i}` })),
    });
    const comparison = await compareToggle(
      'rerank',
      [golden],
      retriever,
      (on) => ({ rerank: on }),
      10,
    );

    expect(comparison.off.perCase[0]?.rank).toBe(12);
    expect(comparison.on.perCase[0]?.rank).toBe(1);
    expect(comparison.recallDifference?.mean).toBe(1);
    expect(comparison.gate.failures).toEqual([]);
  });

  it('the auto-filter eval checks that the year a case is tagged with is detected', async () => {
    const retriever: Retriever = async (request) => ({
      ms: 1,
      chunks: [],
      ...(request.autoFilter ? { detectedFilter: { concerned_years: ['2023'] } } : {}),
    });
    const comparison = await compareToggle('auto-filter', [golden], retriever, (on) => ({
      autoFilter: on,
    }));

    expect(autoFilterDetections([golden], comparison.on)).toMatchObject({
      checked: 1,
      matched: 0,
      perCase: [{ id: 'g1', expected: ['2024'], missed: ['2024'] }],
    });
  });

  it('EDN maps, vectors, sets, keywords, nil and tagged values read as JSON', () => {
    expect(
      parseEdn('{:a [1 2.5 nil true] :b #{:x} "k" #inst "2026-01-01" ; note\n :c #_ 9 (3)}'),
    ).toEqual({ a: [1, 2.5, null, true], b: ['x'], k: '2026-01-01', c: [3] });
  });
});
