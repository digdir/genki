import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commentBody,
  costUsd,
  diskWorkspace,
  foundryError,
  isSensitive,
  LIMITS,
  MARKER,
  mustFinish,
  orderDiff,
  parseDiff,
  readFileTool,
  reasoningEffort,
  responsesClient,
  reviewPayload,
  runRecord,
  runReview,
  searchTool,
  select,
  type Finding,
  type ModelResponse,
  type OutputItem,
  type Workspace,
} from './review-cross.ts';
import { parseFinding } from './review-summary.ts';

const diffText = [
  'diff --git a/apps/api/src/tenant-gate.ts b/apps/api/src/tenant-gate.ts',
  'index 1..2 100644',
  '--- a/apps/api/src/tenant-gate.ts',
  '+++ b/apps/api/src/tenant-gate.ts',
  '@@ -10,4 +10,6 @@ export function gate() {',
  ' a',
  '+b',
  '+c',
  ' d',
  '@@ -40,2 +42,3 @@',
  ' e',
  '+f',
  'diff --git a/README.md b/README.md',
  'deleted file mode 100644',
  '--- a/README.md',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
].join('\n');

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: 'Important',
  rule: 'let one tenant read',
  title: 'Tenant taken from the path',
  path: 'apps/api/src/tenant-gate.ts',
  line: 12,
  start_line: null,
  problem: 'The route trusts the path.',
  abuser: 'A key of tenant B sends a request for tenant A.',
  reach: 'Every tenant.',
  evidence: 'apps/api/src/tenant-gate.ts:12 reads params.tenant.',
  fix: 'Take it from the principal.',
  ...over,
});

const memory = (files: Record<string, string>): Workspace => ({
  has: (p) => p in files,
  paths: () => Object.keys(files),
  read: (p) => files[p] ?? null,
});

