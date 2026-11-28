import { describe, expect, it } from 'vitest';
import { quarantinedTests, quarantineProblems } from './quarantine-check.ts';

const today = '2026-11-28';
const name = 'scripts/a.test.ts > a suite > keeps a rule';
const known = new Set([name]);
const entry = { test: name, owner: 'nlundee', issue: 1112, expires: '2026-12-05' };

describe('the quarantine check', () => {
  it('accepts an owned entry with an issue that expires within 14 days', () => {
    expect(quarantineProblems([entry], today, known)).toEqual([]);
    expect(quarantineProblems([{ ...entry, expires: '2026-12-12' }], today, known)).toEqual([]);
    expect(quarantineProblems([{ ...entry, expires: today }], today, known)).toEqual([]);
  });

  it('refuses an entry whose expiry has passed', () => {
    expect(quarantineProblems([{ ...entry, expires: '2026-11-27' }], today, known)).toEqual([
      `${name}: expired on 2026-11-27`,
    ]);
  });

  it('refuses an expiry more than 14 days out', () => {
    expect(quarantineProblems([{ ...entry, expires: '2026-12-13' }], today, known)).toEqual([
      `${name}: expires more than 14 days from ${today}`,
    ]);
  });

  it('refuses an entry without an owner or an issue', () => {
    expect(quarantineProblems([{ ...entry, owner: '', issue: undefined }], today, known)).toEqual([
      `${name}: owner must be a GitHub login`,
      `${name}: issue must be an issue number`,
    ]);
    expect(quarantineProblems([{ ...entry, issue: 0 }], today, known)).toHaveLength(1);
  });

  it('refuses an expiry that is not a real date', () => {
    expect(quarantineProblems([{ ...entry, expires: '2026-02-30' }], today, known)).toEqual([
      `${name}: expires must be a YYYY-MM-DD date`,
    ]);
  });

  it('refuses a name that no longer matches a test', () => {
    expect(quarantineProblems([{ ...entry, test: `${name} again` }], today, known)).toEqual([
      `${name} again: matches no test`,
    ]);
  });

  it('refuses more than 10 entries', () => {
    const names = Array.from({ length: 11 }, (_, i) => `scripts/a.test.ts > rule ${i}`);
    const entries = names.map((test) => ({ ...entry, test }));
    expect(quarantineProblems(entries, today, new Set(names))).toEqual([
      '11 entries; at most 10 tests may be quarantined',
    ]);
    expect(quarantineProblems(entries.slice(1), today, new Set(names))).toEqual([]);
  });

  it('refuses the same test listed twice', () => {
    expect(quarantineProblems([entry, entry], today, known)).toEqual([`${name}: listed twice`]);
  });

  it('skips only entries that are owned, have an issue and have not expired', () => {
    const other = 'scripts/a.test.ts > another rule';
    const entries = [
      entry,
      { ...entry, test: other, expires: '2026-11-27' },
      { ...entry, test: `${other} 2`, owner: '' },
      { ...entry, test: `${other} 3`, expires: '2026-12-31' },
    ];
    expect([...quarantinedTests(entries, today)]).toEqual([name]);
  });

  it('skips nothing when more than 10 tests are listed', () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({ ...entry, test: `${name} ${i}` }));
    expect(quarantinedTests(entries, today).size).toBe(0);
    expect(quarantinedTests(entries.slice(1), today).size).toBe(10);
  });

  it('names a test the way the runner does, file first', ({ task }) => {
    expect(task.fullName).toBe(
      'scripts/quarantine-check.test.ts > the quarantine check > names a test the way the runner does, file first',
    );
  });
});
