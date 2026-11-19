import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// One corner, Designsystemet's xl, for the assistant's surfaces (kunnskapsassistenten#266).
const sheets = readdirSync(import.meta.dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((dir) =>
    readdirSync(`${import.meta.dirname}/${dir.name}`)
      .filter((file) => file.endsWith('.css'))
      .map((file) => {
        const css = readFileSync(`${import.meta.dirname}/${dir.name}/${file}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .replace(/\( /g, '(')
          .replace(/,? \)/g, ')');
        return { name: `${dir.name}/${file}`, css };
      }),
  );

/** Every corner a sheet sets: the property and the token it falls back to, or its plain value. */
const corners = sheets.flatMap(({ name, css }) =>
  [
    ...css.matchAll(
      /(--dsc-[a-z-]*border-radius|border(?:-[a-z]+)*-radius)\s*:\s*(var\(--genai-[a-z-]+, var\(--ds-border-radius-([a-z]+)\)\)|[^;]+)/g,
    ),
  ].map((found) => ({ sheet: name, property: found[1], token: found[3] ?? found[2]?.trim() })),
);

// The marks in running text, the highlighter's corner.
const marks = ['--genai-sources-mark-border-radius', '--genai-conversation-mark-border-radius'];

describe('the corners of the blocks', () => {
  it('are xl on every surface and control, round only where round is meant', () => {
    expect(corners.length).toBeGreaterThan(0);
    const others = corners.filter(({ token }) => !['xl', 'full', 'inherit'].includes(token ?? ''));
    const allowed = sheets.flatMap(({ css }) =>
      marks.filter((mark) => css.includes(`var(${mark}, var(--ds-border-radius-sm))`)),
    );
    expect(allowed.sort()).toEqual([...marks].sort());
    expect(others.filter(({ token }) => token !== 'sm')).toEqual([]);
    expect(others).toHaveLength(marks.length);
  });

  it('give Designsystemet’s cards, buttons, fields and toggle groups in the blocks the xl corner', () => {
    const css = sheets.map((sheet) => sheet.css).join(' ');
    for (const [rule, declaration] of [
      [
        ".uib-shell[data-frame='cards'] .uib-shell-toggle {",
        '--dsc-button-border-radius: var(--genai-shell-toggle-radius, var(--ds-border-radius-xl))',
      ],
      [
        ".uib-shell[data-frame='cards'] .uib-shell-rail :is(a, button) {",
        '--dsc-button-border-radius: var(--genai-shell-rail-button-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-shell-profile-rail {',
        '--dsc-button-border-radius: var(--genai-shell-rail-button-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-conversation-question {',
        '--dsc-card-border-radius: var(--genai-conversation-question-border-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-approach-card {',
        '--dsc-card-border-radius: var(--genai-approach-card-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-answer {',
        '--dsc-card-border-radius: var(--genai-answer-border-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-answer-sources-used-card {',
        '--dsc-card-border-radius: var(--genai-answer-sources-used-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-answer-actions .ds-button {',
        '--dsc-button-border-radius: var(--genai-answer-actions-button-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-sources-document {',
        '--dsc-card-border-radius: var(--genai-sources-border-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-sources-excerpt-toggle {',
        '--dsc-button-border-radius: var(--genai-sources-toggle-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-sources-ex-card {',
        '--dsc-card-border-radius: var(--genai-sources-ex-card-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-sources-search .ds-input {',
        '--dsc-input-border-radius: var(--genai-sources-search-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-welcome-suggestion {',
        '--dsc-button-border-radius: var(--genai-welcome-suggestion-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-settings-color-scheme, .uib-settings-choice {',
        '--dsc-togglegroup-border-radius: var(--genai-settings-toggle-radius, var(--ds-border-radius-xl))',
      ],
      [
        '.uib-settings-page-notice {',
        '--dsc-alert-border-radius: var(--genai-settings-notice-radius, var(--ds-border-radius-xl))',
      ],
    ] as const) {
      const at = css.indexOf(` ${rule} `);
      expect(at, rule).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf('}', at)), rule).toContain(declaration);
    }
  });
});