describe('which pull requests get the cross-model review', () => {
  it('counts auth, tenancy, the model gate, rights, migrations, infra, workflows and the Dockerfile as sensitive', () => {
    for (const path of [
      'packages/identity/src/authenticate.ts',
      'packages/guardrails/src/index.ts',
      'apps/api/src/tenant-gate.ts',
      'packages/kernel/src/gate.ts',
      'apps/api/src/rights.ts',
      'packages/composition/src/tenant-secrets.ts',
      'packages/providers-postgres/src/migrations/0001.sql',
      'infra/main.bicep',
      '.github/workflows/review.yml',
      'Dockerfile',
    ])
      expect(isSensitive(path), path).toBe(true);
  });

  it('leaves ordinary screens, docs and packages out', () => {
    for (const path of ['apps/portal/src/screens/Chat.tsx', 'docs/development.md', 'README.md'])
      expect(isSensitive(path), path).toBe(false);
  });

  it('decides on a long adversarial path in linear time', () => {
    const start = performance.now();
    isSensitive(`${'a/'.repeat(50_000)}${'auth'.repeat(50_000)}x`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('placing findings on the diff', () => {
  it('reads the new-side hunks of each changed file and skips deleted files', () => {
    const files = parseDiff(diffText);
    expect(files.get('apps/api/src/tenant-gate.ts')?.hunks).toEqual([
      [10, 15],
      [42, 44],
    ]);
    expect(files.has('README.md')).toBe(false);
  });

  it('posts only findings with file and line evidence and who could abuse it how far', () => {
    const diff = parseDiff(diffText);
    const out = select(
      {
        findings: [
          finding(),
          finding({ line: 43, evidence: 'it looks wrong' }),
          finding({ line: 44, abuser: ' ' }),
          finding({ line: 42, reach: '' }),
        ],
      },
      diff,
      [],
    );
    expect(out.map((f) => f.line)).toEqual([12]);
  });

  it('drops findings on files the pull request does not change, so nothing on main is disclosed', () => {
    const out = select(
      {
        findings: [
          finding({ path: 'apps/api/src/rights.ts', evidence: 'apps/api/src/rights.ts:3' }),
        ],
      },
      parseDiff(diffText),
      [],
    );
    expect(out).toEqual([]);
  });

  it('moves a line outside the hunks to the nearest changed line, and keeps a range only inside one hunk', () => {
    const diff = parseDiff(diffText);
    const [moved, ranged, crossing] = select(
      {
        findings: [
          finding({ line: 20 }),
          finding({ line: 14, start_line: 11, path: 'x.ts', evidence: 'x.ts:1' }),
          finding({ line: 43, start_line: 12 }),
        ],
      },
      new Map([...diff, ['x.ts', { hunks: [[10, 20]] as [number, number][] }]]),
      [],
    );
    expect(moved?.line).toBe(15);
    expect(ranged).toMatchObject({ line: 14, start_line: 11 });
    expect(crossing).toMatchObject({ line: 43, start_line: null });
  });

  it('does not post again what the first review already found on the same lines', () => {
    const out = select(
      { findings: [finding({ line: 12 }), finding({ line: 43, title: 'Other' })] },
      parseDiff(diffText),
      [{ path: 'apps/api/src/tenant-gate.ts', line: 14, startLine: null, title: 'Same' }],
    );
    expect(out.map((f) => [f.line, f.duplicate])).toEqual([
      [12, true],
      [43, false],
    ]);
    expect(reviewPayload(out, 'abc', 'gpt-x').comments.map((c) => c.line)).toEqual([43]);
  });

  it('posts at most the cap of new findings, Important first', () => {
    const many = Array.from({ length: LIMITS.findings + 5 }, (_, i) =>
      finding({
        path: `f${i}.ts`,
        evidence: `f${i}.ts:1`,
        severity: i === LIMITS.findings + 4 ? 'Important' : 'Nit',
      }),
    );
    const diff = new Map(many.map((f) => [f.path, { hunks: [[1, 20]] as [number, number][] }]));
    const out = select({ findings: many }, diff, []);
    expect(out.length).toBe(LIMITS.findings);
    expect(out[0]?.path).toBe(`f${LIMITS.findings + 4}.ts`);
  });
});

describe('the posted comments', () => {
  it('use the main review format, so the summary, the follow-up and the dashboard read them', () => {
    const body = commentBody(finding(), 'gpt-x');
    const parsed = parseFinding({
      id: 't',
      isResolved: false,
      path: 'a',
      line: 1,
      url: 'u',
      body,
      replies: [],
    });
    expect(parsed).toMatchObject({
      severity: 'Important',
      title: 'Tenant taken from the path',
      rule: 'let one tenant read',
      fix: 'Take it from the principal.',
      status: 'open',
    });
    expect(body).toMatch(/^\*\*(Important|Nit|Pre-existing)\*\*/);
  });

  it('are marked as the cross-model reviewer and say who could abuse it and how far it reaches', () => {
    const body = commentBody(finding(), 'gpt-x');
    expect(body).toContain(MARKER);
    expect(body).toContain('Cross-model review by `gpt-x`');
    expect(body).toContain('**Who could abuse it:**');
    expect(body).toContain('**How far it reaches:**');
  });

  it('never start the review body like a main review, so review again still starts from the main review', () => {
    const payload = reviewPayload([{ ...finding(), duplicate: false }], 'abc', 'gpt-x');
    expect(payload.body).not.toMatch(/^[0-9]+ findings/);
    expect(payload.event).toBe('COMMENT');
  });
});

describe('the read-only tools the model gets', () => {
  const ws = memory({ 'a.ts': 'one\ntwo\nthree', 'b.ts': 'two too' });

  it('reads only tracked files', () => {
    expect(readFileTool(ws, { path: '../../etc/passwd', start_line: null, end_line: null })).toBe(
      'No tracked file at that path.',
    );
    expect(readFileTool(ws, { path: 'a.ts', start_line: 2, end_line: 3 })).toBe(
      'a.ts lines 2-3 of 3\n2: two\n3: three',
    );
  });

  it('searches for literal text, never a pattern', () => {
    expect(searchTool(ws, { text: 'two' })).toBe('a.ts:2: two\nb.ts:1: two too');
    expect(searchTool(ws, { text: '.*' })).toBe('Give a literal text of 3 to 200 characters.');
    expect(searchTool(ws, { text: 't.o' })).toBe('No matches.');
  });

  it('refuses a tracked symlink that points outside the checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'cross-'));
    const outside = mkdtempSync(join(tmpdir(), 'cross-out-'));
    writeFileSync(join(outside, 'secret'), 'token');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'ok');
    symlinkSync(join(outside, 'secret'), join(root, 'src/link.ts'));
    const disk = diskWorkspace(root, ['src/a.ts', 'src/link.ts']);
    expect(disk.read('src/a.ts')).toBe('ok');
    expect(disk.read('src/link.ts')).toBeNull();
  });

  it('refuses a tracked file that is not a regular file without blocking on it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cross-'));
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(diskWorkspace(root, ['pipe']).read('pipe')).toBeNull();
  });

  it('refuses a tracked file over one megabyte', () => {
    const root = mkdtempSync(join(tmpdir(), 'cross-'));
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(1_000_001));
    writeFileSync(join(root, 'small.txt'), 'x');
    const disk = diskWorkspace(root, ['big.txt', 'small.txt']);
    expect(disk.read('big.txt')).toBeNull();
    expect(disk.read('small.txt')).toBe('x');
  });
});

