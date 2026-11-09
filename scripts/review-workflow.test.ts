import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const text = readFileSync(join(import.meta.dirname, '../.github/workflows/review.yml'), 'utf8');
const workflow = parse(text) as {
  on: Record<string, unknown>;
  concurrency?: unknown;
  permissions: Record<string, string>;
  jobs: {
    resolve: {
      permissions: Record<string, string>;
      steps: { uses?: string; with?: Record<string, string> }[];
    };
    'follow-up': {
      if: string;
      permissions: Record<string, string>;
      steps: {
        id?: string;
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string>;
      }[];
    };
    review: {
      if: string;
      concurrency: unknown;
      permissions: Record<string, string>;
      steps: {
        id?: string;
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, string>;
      }[];
    };
  };
};
const review = workflow.jobs.review;
const action = () => review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
const procedure = readFileSync(
  join(import.meta.dirname, '../.claude/skills/review-change/SKILL.md'),
  'utf8',
);
const rules = readFileSync(join(import.meta.dirname, '../REVIEW.md'), 'utf8');

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

  it('gives the model only tools that read or start a checking agent, and posts its findings itself', () => {
    const action = review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
    const tools = /--allowedTools "([^"]+)"/.exec(action?.with?.claude_args ?? '')?.[1]?.split(',');
    expect(tools).toEqual([
      'Agent',
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

  it('lets an unrelated label leave a running review alone', () => {
    expect(workflow).not.toHaveProperty('concurrency');
    expect(review.concurrency).toEqual({
      group: 'review-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
  });
});

describe('after a push', () => {
  const followUp = workflow.jobs['follow-up'];
  const model = followUp.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));

  it('does not review the pull request again on a push', () => {
    expect(review.if).toContain("github.event.action != 'synchronize'");
    expect(followUp.if).toContain("github.event.action == 'synchronize'");
  });

  it('calls a model only when there are open findings to check', () => {
    for (const step of followUp.steps.filter(
      (s) =>
        s.uses && !s.uses.startsWith('actions/checkout@') && !s.uses.startsWith('jdx/mise-action@'),
    ))
      expect(step.if).toBe("steps.open.outputs.count != '0'");
  });

  it('gives the checking model only tools that read, and the cheaper model', () => {
    const args = model?.with?.claude_args ?? '';
    expect(args).toContain('--model claude-sonnet-5-5');
    const tools = /--allowedTools "([^"]+)"/.exec(args)?.[1]?.split(',') ?? [];
    expect(
      tools.every((t) => /^(Read|Grep|Glob|Bash\(git (diff|log|show|grep|ls-files):\*\))$/.test(t)),
    ).toBe(true);
  });

  it('runs the model with a token that can only read', () => {
    expect(followUp.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
  });

  it('resolves threads in a job that runs no model', () => {
    const resolve = workflow.jobs.resolve;
    expect(resolve.steps.some((s) => s.uses?.startsWith('anthropics/claude-code-action@'))).toBe(
      false,
    );
    expect(resolve.permissions).not.toHaveProperty('id-token');
  });

  it('starts review again from the last full review, not from a follow-up reply', () => {
    const last = review.steps.find((s) => s.id === 'last')?.run ?? '';
    expect(last).toContain('test("^[0-9]+ findings")');
  });

  it('looks for fixes and never for new findings', () => {
    expect(model?.with?.prompt).toContain('Find nothing new.');
  });

  it('skips forks, drafts and dependency bumps like the review does', () => {
    expect(followUp.if).toContain('!github.event.pull_request.draft');
    expect(followUp.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(followUp.if).toContain("github.event.pull_request.user.login != 'renovate[bot]'");
  });
});

describe('one round per pull request', () => {
  it('follows the review procedure and rules from the base branch, with the security checklist every time', () => {
    const prompt = action()?.with?.prompt ?? '';
    expect(prompt).toContain('.claude/skills/review-change/SKILL.md');
    expect(prompt).toContain('git show ${{ github.event.pull_request.base.sha }}:<path>');
    expect(prompt).toContain('.github/review-security.md');
  });

  it('runs every finder at once and verifies every finding before anything is posted', () => {
    expect(procedure).toContain('Start these five subagents (the Agent tool) in one message');
    expect(procedure).toContain('asked to prove it wrong');
    expect(procedure).toContain('needs a search that shows it');
  });

  it('posts all findings together as one review, with evidence, a fix and a one-click suggestion', () => {
    const post = review.steps.find((s) => s.name === 'Post all findings as one review')?.run ?? '';
    expect(post).toContain('gh api "repos/$REPO/pulls/$PR/reviews"');
    expect(post).toContain('**Evidence:**');
    expect(post).toContain('**Fix:**');
    expect(post).toContain('```suggestion');
  });

  it('on review again, looks only at what changed since the last review, in the files the pull request changes', () => {
    expect(action()?.with?.prompt).toContain('git diff {0} HEAD');
    expect(action()?.with?.prompt).toContain('git diff --name-only {1}...HEAD');
  });

  it('reviews the whole pull request again when the last reviewed commit was rebased away', () => {
    const last = review.steps.find((s) => s.id === 'last')?.run ?? '';
    expect(last).toContain('git merge-base --is-ancestor "$sha" HEAD');
  });

  it('posts a review even when it finds nothing, so the next review again knows where to start', () => {
    const post = review.steps.find((s) => s.name === 'Post all findings as one review')?.run ?? '';
    expect(post).not.toContain('then empty');
    expect(post).not.toContain('[ -s review.json ] || exit 0');
  });

  it('never caps findings to hold some back for a later round', () => {
    expect(rules).not.toMatch(/at most (three|\d) Nits/);
    expect(rules).toContain('Report every finding in one review');
  });
});
