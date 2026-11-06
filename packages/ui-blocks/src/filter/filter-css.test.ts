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