describe('the diff the model sees', () => {
  it('puts the security-sensitive files first and leaves out the lock file', () => {
    const diff = [
      'diff --git a/README.md b/README.md\n+x\n',
      'diff --git a/package-lock.json b/package-lock.json\n+y\n',
      'diff --git a/infra/main.bicep b/infra/main.bicep\n+z\n',
    ].join('');
    const out = orderDiff(diff);
    expect(out.indexOf('infra/main.bicep')).toBeLessThan(out.indexOf('README.md'));
    expect(out).not.toContain('+y');
  });

  it('stays under the character cap', () => {
    const big = `diff --git a/infra/a b/infra/a\n${'+x\n'.repeat(1000)}`;
    const out = orderDiff(big + big.replaceAll('infra/a', 'infra/b'), 4000);
    expect(out.length).toBeLessThan(4200);
    expect(out).toContain('(diff left out; read the file with read_file)');
  });
});

describe('the model loop', () => {
  const reply = (
    output: OutputItem[] = [],
    usage: ModelResponse['usage'] = { input_tokens: 1000, output_tokens: 100 },
  ): ModelResponse => ({ status: 'completed', output, usage });
  const answer = (text: string): OutputItem => ({
    type: 'message',
    content: [{ type: 'output_text', text }],
  });
  const call = (name: string, args: string, id = 'c1'): OutputItem => ({
    type: 'function_call',
    call_id: id,
    name,
    arguments: args,
  });

  it('runs the tools the model asks for and returns its findings', async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers: ModelResponse[] = [
      reply([
        { type: 'reasoning' },
        call('read_file', '{"path":"a.ts","start_line":null,"end_line":null}'),
      ]),
      reply([answer(JSON.stringify({ findings: [finding()] }))]),
    ];
    const out = await runReview({
      system: 's',
      user: 'u',
      workspace: memory({ 'a.ts': 'code' }),
      model: 'gpt-x',
      complete: async (body) => {
        bodies.push(structuredClone(body));
        return answers.shift() ?? reply();
      },
    });
    expect(out.output?.findings).toHaveLength(1);
    expect(out.spent).toMatchObject({ turns: 2, input: 2000, output: 200 });
    expect((bodies[1]?.input as unknown[]).slice(-2)).toEqual([
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'read_file',
        arguments: '{"path":"a.ts","start_line":null,"end_line":null}',
      },
      { type: 'function_call_output', call_id: 'c1', output: 'a.ts lines 1-1 of 1\n1: code' },
    ]);
  });

  it('keeps the read tools to tracked files when the model asks for a path outside', async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers = [
      reply([call('read_file', '{"path":"../.env","start_line":null,"end_line":null}')]),
      reply([answer('{"findings":[]}')]),
    ];
    await runReview({
      system: 's',
      user: 'u',
      workspace: memory({ 'a.ts': 'code' }),
      model: 'gpt-x',
      complete: async (body) => {
        bodies.push(structuredClone(body));
        return answers.shift() ?? reply();
      },
    });
    expect((bodies[1]?.input as { output?: string }[]).at(-1)?.output).toBe(
      'No tracked file at that path.',
    );
  });

  it('counts reasoning tokens as output once, since the output tokens already include them', async () => {
    const out = await runReview({
      system: 's',
      user: 'u',
      workspace: memory({}),
      model: 'gpt-x',
      complete: async () =>
        reply([answer('{"findings":[]}')], {
          input_tokens: 5000,
          output_tokens: 900,
          input_tokens_details: { cached_tokens: 4000 },
          output_tokens_details: { reasoning_tokens: 700 },
        }),
    });
    expect(out.spent).toEqual({ turns: 1, input: 5000, output: 900, cached: 4000, reasoning: 700 });
    expect(costUsd(out.spent, '1', '10')).toBeCloseTo(0.014);
  });

  it('asks for the findings without tools once the token budget is nearly spent', async () => {
    const bodies: Record<string, unknown>[] = [];
    const out = await runReview({
      system: 's',
      user: 'u',
      workspace: memory({}),
      model: 'gpt-x',
      limits: { ...LIMITS, inputTokens: 3000 },
      complete: async (body) => {
        bodies.push(body);
        return body.tool_choice === 'none'
          ? reply([answer('{"findings":[]}')])
          : reply([call('search', '{"text":"abc"}')], { input_tokens: 2000, output_tokens: 10 });
      },
    });
    expect(bodies.map((b) => b.tool_choice)).toEqual(['auto', 'none']);
    expect(out).toMatchObject({ output: { findings: [] }, stopped: true });
  });

  it('never runs more turns than the cap', async () => {
    let calls = 0;
    await runReview({
      system: 's',
      user: 'u',
      workspace: memory({}),
      model: 'gpt-x',
      limits: { ...LIMITS, turns: 3 },
      complete: async () => {
        calls++;
        return reply([call('search', '{"text":"abc"}')]);
      },
    });
    expect(calls).toBe(3);
  });

  it('treats an answer that is not JSON as no output instead of failing', async () => {
    const out = await runReview({
      system: 's',
      user: 'u',
      workspace: memory({}),
      model: 'gpt-x',
      complete: async () => reply([answer('not json')]),
    });
    expect(out.output).toBeNull();
  });

  it('finishes on the last allowed turn or when the next call could pass the budget', () => {
    const spent = { turns: 1, input: 0, output: 0, cached: 0, reasoning: 0 };
    expect(mustFinish({ ...spent, turns: LIMITS.turns - 1 }, 0)).toBe(true);
    expect(mustFinish({ ...spent, input: 450_000 }, 50_000)).toBe(true);
    expect(mustFinish({ ...spent, input: 10_000, output: 1000 }, 10_000)).toBe(false);
  });

  it('takes the reasoning effort from the variable, medium by default, and refuses anything else', () => {
    expect(reasoningEffort(undefined)).toBe('medium');
    expect(reasoningEffort(' ')).toBe('medium');
    expect(reasoningEffort('high')).toBe('high');
    expect(() => reasoningEffort('max; rm -rf')).toThrow(/CROSS_REVIEW_REASONING/);
  });
});

