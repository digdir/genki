import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const flat = readFileSync(`${import.meta.dirname}/documents.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
const rule = (selector: string) => {
  const start = flat.indexOf(` ${selector} {`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('}', start));
};

describe('the Documents styles', () => {
  it('put «Skjul» under the title of «Dokumentene som blir med» when the box is too narrow for both, at the row’s end', () => {
    expect(rule('.uib-documents-scope-toggle')).toContain('flex-wrap: wrap;');
    expect(rule('.uib-documents-scope-fold')).toContain('margin-inline-start: auto;');
  });
});
