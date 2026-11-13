import { describe, expect, it } from 'vitest';
import type { SmokeReport } from './assess.ts';
import { suspectRange, type HistoryNode } from './changes.ts';
import {
  assess,
  commitStatus,
  failureLine,
  greenBody,
  issueAction,
  issueBody,
  renderTable,
  sanitize,
  missingBundle,
} from './report.ts';
import type { Finding } from './review.ts';

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
      group: 'models',
      outcome: 'fail',
      detail: '500 model_error: the service failed',
      attempts: 2,
      tasks: ['t-1', 't-2'],
    },
  ],
  ...over,
});

const history: HistoryNode[] = [
  { oid: tested, messageHeadline: 'Retry without temperature (#438)', smoke: 'FAILURE' },
  { oid: 'b'.repeat(40), messageHeadline: 'Console add model (#439)' },
  { oid: green, messageHeadline: 'Something earlier (#400)', smoke: 'SUCCESS' },
];

const targets = { full: ['models'], reasons: { models: [438] }, unmapped: [] };
const prs = [
  { number: 438, mergedAt: '2026-11-10T08:00:00Z', aiReviewed: true },
  { number: 439, mergedAt: '2026-11-10T09:00:00Z', aiReviewed: false },
];
const bundle = { report: report(), targets, prs };

const judged = {
  findings: [
    {
      title: 'Validation errors are English on a Norwegian page',
      severity: 'medium',
      evidence: 'screens/portal-services-smoke-test.txt shows "Too big"',
      checks: ['health'],
      suspectedPrs: [439, 999],
    },
  ],
};

describe('report text', () => {
  const body = () => {
    const a = assess(bundle, undefined, judged);
    return issueBody(report(), 'digdir/genki', suspectRange(history), targets, a);
  };

  it('names the failing check and the pull requests that touched its group as suspected', () => {
    expect(body()).toContain(
      '**high** (check): `model:foundry-claude/claude-haiku-5-5 failed`. `500 model_error: the service failed` Suspected: #438.',
    );
  });

  it('adds the model’s findings with only pull requests from this run', () => {
    expect(body()).toContain('(model): `Validation errors are English on a Norwegian page`');
    expect(body()).toContain('Suspected: #439.');
    expect(body()).not.toContain('#999');
  });

  it('counts findings by layer', () => {
    expect(body()).toContain('Found by the checks: 1. Found only by the model review: 1.');
  });

  it('lists as escaped candidates only suspects merged after the start that the AI review saw', () => {
    expect(body()).toContain('- #438: `model:foundry-claude/claude-haiku-5-5 failed`');
    expect(body()).not.toContain('- #439:');
  });

  it('says why each group ran in full', () => {
    expect(body()).toContain('- `models` in full, for #438');
  });

  it('names a range and suspects, never a culprit', () => {
    expect(body()).toContain(`https://github.com/digdir/genki/compare/${green}...${tested}`);
    expect(body()).toContain('not a verdict on anyone');
  });

  it('says the range is unknown when the tested commit is not in the repository', () => {
    const a = assess(bundle, undefined, {});
    expect(issueBody(report(), 'digdir/genki', undefined, targets, a)).toContain(
      'range is unknown',
    );
  });

  it('names an unknown version when the run had no SHA', () => {
    const a = assess(bundle, undefined, {});
    expect(issueBody(report({ sha: '' }), 'digdir/genki', undefined, targets, a)).toMatch(
      /^The smoke test of an unknown version on genki-test failed/,
    );
  });

  it('puts every check in the summary table with its group, attempts and runs', () => {
    const table = renderTable(report());
    expect(table).toContain('| models | `model:foundry-claude/claude-haiku-5-5` | **FAIL** | 2 |');
  });

  it('shows a known failure with its issue in the table', () => {
    const table = renderTable(
      report({
        checks: [
          {
            id: 'timeline:agent-detect-dfo',
            tier: 'core',
            group: 'timeline',
            outcome: 'known',
            knownIssue: '#442',
            detail: 'not detected: DFØ',
            attempts: 2,
            tasks: [],
          },
        ],
      }),
    );
    expect(table).toContain(
      '| timeline | `timeline:agent-detect-dfo` | known failure | 2 |  |  | not detected: DFØ (#442) |',
    );
  });
});

