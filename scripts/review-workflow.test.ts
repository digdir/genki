import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const text = readFileSync(join(import.meta.dirname, '../.github/workflows/review.yml'), 'utf8');
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: {
    review: {
      if: string;
      permissions: Record<string, string>;
      steps: { uses?: string; with?: Record<string, string> }[];
    };
  };
};
const review = workflow.jobs.review;

describe('the model review workflow', () => {
  it('runs on pull_request only, never pull_request_target, so a pull request gets no secrets it could misuse', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
  });

  it('skips drafts, forks and dependency bumps', () => {
    expect(review.if).toContain('!github.event.pull_request.draft');
    expect(review.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(review.if).toContain("github.event.pull_request.user.login != 'renovate[bot]'");
  });

  it('can read code and write on pull requests, with no right to push or change the repository', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(review.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      'id-token': 'write',
    });
  });

  it('pins every action to a full commit SHA', () => {
    for (const step of review.steps.filter((s) => s.uses))
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('reaches the model through Foundry with a federated identity, never a stored key', () => {
    const action = review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    expect(action?.with?.use_foundry).toBe('true');
    expect(action?.with).not.toHaveProperty('anthropic_api_key');
    expect(text).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
  });

  it('gives the model only tools that read, start a checking agent, or comment', () => {
    const action = review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    const tools = /--allowedTools "([^"]+)"/.exec(action?.with?.claude_args ?? '')?.[1]?.split(',');
    expect(tools).toEqual([
      'mcp__github_inline_comment__create_inline_comment',
      'Task',
      'Read',
      'Grep',
      'Glob',
      'Bash(gh pr diff:*)',
      'Bash(gh pr view:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git grep:*)',
      'Bash(git ls-files:*)',
    ]);
  });
});

describe('the paths that get the security checklist', () => {
  const pattern = /grep -qE '([^']+)'/.exec(text)?.[1] ?? '';
  const sensitive = new RegExp(pattern);

  it.each([
    'apps/api/src/dev-login.ts',
    'apps/api/src/login-issuers.ts',
    'apps/api/src/gate-runs.ts',
    'apps/api/src/key-policies.ts',
    'apps/api/src/session-upgrade.ts',
    'apps/api/src/tenant-gate.ts',
    'packages/providers-postgres/src/schema.ts',
    'packages/identity/src/claims.ts',
    'infra/main.bicep',
    '.github/workflows/ci.yml',
    'Dockerfile',
  ])('include %s', (path) => {
    expect(sensitive.test(path)).toBe(true);
  });

  it('leave out ordinary screens and docs', () => {
    expect(sensitive.test('apps/portal/src/App.tsx')).toBe(false);
    expect(sensitive.test('docs/development.md')).toBe(false);
  });
});

describe('what the review may post', () => {
  it('posts a finding only after an independent agent has tried to prove it wrong', () => {
    expect(text).toContain('start a Task agent');
    expect(text).toContain('asked to prove it wrong');
  });

  it('needs a search behind every claim that something is missing or matches nothing', () => {
    expect(text).toContain('needs a search that shows it');
  });

  it('shows its evidence and a fix in every comment', () => {
    expect(text).toContain('**Evidence:**');
    expect(text).toContain('**Fix:**');
  });
});
