import { describe, expect, it } from 'vitest';
import { authorKind, runRecord, shadowArm, type RunInput } from './review-run.ts';

const input = (over: Partial<RunInput> = {}): RunInput => ({
  repo: 'digdir/genki',
  pr: 417,
  headSha: 'abc',
  baseSha: 'def',
  runId: '1',
  arm: 'treated',
  reviewAgain: false,
  model: 'claude-opus-5-5',
  promptVersion: '0123456789ab',
  authorKind: 'human_ai',
  filesChanged: 3,
  linesChanged: 120,
  startedAt: '2026-11-09T10:00:00Z',
  output: {
    findings: [
      {
        severity: 'Pre-existing',
        category: 'security',
        title: 'Old bug',
        path: 'a.ts',
        line: 9,
        start_line: 7,
      },
    ],
  },
  execution: [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Agent' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent' }] } },
    {
      type: 'result',
      total_cost_usd: 1.25,
      duration_ms: 240000,
      num_turns: 30,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
    },
  ],
  ...over,
});

describe('the run record', () => {
  it('follows the v1 contract with cost, tokens, duration and turns from the run', () => {
    expect(runRecord(input())).toMatchObject({
      schema: 'digdir.ai-review.run/v1',
      cost_usd: 1.25,
      duration_s: 240,
      turns: 30,
      tokens: { input: 10, output: 20, cache_read: 30 },
    });
  });

  it('counts the subagents the review started, so a run without finders shows', () => {
    expect(runRecord(input()).subagents).toBe(2);
  });

  it('records findings with severity, category, place and whether they were posted', () => {
    expect(runRecord(input()).findings).toEqual([
      {
        severity: 'preexisting',
        category: 'security',
        title: 'Old bug',
        path: 'a.ts',
        line_start: 7,
        line_end: 9,
        posted: true,
      },
    ]);
    expect(runRecord(input({ arm: 'shadow' })).findings[0]?.posted).toBe(false);
  });

  it('marks a run with no output as not completed', () => {
    expect(runRecord(input({ output: null, execution: [] }))).toMatchObject({
      completed: false,
      cost_usd: null,
      findings: [],
    });
  });

  it('holds no author name, only the kind of author', () => {
    const text = JSON.stringify(runRecord(input()));
    expect(text).not.toMatch(/login|author_name|user/);
  });
});

describe('the kind of author', () => {
  it('is an agent when a bot opened the pull request', () => {
    expect(authorKind('Bot', 'copilot-swe-agent[bot]', '')).toBe('agent');
  });

  it('is a person with AI help when a commit names an AI co-author', () => {
    expect(authorKind('User', 'someone', 'Claude Opus 5.5 <noreply@anthropic.com>\n')).toBe(
      'human_ai',
    );
  });

  it('is unknown otherwise, since no trailer does not prove no AI', () => {
    expect(authorKind('User', 'someone', '')).toBe('unknown');
  });
});

describe('the silent group', () => {
  it('puts the same share of pull requests in it as the percent says, by pull request number', () => {
    const shadow = Array.from({ length: 100 }, (_, i) => shadowArm(i + 1000, 30, 'opened')).filter(
      (a) => a === 'shadow',
    );
    expect(shadow).toHaveLength(30);
  });

  it('is empty when the percent is zero', () => {
    expect(shadowArm(1000, 0, 'opened')).toBe('treated');
  });

  it('always posts when someone asks with review again', () => {
    expect(shadowArm(1000, 100, 'labeled')).toBe('treated');
  });
});