describe('the layers', () => {
  it('counts a failed extra check as found by the model review', () => {
    const extra = {
      proposed: 1,
      rejected: [],
      spentKr: 0.1,
      checks: [
        {
          id: 'extra:1:screen',
          tier: 'free' as const,
          outcome: 'fail' as const,
          detail: 'error shown: Kunne ikke hente dataene',
          attempts: 1,
          tasks: [],
          why: 'the console lists models differently now',
          pullRequest: 439,
        },
      ],
    };
    const a = assess(bundle, extra, {});
    expect(a.counts).toEqual({ checks: 1, model: 1 });
    expect(a.fromModel[0]?.suspectedPrs).toEqual([439]);
  });

  it('does not count a model finding that only repeats a failed check', () => {
    const repeat = {
      findings: [
        {
          title: 'Haiku fails',
          severity: 'high',
          evidence: 'answers/model.json',
          checks: ['model:foundry-claude/claude-haiku-5-5'],
          suspectedPrs: [],
        },
      ],
    };
    expect(assess(bundle, undefined, repeat).counts).toEqual({ checks: 1, model: 0 });
  });

  it('ignores model output that is not the expected shape', () => {
    expect(assess(bundle, undefined, 'not json at all').counts.model).toBe(0);
    expect(assess(bundle, undefined, { findings: [{ title: '' }] }).counts.model).toBe(0);
  });
});

describe('model text before it is posted', () => {
  it('removes JWTs, genki keys and other long random strings', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnop'].join(
      '.',
    );
    expect(sanitize(`see ${jwt}`)).toBe('`see [removed]`');
    expect(sanitize('key gp_AbCdEfGhIjKlMnOpQrStUvWx12')).toBe('`key [removed]`');
    expect(sanitize(`token ${'aB3'.repeat(15)}`)).toBe('`token [removed]`');
  });

  it('removes email addresses', () => {
    expect(sanitize('mail ola.nordmann@digdir.no now')).toBe('`mail [removed] now`');
  });

  it('keeps commit SHAs, file paths and links into the repository', () => {
    const text =
      'commit 96305c019aafa0db6f985cea5e6499a7f0fee357 in apps/portal/src/components/playground/PlaygroundPanel.tsx';
    expect(sanitize(text)).toBe(`\`${text}\``);
  });

  it('puts model text in a code span, so links, images, mentions, references and HTML stay text', () => {
    expect(
      sanitize('![x](//evil.example/a) www.evil.example @someone other/repo#5 <img src=x>'),
    ).toBe('`![x](//evil.example/a) www.evil.example @someone other/repo#5 <img src=x>`');
  });

  it('cannot close the code span', () => {
    expect(sanitize('a ` [x](https://evil.example)')).toBe("`a ' [x](https://evil.example)`");
  });

  it('cuts long text', () => {
    expect(sanitize('word '.repeat(300), 20)).toHaveLength(22);
  });

  it('sanitizes a long adversarial string in linear time', () => {
    const started = performance.now();
    sanitize('eyJ'.repeat(70_000) + 'aB3'.repeat(70_000) + 'a@'.repeat(70_000));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('posts no mention, foreign link or HTML from a model finding in the issue body', () => {
    const hostile = {
      findings: [
        {
          title: '@someone see https://evil.example',
          severity: 'high',
          evidence: '<img src=x> ![p](https://evil.example/p.png)',
          checks: [],
          suspectedPrs: [438],
        },
      ],
    };
    const text = issueBody(
      report(),
      'digdir/genki',
      undefined,
      targets,
      assess(bundle, undefined, hostile),
    );
    for (const line of text.split('\n').filter((l) => l.includes('evil')))
      expect(line).toMatch(/`[^`]*evil[^`]*`/);
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

  it('opens one for a high model finding on a passing run', () => {
    const high: Finding = {
      source: 'model',
      title: 'x',
      severity: 'high',
      evidence: 'y',
      checks: [],
      suspectedPrs: [],
    };
    expect(issueAction(report({ outcome: 'pass' }), undefined, [high])).toBe('open');
  });

  it('keeps the issue open while a high model finding remains', () => {
    const high: Finding = {
      source: 'model',
      title: 'x',
      severity: 'high',
      evidence: 'y',
      checks: [],
      suspectedPrs: [],
    };
    expect(issueAction(report({ outcome: 'pass' }), 12, [high])).toBe('comment');
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

describe('a smoke job without a result', () => {
  it('fails on the tested commit and opens the issue', () => {
    const { report } = missingBundle('96305c019aafa0db6f985cea5e6499a7f0fee357', 'https://run');
    expect(report.outcome).toBe('fail');
    expect(commitStatus(report)).toBe('failure');
    expect(issueAction(report, undefined)).toBe('open');
    expect(report.runUrl).toBe('https://run');
  });
});

describe('the failure line', () => {
  it('names the outcome and the failing check ids', () => {
    expect(failureLine(report())).toBe('smoke outcome fail: model:foundry-claude/claude-haiku-5-5');
  });

  it('says so when no check is recorded as failed', () => {
    expect(failureLine(report({ checks: [] }))).toBe(
      'smoke outcome fail: no failing check recorded',
    );
  });
});
