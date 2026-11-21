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

  it('put «+» first and send last in the inline row, and a longer question over them in full width', () => {
    const inline = ".uib-composer-frame[data-variant='inline']";
    expect(rule(inline)).toContain('flex-flow: row wrap;');
    expect(rule(`${inline} .uib-composer-controls`)).toContain('display: contents;');
    expect(rule(`${inline} .uib-composer-attach`)).toContain('order: 1;');
    expect(rule(`${inline} .uib-composer-send`)).toContain('order: 4;');
    const wrapped = rule(`${inline}[data-wrapped] .uib-composer-field`);
    expect(wrapped).toContain('order: 0;');
    expect(wrapped).toContain('flex-basis: 100%;');
  });

  it('give the inline frame a shadow, kept under the focus ring, and send the 12 px corners', () => {
    const inline = ".uib-composer-frame[data-variant='inline']";
    expect(rule(inline)).toContain('var(--genai-composer-frame-shadow, var(--ds-shadow-md))');
    expect(rule(`${inline}:has(.uib-composer-field :focus-visible)`)).toContain(
      'var(--dsc-focus-boxShadow), var(--genai-composer-frame-shadow, var(--ds-shadow-md))',
    );
    expect(rule(`${inline} .uib-composer-send`)).toContain('var(--ds-border-radius-xl)');
  });

  it('ring the frame only while the question field has focus, so a button in it shows its own ring alone', () => {
    expect(flat).not.toContain(':focus-within');
    expect(rule('.uib-composer-frame:has(.uib-composer-field :focus-visible)')).toContain(
      'box-shadow: var(--dsc-focus-boxShadow);',
    );
  });

  it('hide the frame border while the field has focus, so the focus ring is the only line round it', () => {
    expect(rule('.uib-composer-frame:has(.uib-composer-field :focus-visible)')).toContain(
      'border-color: transparent;',
    );
  });

  it('draw no outline of its own on the field in hover or focus, so the frame is the only line', () => {
    const own = rule(
      '.uib-composer-field textarea:hover, .uib-composer-field textarea:focus-visible',
    );
    expect(own).toContain('outline: none;');
    expect(own).toContain('box-shadow: none;');
  });

  it('show hover as a second line of the frame’s border colour, as Designsystemet does on a text field, and not while the ring shows', () => {
    const hover = rule(
      '.uib-composer-frame:has(.uib-composer-field:hover):not(:has(.uib-composer-field :focus-visible))',
    );
    expect(hover).toContain('outline: var(--ds-border-width-default) solid');
    expect(hover).toContain('var(--ds-color-border-default)');
  });

  it('take the empty refusal out of the flow, but keep it in the page', () => {
    const empty = rule('.uib-composer-refusal:empty');
    expect(empty).toContain('position: absolute;');
    expect(empty).not.toContain('display: none');
  });
});

// A `data-color` in the markup is a pin a host's `color` cannot reach: each named here.
const pins: Record<string, string[]> = {
  'Composer.tsx': ['uib-composer-attach', 'uib-composer-attach', 'uib-composer-scroll'],
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
