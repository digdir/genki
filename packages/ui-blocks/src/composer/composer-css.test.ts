import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const flat = readFileSync(`${import.meta.dirname}/composer.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
const rule = (selector: string) => {
  const start = flat.indexOf(` ${selector} {`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('}', start));
};

// jsdom lays nothing out, so the rule that places the buttons is read from the stylesheet.
describe('the Composer styles', () => {
  it('keep send at the end of its row, with no paperclip and no control of the host’s beside it', () => {
    expect(rule('.uib-composer-controls')).toContain('justify-content: flex-end;');
    expect(rule('.uib-composer-attach')).toContain('margin-inline-end: auto;');
    expect(rule('.uib-composer-actions')).not.toContain('margin-inline-start');
  });
});
