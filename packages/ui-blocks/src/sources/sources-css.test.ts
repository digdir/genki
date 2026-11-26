import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const flat = readFileSync(`${import.meta.dirname}/sources.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

const rule = (selector: string) => {
  const at = flat.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return flat.slice(at, flat.indexOf('}', at));
};

describe('the excerpt cards in Kilder', () => {
  it('put the footnote numbers on a line of their own above the document name', () => {
    expect(rule('.uib-sources-ex-top')).toContain('flex-direction: column;');
  });

  it('wrap many footnote numbers onto more lines instead of squeezing the card', () => {
    expect(rule('.uib-sources-ex-numbers')).toContain('flex-wrap: wrap;');
  });
});
