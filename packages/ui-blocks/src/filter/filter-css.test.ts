import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const flat = readFileSync(`${import.meta.dirname}/filter.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\( /g, '(')
  .replace(/,? \)/g, ')');
const rule = (selector: string) => {
  const start = flat.indexOf(` ${selector} {`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('}', start));
};
const gap =
  'clamp(var(--genai-filter-gap-floor, var(--ds-size-6)), var(--genai-filter-gap, 3.6dvh), var(--genai-filter-gap-ceiling, var(--ds-size-8)))';

describe('the Filter styles', () => {
  it('space the fields by a share of the window’s height between two tokens, as kunnskapsassistenten does', () => {
    expect(rule('.uib-filter')).toContain(`gap: ${gap};`);
  });

  it('give the line over the documents the same air as the fields on each side', () => {
    expect(rule('.uib-filter-divider')).toContain(`margin-block: ${gap};`);
  });
});

// A `data-color` in the markup is a pin a host's `color` cannot reach: each named here.
const markupPins: Record<string, string[]> = {
  '../documents/Documents.tsx': ['Loads more', 'documents.remove'],
  'FacetField.tsx': ['filter.selectAllIn', 'filter.clearIn'],
  'YearRangeField.tsx': ['filter.selectAllIn', 'filter.clearIn'],
  'FilterStates.tsx': ['filter.clearLimit', 'uib-filter-locked-values', "'filter.selectAll'"],
};

describe('the Filter and Documents markup', () => {
  it.each(Object.entries(markupPins))(
    'pins to neutral in %s only what kunnskapsassistenten draws neutral, each with its reason',
    (file, named) => {
      const lines = readFileSync(`${import.meta.dirname}/${file}`, 'utf8').split('\n');
      const at = lines.flatMap((line, index) =>
        line.includes('data-color="neutral"') ? [index] : [],
      );
      expect(at).toHaveLength(named.length);
      at.forEach((index, n) => {
        expect(lines[index - 1]?.trim()).toMatch(
          /^\/\/ Pinned to neutral, as kunnskapsassistenten/,
        );
        expect(lines.slice(index - 7, index + 6).join('\n')).toContain(named[n]);
      });
    },
  );
});
