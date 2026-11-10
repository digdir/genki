import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const flat = read('composer.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');
const rule = (selector: string) => {
  const start = flat.indexOf(` ${selector} {`);
  return start < 0 ? '' : flat.slice(start, flat.indexOf('}', start));
};

// jsdom lays nothing out, so the rules that place things are read from the stylesheet.
describe('the Composer styles', () => {
  it('keep send at the end of its row, with no paperclip and no control of the host’s beside it', () => {
    expect(rule('.uib-composer-controls')).toContain('justify-content: flex-end;');
    expect(rule('.uib-composer-attach')).toContain('margin-inline-end: auto;');
    expect(rule('.uib-composer-actions')).not.toContain('margin-inline-start');
  });

  it('keep the docked field’s height clear under the rest of its column, and none under the field', () => {
    expect(rule(':has(> .uib-composer[data-sticky]) *')).toContain(
      'scroll-margin-block-end: var(--uib-composer-block-size, 0);',
    );
    expect(flat).toContain(
      '.uib-composer[data-sticky], .uib-composer[data-sticky] * { scroll-margin-block-end: 0; }',
    );
  });

  it('take the empty refusal out of the flow, but keep it in the page', () => {
    const empty = rule('.uib-composer-refusal:empty');
    expect(empty).toContain('position: absolute;');
    expect(empty).not.toContain('display: none');
  });
});

// A `data-color` written into the markup is a pin a host's `color` cannot reach (V2-0009 §3):
// each is named here and justified by the comment on the line above it.
const pins: Record<string, string[]> = {
  'Composer.tsx': ['uib-composer-scroll', 'uib-composer-attach', 'uib-composer-attach'],
  'Attachments.tsx': ['composer.retryLabel'],
  '../welcome/Welcome.tsx': ['uib-welcome-suggestion'],
};

describe('the Composer and Welcome markup', () => {
  it.each(Object.entries(pins))(
    'pins to neutral in %s only what kunnskapsassistenten draws neutral, each with its reason',
    (file, named) => {
      const lines = read(file).split('\n');
      const at = lines.flatMap((line, index) =>
        line.includes('data-color="neutral"') ? [index] : [],
      );
      expect(at).toHaveLength(named.length);
      at.forEach((index, n) => {
        expect(lines[index - 1]?.trim()).toMatch(
          /^\/\/ Pinned to neutral, as kunnskapsassistenten/,
        );
        expect(lines.slice(index - 3, index).join('\n')).toContain(named[n]);
      });
    },
  );
});
