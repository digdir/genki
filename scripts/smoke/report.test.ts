import { describe, expect, it } from 'vitest';
import type { SmokeReport } from './assess.ts';
import {
  commitStatus,
  failureBody,
  greenBody,
  issueAction,
  rangeText,
  renderTable,
  suspectRange,
  type HistoryNode,
} from './report.ts';

const tested = 'c'.repeat(40);
const green = 'a'.repeat(40);

const report = (over: Partial<SmokeReport> = {}): SmokeReport => ({
  sha: tested,
  api: 'https://api.genki-test.digdir.cloud',
  tiers: ['free', 'cheap', 'core'],
  notes: [],
  spentKr: 0.71,
  outcome: 'fail',
  runUrl: 'https://github.com/digdir/genki/actions/runs/1',
  checks: [
    { id: 'health', tier: 'free', outcome: 'pass', detail: 'ok', attempts: 1, tasks: [] },
    {
      id: 'model:foundry-claude/claude-haiku-5-5',
      tier: 'cheap',
      outcome: 'fail',
      detail: '500 model_error: the service failed',
      attempts: 2,
      tasks: ['t-1', 't-2'],
    },
  ],
  ...over,
});

const history: HistoryNode[] = [
  {
    oid: tested,
    messageHeadline: 'Let signing modules set Authorization (#438)',
    smoke: 'FAILURE',
  },
  { oid: 'b'.repeat(40), messageHeadline: 'Console add model with prefixed deployment (#439)' },
  { oid: 'd'.repeat(40), messageHeadline: 'Fix a typo directly on main' },
  { oid: green, messageHeadline: 'Something earlier (#400)', smoke: 'SUCCESS' },
  { oid: 'e'.repeat(40), messageHeadline: 'Older (#399)', smoke: 'SUCCESS' },
];

describe('suspect range', () => {
  it('runs from the tested commit back to the newest green smoke run, without it', () => {
    const range = suspectRange(history);
    expect(range.green).toBe(green);
    expect(range.commits.map((c) => c.oid)).toEqual([tested, 'b'.repeat(40), 'd'.repeat(40)]);
  });

  it('lists the merged pull requests in the range from squash-merge titles', () => {
    expect(suspectRange(history).pullRequests).toEqual([438, 439]);
  });

  it('ignores a green status on the tested commit itself, as on a rerun', () => {
    const rerun = history.map((n, i) => (i === 0 ? { ...n, smoke: 'SUCCESS' } : n));
    expect(suspectRange(rerun).green).toBe(green);
  });

  it('is unbounded when no commit has a green smoke run', () => {
    const range = suspectRange(history.slice(0, 3));
    expect(range.green).toBeUndefined();
    expect(range.commits).toHaveLength(3);
  });
});

describe('report text', () => {
  it('names the failing checks, their genki runs, the range and its pull requests, and blames none', () => {
    const body = failureBody(report(), 'digdir/genki', suspectRange(history));
    expect(body).toContain('`model:foundry-claude/claude-haiku-5-5`: 500 model_error');
    expect(body).toContain('`t-1`, `t-2`');
    expect(body).toContain(`https://github.com/digdir/genki/compare/${green}...${tested}`);
    expect(body).toContain('#438, #439');
    expect(body).toContain('not a verdict on any pull request');
    expect(body).not.toContain('`health`');
  });

  it('says the range is unknown when the tested commit is not in the repository', () => {
    expect(failureBody(report(), 'digdir/genki', undefined)).toContain('range is unknown');
  });

  it('puts every check in the summary table with attempts and runs', () => {
    const table = renderTable(report());
    expect(table).toContain('| cheap | `model:foundry-claude/claude-haiku-5-5` | **FAIL** | 2 |');
    expect(
      table.split('\n').filter((l) => l.startsWith('| free') || l.startsWith('| cheap')),
    ).toHaveLength(2);
  });
});

describe('commit status', () => {
  it('marks a passed run green', () => {
    expect(commitStatus(report({ outcome: 'pass' }))).toBe('success');
  });

  it('marks a failed run red', () => {
    expect(commitStatus(report({ outcome: 'fail' }))).toBe('failure');
  });

  it('leaves a partial run without a status, so it never counts as the last green', () => {
    expect(commitStatus(report({ outcome: 'partial' }))).toBeUndefined();
  });
});

describe('the smoke issue', () => {
  it('opens one when a run fails and none is open', () => {
    expect(issueAction(report({ outcome: 'fail' }), undefined)).toBe('open');
  });

  it('comments on the open one when a run fails again', () => {
    expect(issueAction(report({ outcome: 'fail' }), 12)).toBe('comment');
  });

  it('closes the open one when a run is green', () => {
    expect(issueAction(report({ outcome: 'pass' }), 12)).toBe('close');
  });

  it('leaves the issue alone after a partial run', () => {
    expect(issueAction(report({ outcome: 'partial' }), 12)).toBe('none');
  });

  it('does nothing on a green run with no open issue', () => {
    expect(issueAction(report({ outcome: 'pass' }), undefined)).toBe('none');
  });

  it('says on closing which commit is green again and links the run', () => {
    expect(greenBody(report({ outcome: 'pass' }))).toBe(
      'Green again at `cccccccc` ([run](https://github.com/digdir/genki/actions/runs/1)). Closing.',
    );
  });

  it('names an unknown version when the run had no SHA', () => {
    expect(failureBody(report({ sha: '' }), 'digdir/genki', undefined)).toMatch(
      /^The smoke test of an unknown version on genki-test failed/,
    );
  });
});

describe('range text', () => {
  it('says the range is not bounded when no green run is in the history', () => {
    const text = rangeText('digdir/genki', tested, suspectRange(history.slice(0, 3)));
    expect(text).toContain('No green smoke run in the last 3 commits');
  });

  it('says so when the range has no merged pull request', () => {
    const direct = [history[0], { oid: green, messageHeadline: 'x', smoke: 'SUCCESS' }].flatMap(
      (n) => (n ? [{ ...n, messageHeadline: 'Fix on main' }] : []),
    );
    expect(rangeText('digdir/genki', tested, suspectRange(direct))).toContain(
      'No merged pull requests found in the range.',
    );
  });

  it('lists a pull request once even if two commits name it', () => {
    const twice = history.map((n, i) => (i === 1 ? { ...n, messageHeadline: 'Again (#438)' } : n));
    expect(suspectRange(twice).pullRequests).toEqual([438]);
  });

  it('is empty for an empty history', () => {
    expect(suspectRange([])).toEqual({ commits: [], pullRequests: [] });
  });
});

describe('summary table', () => {
  it('shows notes and why a check was skipped', () => {
    const table = renderTable(
      report({
        notes: ['SMOKE_API_KEY is not set.'],
        checks: [
          {
            id: 'models',
            tier: 'free',
            outcome: 'skip',
            skipReason: 'key',
            detail: 'no key',
            attempts: 0,
            tasks: [],
          },
        ],
      }),
    );
    expect(table).toContain('SMOKE_API_KEY is not set.');
    expect(table).toContain('| free | `models` | skip | 0 |  |  | key: no key |');
  });
});
