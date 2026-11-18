import { describe, expect, it } from 'vitest';
import { MARKER as SUMMARY_MARKER, parseFinding } from './review-summary.ts';
import {
  MARKER,
  MAX_FILES,
  MAX_LINES,
  isGenerated,
  measure,
  note,
  oversized,
} from './review-size.ts';

const numstat = (...rows: [number | '-', number | '-', string][]) =>
  rows.map((r) => r.join('\t')).join('\n') + '\n';

describe('the size of a pull request', () => {
  it('counts added and deleted lines and files from git diff --numstat', () => {
    expect(measure(numstat([10, 5, 'apps/api/src/a.ts'], [0, 3, 'README.md']))).toEqual({
      lines: 18,
      files: 2,
    });
  });

  it('leaves out lockfiles, the generated atlas and snapshots', () => {
    expect(
      measure(
        numstat(
          [4000, 3000, 'package-lock.json'],
          [10, 0, 'apps/docs/package-lock.json'],
          [500, 0, 'docs/architecture/system-atlas.html'],
          [300, 0, 'apps/portal/src/__snapshots__/app.test.tsx.snap'],
          [20, 2, 'packages/i18n/src/lockdown.ts'],
        ),
      ),
    ).toEqual({ lines: 22, files: 1 });
  });

  it('counts a binary file as a file without lines', () => {
    expect(measure(numstat(['-', '-', 'docs/image.png']))).toEqual({ lines: 0, files: 1 });
  });

  it('is large above 3000 lines or above 50 files, and not at the limit', () => {
    expect(MAX_LINES).toBe(3000);
    expect(MAX_FILES).toBe(50);
    expect(oversized({ lines: 3000, files: 50 })).toBe(false);
    expect(oversized({ lines: 3001, files: 1 })).toBe(true);
    expect(oversized({ lines: 10, files: 51 })).toBe(true);
  });

  it('tells generated paths apart in linear time on long adversarial paths', () => {
    const started = performance.now();
    isGenerated('a'.repeat(100_000));
    isGenerated('/a'.repeat(50_000));
    isGenerated('.lock'.repeat(20_000) + 'x');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the size note', () => {
  const text = note({ lines: 4210, files: 37 }, 'abcdef0123456789');

  it('says what it measured, at which commit, and what it left out', () => {
    expect(text).toContain('At abcdef0 it changes 4,210 lines in 37 files');
    expect(text).toContain('not counting lockfiles, generated files and snapshots');
  });

  it('suggests a split and says it neither blocks the merge nor is a finding', () => {
    expect(text).toContain('consider doing that');
    expect(text).toContain('not a review finding and does not block the merge');
  });

  it('is never read as a finding, a review or the summary comment', () => {
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text.startsWith(SUMMARY_MARKER)).toBe(false);
    expect(text).not.toMatch(/^[0-9]+ findings/);
    expect(text).not.toMatch(/^\*\*(Important|Nit|Pre-existing)\*\*/m);
    expect(
      parseFinding({
        id: 't',
        isResolved: false,
        path: 'a.ts',
        line: 1,
        url: 'u',
        body: text,
        replies: [],
      }),
    ).toBeNull();
  });

  it('has no em-dash', () => {
    expect(text).not.toContain('\u2014');
  });
});
