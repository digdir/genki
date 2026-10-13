import { describe, expect, it } from 'vitest';
import { diffRows, lineDiff } from './diff';

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      ['same', 'a'],
      ['remove', 'b'],
      ['add', 'x'],
      ['same', 'c'],
      ['add', 'd'],
    ]);
  });
});

describe('diffRows', () => {
  it('shows a sentence added to a paragraph as the only addition in that line', () => {
    const before = 'Svar kort og høflig.\n\nBruk klart språk.';
    const after = 'Svar kort og høflig. Oppgi alltid fristen.\n\nBruk klart språk.';

    expect(diffRows(before, after)).toEqual([
      {
        op: 'change',
        parts: [
          ['same', 'Svar kort og høflig.'],
          ['add', ' Oppgi alltid fristen.'],
        ],
      },
      { op: 'same', text: 'Bruk klart språk.' },
    ]);
  });

  it('keeps whole lines that have no counterpart as added or removed', () => {
    expect(diffRows('a', 'a\nb')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'add', text: 'b' },
    ]);
  });
});
