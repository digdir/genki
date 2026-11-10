import { describe, expect, it } from 'vitest';
import {
  MARKER,
  parseFinding,
  renderSummary,
  type Finding,
  type Thread,
} from './review-summary.ts';

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 'T1',
  isResolved: false,
  path: 'apps/api/src/routes.ts',
  line: 42,
  url: 'https://github.com/digdir/genki/pull/1#discussion_r1',
  body: '**Important**: Tenant taken from the path\n\nThe route reads the tenant from the path.\n\n<details>\n<summary>Evidence and fix</summary>\n\n**Evidence:** line 42\n\n**Fix:** Take the tenant from the principal.\n\n</details>',
  replies: [],
  ...over,
});

const base = parseFinding(thread());
if (!base) throw new Error('the sample thread must parse');
const finding = (over: Partial<Finding> = {}): Finding => ({ ...base, ...over });

describe('reading a review thread', () => {
  it('takes the severity, the title and the fix from the comment', () => {
    expect(parseFinding(thread())).toMatchObject({
      severity: 'Important',
      title: 'Tenant taken from the path',
      fix: 'Take the tenant from the principal.',
      status: 'open',
    });
  });

  it('shortens an older comment without a title to its first sentence', () => {
    expect(
      parseFinding(
        thread({ body: '**Nit** The pattern misses a path. It also does more.\n\n**Fix:** x' }),
      )?.title,
    ).toBe('The pattern misses a path.');
  });

  it('reads comments in the older form without a colon after the severity', () => {
    expect(parseFinding(thread({ body: '**Nit** Old style\n\n**Fix:** x' }))).toMatchObject({
      severity: 'Nit',
      title: 'Old style',
    });
  });

  it('ignores threads that are not review findings', () => {
    expect(parseFinding(thread({ body: 'A question from a person' }))).toBeNull();
  });

  it('counts a resolved thread as fixed, with the commit the follow-up named', () => {
    const f = parseFinding(
      thread({
        isResolved: true,
        replies: [
          { author: 'github-actions[bot]', body: 'Fixed in `abcdef1234567`: moved the check.' },
        ],
      }),
    );
    expect(f).toMatchObject({ status: 'fixed', fixedIn: 'abcdef1' });
  });

  it('counts a finding as fixed when the follow-up replied, even if the thread could not be resolved', () => {
    expect(
      parseFinding(
        thread({
          replies: [{ author: 'github-actions[bot]', body: 'Fixed in `abcdef1234567`: done.' }],
        }),
      )?.status,
    ).toBe('fixed');
  });

  it('reopens a fixed finding when a person answers the fix and leaves the thread unresolved', () => {
    expect(
      parseFinding(
        thread({
          replies: [
            { author: 'github-actions[bot]', body: 'Fixed in `abcdef1234567`: done.' },
            { author: 'kent', body: 'Still broken on the batch route.' },
          ],
        }),
      ),
    ).toMatchObject({ status: 'open', fixedIn: undefined });
  });

  it('names the latest fix when a reopened finding is fixed again', () => {
    expect(
      parseFinding(
        thread({
          isResolved: true,
          replies: [
            { author: 'github-actions[bot]', body: 'Fixed in `aaaaaaa1234567`: first.' },
            { author: 'kent', body: 'Still broken.' },
            { author: 'github-actions[bot]', body: 'Fixed in `bbbbbbb1234567`: second.' },
          ],
        }),
      ),
    ).toMatchObject({ status: 'fixed', fixedIn: 'bbbbbbb' });
  });

  it('counts a finding as dismissed when the author says it will not be fixed', () => {
    expect(
      parseFinding(
        thread({ replies: [{ author: 'kent', body: 'Not fixing, this route is internal.' }] }),
      )?.status,
    ).toBe('dismissed');
  });
});

describe('the summary comment', () => {
  it('starts with the marker so the next run edits it instead of adding another', () => {
    expect(renderSummary('digdir/genki', 1, [], null, null).startsWith(MARKER)).toBe(true);
  });

  it('counts open, fixed and dismissed findings, and calls out open Important ones', () => {
    const text = renderSummary(
      'digdir/genki',
      1,
      [
        finding(),
        finding({ severity: 'Nit', status: 'fixed' }),
        finding({ severity: 'Nit', status: 'dismissed' }),
      ],
      null,
      null,
    );
    expect(text).toContain('**3 findings**: 1 open (1 Important), 1 fixed, 1 dismissed.');
  });

  it('lists Important findings first, each linking to its thread', () => {
    const text = renderSummary(
      'digdir/genki',
      1,
      [finding({ severity: 'Nit', title: 'Small' }), finding({ title: 'Big' })],
      null,
      null,
    );
    expect(text.indexOf('Big')).toBeLessThan(text.indexOf('Small'));
    expect(text).toContain(
      '[`apps/api/src/routes.ts:42`](https://github.com/digdir/genki/pull/1#discussion_r1)',
    );
  });

  it('gives a prompt for a coding agent with every open finding and its fix, and none when all are closed', () => {
    const open = renderSummary('digdir/genki', 1, [finding()], null, null);
    expect(open).toContain('Fix the open findings with your coding agent');
    expect(open).toContain(
      '1. apps/api/src/routes.ts:42: Tenant taken from the path\n   Fix: Take the tenant from the principal.',
    );
    expect(
      renderSummary('digdir/genki', 1, [finding({ status: 'fixed' })], null, null),
    ).not.toContain('coding agent');
  });

  it('shows the walkthrough with one row per area', () => {
    const text = renderSummary(
      'digdir/genki',
      1,
      [],
      { summary: 'Adds a route.', changes: [{ area: 'apps/api', summary: 'New | route' }] },
      null,
    );
    expect(text).toContain('### Walkthrough\n\nAdds a route.');
    expect(text).toContain('| `apps/api` | New \\| route |');
  });

  it('says which commit and model it reviewed', () => {
    expect(
      renderSummary('digdir/genki', 1, [], null, {
        sha: 'abcdef1234',
        model: 'claude-opus-5-5',
        minutes: 4.25,
      }),
    ).toContain('Reviewed at abcdef1 with claude-opus-5-5 in 4.3 min.');
  });
});
