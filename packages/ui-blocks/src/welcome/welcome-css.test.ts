import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const flat = readFileSync(`${import.meta.dirname}/welcome.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
const rule = (selector: string) => {
  const start = flat.indexOf(` ${selector} {`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('}', start));
};

// jsdom lays nothing out, so the rules that place things are read from the stylesheet.
describe('the Welcome styles', () => {
  it('centre a suggestion’s icon on its first line, whatever the icon’s size', () => {
    expect(rule('.uib-welcome-suggestion')).toContain('align-items: start;');
    expect(rule('.uib-welcome-suggestion-icon')).toContain(
      'margin-block-start: var( --genai-welcome-suggestion-icon-offset, calc((1lh - var(--ds-icon-size)) / 2) );',
    );
  });
});
