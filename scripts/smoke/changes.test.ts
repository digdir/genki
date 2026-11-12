import { describe, expect, it } from 'vitest';
import {
  clipDiff,
  groupsOfPath,
  inExperiment,
  loadGroups,
  moreFiles,
  suspectRange,
  targetsOf,
  type HistoryNode,
} from './changes.ts';
import { rangeText } from './report.ts';

const tested = 'c'.repeat(40);
const green = 'a'.repeat(40);

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

describe('check groups by changed path', () => {
  const map = loadGroups();

  it('maps a model provider change to the models group', () => {
    expect(groupsOfPath(map, 'packages/port-model/src/parameters.ts')).toEqual(['models']);
  });

  it('maps a playground change to the playground group', () => {
    expect(groupsOfPath(map, 'apps/api/src/playground.ts')).toEqual(['playground']);
  });

  it('maps one path to every group whose rule names it', () => {
    expect(groupsOfPath(map, 'apps/api/src/run-steps.ts')).toEqual(['runs', 'timeline']);
  });

  it('runs no group for docs and Markdown', () => {
    expect(groupsOfPath(map, 'docs/adr/0008-keys.md')).toBe('none');
    expect(groupsOfPath(map, 'apps/api/README.md')).toBe('none');
  });

  it('ignores the smoke test’s own files', () => {
    expect(groupsOfPath(map, 'scripts/smoke/run.ts')).toBe('none');
  });

  it('treats a path no rule maps as touching every group', () => {
    expect(groupsOfPath(map, 'packages/brand-new/src/index.ts')).toBe('all');
    expect(groupsOfPath(map, 'package-lock.json')).toBe('all');
  });

  it('names only groups the map declares', () => {
    const declared = Object.keys(map.groups);
    for (const rule of map.rules) expect(declared).toContain(rule.group);
  });

  it('runs a group in full for each pull request that touches it, and says which', () => {
    const targets = targetsOf(map, [
      { number: 438, files: ['packages/port-model/src/parameters.ts', 'docs/x.md'] },
      { number: 439, files: ['apps/console/src/App.tsx'] },
    ]);
    expect(targets.full).toEqual(['models', 'console']);
    expect(targets.reasons).toEqual({ models: [438], console: [439] });
    expect(targets.unmapped).toEqual([]);
  });

  it('runs every group in full for an unmapped path, and lists the path', () => {
    const targets = targetsOf(map, [{ number: 440, files: ['packages/brand-new/src/index.ts'] }]);
    expect(targets.full).toEqual(Object.keys(map.groups));
    expect(targets.unmapped).toEqual(['packages/brand-new/src/index.ts']);
  });

  it('runs every group in full for a pull request with more files than GitHub lists', () => {
    expect(targetsOf(map, [{ number: 441, files: [moreFiles] }]).full).toHaveLength(
      Object.keys(map.groups).length,
    );
  });

  it('runs only baselines when nothing was merged', () => {
    expect(targetsOf(map, [])).toEqual({ full: [], reasons: {}, unmapped: [] });
  });
});

describe('the experiment', () => {
  it('counts a pull request merged after 2026-11-09 that the AI review saw', () => {
    expect(inExperiment({ mergedAt: '2026-11-10T09:00:00Z', aiReviewed: true })).toBe(true);
  });

  it('leaves out a pull request merged before the experiment started', () => {
    expect(inExperiment({ mergedAt: '2026-11-08T23:59:59Z', aiReviewed: true })).toBe(false);
  });

  it('leaves out a pull request the AI review never saw', () => {
    expect(inExperiment({ mergedAt: '2026-11-10T09:00:00Z', aiReviewed: false })).toBe(false);
  });
});

describe('diffs for the model', () => {
  it('keeps a short diff whole', () => {
    expect(clipDiff('abc', 10)).toBe('abc');
  });

  it('cuts a long diff and says where', () => {
    expect(clipDiff('a'.repeat(20), 10)).toBe(`${'a'.repeat(10)}\n[diff cut at 10 characters]`);
  });
});
