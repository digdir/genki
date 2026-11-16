import { beforeAll, describe, expect, it } from 'vitest';

// Vitest gives `?raw` CSS as an empty string, so the stylesheet is read from disk.
let css = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
  };
  css = fs.readFileSync(new URL('./blocks.css', import.meta.url), 'utf8');
});

// A rule's declarations, found by its exact selector, without comments or extra spaces.
const rule = (selector: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => block.split('{'))
    .find(([head]) => head?.trim() === selector)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();

describe('the Grensesnitt tab’s stylesheet', () => {
  it('lets the switcher wrap on a narrow screen, its toggles as tall as on one line', () => {
    expect(rule('.blocks-switcher')).toContain('width: fit-content;');
    expect(rule('.blocks-left[data-narrow] .blocks-switcher')).toBe(
      'flex-wrap: wrap; min-inline-size: 0; block-size: auto;',
    );
    expect(rule('.blocks-left[data-narrow] .blocks-switcher > *')).toBe(
      'block-size: var(--dsc-togglegroup-button-size);',
    );
  });

  it('scrolls a preview wider than its space from its left edge, so none of it is out of reach', () => {
    expect(rule('.service-preview-viewport')).toContain('overflow: auto hidden;');
    expect(rule('.service-preview-viewport')).toContain('justify-content: safe center;');
  });

  it('lets the kept assistant, in its place in the frame, fill the frame', () => {
    expect(rule('.service-preview-slot,\n.service-preview-try')).toBe('height: 100%;');
  });

  it('undoes the zoom on a thread title shown over its row, as on a menu, so it lands on the row at its text size', () => {
    expect(
      rule('.service-preview-frame .ds-dropdown,\n.service-preview-frame .uib-threads-overlay'),
    ).toBe('zoom: calc(1 / var(--preview-scale, 1));');
    expect(rule('.service-preview-frame .uib-threads-overlay > *')).toBe(
      'zoom: var(--preview-scale, 1);',
    );
  });

  it('puts every suggestion in «Tekster» over its remove button, however wide the label', () => {
    expect(rule('.blocks-texts-suggestion')).toBe('flex-direction: column; align-items: start;');
    expect(rule('.blocks-texts-suggestion > .ds-field')).toBe('flex: none; align-self: stretch;');
    // As specific as the rows' own rules, so they win only after them.
    expect(css.indexOf('.blocks-texts-suggestion {')).toBeGreaterThan(
      css.indexOf('.blocks-texts-row > .ds-field {'),
    );
  });

  it('gives the builder and its preview the whole column, not the service page’s narrower padded body', () => {
    expect(rule('.service-body.service-interface:has(.blocks-split, .blocks-fullscreen)')).toBe(
      'max-width: none; padding-inline: 0;',
    );
  });

  it('makes the place to grab an edge wider than its line, for a mouse and a finger', () => {
    expect(rule('.blocks-resize')).toContain('position: relative;');
    expect(rule('.blocks-resize')).toContain('touch-action: none;');
    expect(rule('.blocks-resize::before')).toBe("content: ''; position: absolute; inset: 0 -6px;");
    expect(rule(".blocks-resize[data-axis='y']::before")).toBe('inset: -4px 0;');
  });

  it('selects no text beside an edge while it is dragged', () => {
    expect(rule('.blocks-split:has(> .blocks-resize[data-dragging])')).toContain(
      'user-select: none;',
    );
    expect(rule('.blocks-fullscreen:has(> .blocks-resize[data-dragging])')).toContain(
      'user-select: none;',
    );
  });

  it('leaves the resize handles the portal’s focus ring, not only a line that changes colour', () => {
    const focused = rule('.blocks-resize:hover,\n.blocks-resize:focus-visible');
    expect(focused).toContain('background-color: var(--ds-color-accent-border-default);');
    const handles = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .filter((block) => block.split('{')[0]?.includes('.blocks-resize'));
    expect(handles.length).toBeGreaterThan(1);
    expect(handles.join('}')).not.toMatch(/outline|box-shadow/);
  });
});
