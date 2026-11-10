// Writes review-run.json, the per-run record the review dashboard reads (digdir.ai-review.run/v1).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type AuthorKind = 'agent' | 'human_ai' | 'unknown';

const AI_TRAILER = /\b(claude|copilot|codex|cursor|gemini|devin|aider|windsurf)\b/i;

export function authorKind(userType: string, login: string, trailers: string): AuthorKind {
  if (userType === 'Bot' || login.endsWith('[bot]')) return 'agent';
  if (AI_TRAILER.test(trailers)) return 'human_ai';
  return 'unknown';
}

export function shadowArm(pr: number, percent: number, action: string): 'treated' | 'shadow' {
  if (action === 'labeled') return 'treated';
  return (pr * 37) % 100 < percent ? 'shadow' : 'treated';
}

interface ExecutionMessage {
  type?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  message?: { content?: { type?: string; name?: string }[] };
}

interface Finding {
  severity: string;
  category?: string;
  title: string;
  path: string;
  line: number;
  start_line?: number;
}

export interface RunInput {
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string;
  runId: string;
  arm: 'treated' | 'shadow';
  reviewAgain: boolean;
  model: string;
  promptVersion: string;
  authorKind: AuthorKind;
  filesChanged: number;
  linesChanged: number;
  startedAt: string;
  output: { findings?: Finding[] } | null;
  execution: ExecutionMessage[];
}

export function runRecord(input: RunInput) {
  const result = input.execution.find((m) => m.type === 'result');
  const subagents = input.execution
    .flatMap((m) => m.message?.content ?? [])
    .filter((c) => c.type === 'tool_use' && c.name === 'Agent').length;
  const findings = input.output?.findings ?? [];
  return {
    schema: 'digdir.ai-review.run/v1',
    repo: input.repo,
    pr_number: input.pr,
    head_sha: input.headSha,
    base_sha: input.baseSha,
    run_id: input.runId,
    arm: input.arm,
    review_again: input.reviewAgain,
    started_at: input.startedAt,
    completed: input.output !== null,
    duration_s: result?.duration_ms != null ? Math.round(result.duration_ms / 1000) : null,
    turns: result?.num_turns ?? null,
    subagents,
    model: input.model,
    prompt_version: input.promptVersion,
    tokens: {
      input: result?.usage?.input_tokens ?? null,
      output: result?.usage?.output_tokens ?? null,
      cache_read: result?.usage?.cache_read_input_tokens ?? null,
    },
    cost_usd: result?.total_cost_usd ?? null,
    author_kind: input.authorKind,
    files_changed: input.filesChanged,
    lines_changed: input.linesChanged,
    findings: findings.map((f) => ({
      severity: f.severity.toLowerCase().replace('-', ''),
      category: f.category ?? null,
      title: f.title,
      path: f.path,
      line_start: f.start_line ?? f.line,
      line_end: f.line,
      posted: input.arm === 'treated',
    })),
  };
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });

function main() {
  const env = (k: string) => process.env[k] ?? '';
  const base = env('BASE');
  const promptVersion = createHash('sha256')
    .update(
      ['.claude/skills/review-change/SKILL.md', 'REVIEW.md', '.github/review-security.md']
        .map((p) => {
          try {
            return git('show', `${base}:${p}`);
          } catch {
            return '';
          }
        })
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 12);
  const trailers = git('log', '--format=%(trailers:key=Co-authored-by,valueonly)', `${base}..HEAD`);
  const execution = ((): ExecutionMessage[] => {
    try {
      return JSON.parse(readFileSync(env('EXECUTION'), 'utf8'));
    } catch {
      return [];
    }
  })();
  const record = runRecord({
    repo: env('REPO'),
    pr: Number(env('PR')),
    headSha: env('HEAD'),
    baseSha: base,
    runId: env('GITHUB_RUN_ID'),
    arm: env('ARM') === 'shadow' ? 'shadow' : 'treated',
    reviewAgain: env('REVIEW_AGAIN') !== '',
    model: env('MODEL'),
    promptVersion,
    authorKind: authorKind(env('USER_TYPE'), env('USER_LOGIN'), trailers),
    filesChanged: Number(env('FILES_CHANGED')),
    linesChanged: Number(env('ADDITIONS')) + Number(env('DELETIONS')),
    startedAt: env('STARTED_AT'),
    output: env('OUT') ? JSON.parse(env('OUT')) : null,
    execution,
  });
  writeFileSync('review-run.json', JSON.stringify(record, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'arm') {
    const arm = shadowArm(
      Number(process.env.PR),
      Number(process.env.PERCENT || 0),
      process.env.ACTION ?? '',
    );
    console.log(`arm=${arm}\nstarted_at=${new Date().toISOString()}`);
  } else main();
}
