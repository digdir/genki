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

  it('gives the model only tools that read and one that comments', () => {
    const action = review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    const tools = /--allowedTools "([^"]+)"/.exec(action?.with?.claude_args ?? '')?.[1]?.split(',');
    expect(tools).toEqual([
      'mcp__github_inline_comment__create_inline_comment',
      'Read',
      'Grep',
      'Glob',
      'Bash(gh pr diff:*)',
      'Bash(gh pr view:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
    ]);
  });
});
