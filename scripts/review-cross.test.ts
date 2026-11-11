import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commentBody,
  diskWorkspace,
  isSensitive,
  LIMITS,
  MARKER,
  mustFinish,
  orderDiff,
  parseDiff,
  readFileTool,
  reviewPayload,
  runRecord,
  runReview,
  searchTool,
  select,
  type Completion,
  type Finding,
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
    over: Completion['choices'] = [],
    usage = { prompt_tokens: 1000, completion_tokens: 100 },
  ) => ({
    choices: over,
    usage,
  });

  it('runs the tools the model asks for and returns its findings', async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers: Completion[] = [
      reply([
        {
          message: {
            tool_calls: [
              {
                id: '1',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"a.ts","start_line":null,"end_line":null}',
                },
              },
            ],
          },
        },
      ]),
      reply([{ message: { content: JSON.stringify({ findings: [finding()] }) } }]),
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
    const second = bodies[1]?.messages as { role: string; content: string }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: 'a.ts lines 1-1 of 1\n1: code' });
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
          ? reply([{ message: { content: '{"findings":[]}' } }])
          : reply(
              [
                {
                  message: {
                    tool_calls: [
                      { id: '1', function: { name: 'search', arguments: '{"text":"abc"}' } },
                    ],
                  },
                },
              ],
              {
                prompt_tokens: 2000,
                completion_tokens: 10,
              },
            );
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
        return reply([
          {
            message: {
              tool_calls: [{ id: '1', function: { name: 'search', arguments: '{"text":"abc"}' } }],
            },
          },
        ]);
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
      complete: async () => reply([{ message: { content: 'not json' } }]),
    });
    expect(out.output).toBeNull();
  });

  it('finishes on the last allowed turn or when the next call could pass the budget', () => {
    expect(mustFinish({ turns: LIMITS.turns - 1, input: 0, output: 0, cached: 0 }, 0)).toBe(true);
    expect(mustFinish({ turns: 1, input: 450_000, output: 0, cached: 0 }, 50_000)).toBe(true);
    expect(mustFinish({ turns: 1, input: 10_000, output: 1000, cached: 0 }, 10_000)).toBe(false);
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
      spent: { turns: 3, input: 10, output: 5, cached: 2 },
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
});