describe('the Foundry Responses client', () => {
  const serve = async (
    handle: (path: string, body: Record<string, unknown>) => { status: number; json: unknown },
  ) => {
    const seen: { path: string; auth: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', body });
        const out = handle(req.url ?? '', body);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}/openai/v1`, seen, close: () => server.close() };
  };

  it('runs the review on /v1/responses with reasoning set and no Chat Completions fields', async () => {
    let turn = 0;
    const fake = await serve(() => {
      turn++;
      return {
        status: 200,
        json:
          turn === 1
            ? {
                status: 'completed',
                output: [
                  { type: 'reasoning', id: 'rs_1', summary: [] },
                  {
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'search',
                    arguments: '{"text":"gate"}',
                  },
                ],
                usage: {
                  input_tokens: 1200,
                  output_tokens: 300,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 250 },
                },
              }
            : {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: JSON.stringify({ findings: [finding()] }) },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1500,
                  output_tokens: 400,
                  input_tokens_details: { cached_tokens: 1000 },
                  output_tokens_details: { reasoning_tokens: 100 },
                },
              },
      };
    });
    try {
      const out = await runReview({
        system: 'rules',
        user: 'diff',
        workspace: memory({ 'a.ts': 'the gate' }),
        model: 'gpt-x',
        reasoning: 'high',
        complete: responsesClient(fake.base, 'tok'),
      });
      expect(out.output?.findings).toHaveLength(1);
      expect(out.spent).toEqual({
        turns: 2,
        input: 2700,
        output: 700,
        cached: 1000,
        reasoning: 350,
      });
      expect(fake.seen.map((s) => s.path)).toEqual([
        '/openai/v1/responses',
        '/openai/v1/responses',
      ]);
      expect(fake.seen[0]?.auth).toBe('Bearer tok');
      for (const { body } of fake.seen) {
        expect(body).toMatchObject({
          model: 'gpt-x',
          instructions: 'rules',
          reasoning: { effort: 'high' },
          store: false,
          text: { format: { type: 'json_schema', name: 'cross_review', strict: true } },
        });
        expect(body.max_output_tokens).toBeGreaterThan(0);
        for (const field of [
          'messages',
          'response_format',
          'max_completion_tokens',
          'max_tokens',
          'reasoning_effort',
        ])
          expect(body).not.toHaveProperty(field);
        for (const tool of body.tools as Record<string, unknown>[]) {
          expect(tool).toMatchObject({ type: 'function', strict: true });
          expect(tool).not.toHaveProperty('function');
        }
      }
      expect((fake.seen[1]?.body.input as unknown[]).slice(-1)).toEqual([
        { type: 'function_call_output', call_id: 'call_1', output: 'a.ts:1: the gate' },
      ]);
    } finally {
      fake.close();
    }
  });

  it('says in the error what Foundry objected to, not only the status', async () => {
    const fake = await serve(() => ({
      status: 400,
      json: {
        error: {
          message:
            "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
          type: 'invalid_request_error',
          param: 'reasoning_effort',
          code: null,
        },
      },
    }));
    try {
      await expect(responsesClient(fake.base, 'tok')({ model: 'gpt-x' })).rejects.toThrow(
        "Foundry answered 400 invalid_request_error param=reasoning_effort: Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
      );
    } finally {
      fake.close();
    }
  });

  it('keeps the error to one short line without the token or anything like a key', () => {
    const token = ['test', 'access', 'token', 'q'.repeat(12)].join('-');
    const text = foundryError(
      401,
      {
        error: {
          message: `Token ${token} rejected.\nAuthorization: Bearer abc.def\nkey sk${'A'.repeat(40)} ${'x '.repeat(400)}`,
          type: 'auth error\n',
          code: 'Unauthorized',
        },
      },
      token,
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain('abc.def');
    expect(text).not.toContain('A'.repeat(32));
    expect(text).not.toMatch(/[\n\r]/);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toMatch(
      /^Foundry answered 401 autherror code=Unauthorized: Token \[redacted\] rejected\./,
    );
  });

  it('still names the status when the error body is not JSON', () => {
    expect(foundryError(502, null)).toBe('Foundry answered 502');
  });

  it('cleans a long adversarial error message in linear time', () => {
    const start = performance.now();
    foundryError(400, {
      error: { message: `${'a'.repeat(31)} `.repeat(50_000) + 'b'.repeat(200_000) },
    });
    foundryError(400, { error: { message: `bearer ${' '.repeat(200_000)}x` } });
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('the run record', () => {
  it('counts posted, duplicate and silent findings without posting anything in the silent group', () => {
    const base = {
      repo: 'digdir/genki',
      pr: 1,
      headSha: 'h',
      baseSha: 'b',
      runId: '9',
      model: 'gpt-x',
      promptVersion: 'p',
      startedAt: '2026-11-11T10:00:00Z',
      sensitivePaths: 2,
      output: { findings: [finding(), finding()] },
      findings: [
        { ...finding(), duplicate: false },
        { ...finding({ line: 43 }), duplicate: true },
      ],
      spent: { turns: 3, input: 10, output: 5, cached: 2, reasoning: 1 },
      stopped: false,
    };
    const treated = runRecord({ ...base, arm: 'treated', posted: true });
    expect(treated.schema).toBe('digdir.ai-review.cross-run/v1');
    expect(treated.findings.map((f) => [f.posted, f.duplicate])).toEqual([
      [true, false],
      [false, true],
    ]);
    const silent = runRecord({ ...base, arm: 'shadow', posted: false });
    expect(silent.findings.every((f) => !f.posted)).toBe(true);
  });

  it('computes the cost from the tokens and the per-million prices', () => {
    const spent = { turns: 1, input: 2_000_000, output: 500_000, cached: 0, reasoning: 0 };
    expect(costUsd(spent, '1.25', '10')).toBeCloseTo(7.5);
  });

  it('records no cost without two numeric prices', () => {
    const spent = { turns: 1, input: 1000, output: 1000, cached: 0, reasoning: 0 };
    expect(costUsd(spent, undefined, '10')).toBeNull();
    expect(costUsd(spent, '1', '')).toBeNull();
    expect(costUsd(spent, 'cheap', '10')).toBeNull();
  });
});
