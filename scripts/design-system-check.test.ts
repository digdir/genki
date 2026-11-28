import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// What the design-system-check scanner lists and what it leaves to the skill.

const scanner = join(import.meta.dirname, '../.claude/skills/design-system-check/scan.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ds-check-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
const scan = (name: string, source: string) => {
  const file = join(dir, `${(count += 1)}-${name}`);
  writeFileSync(file, source);
  return execFileSync(process.execPath, [scanner, file], { encoding: 'utf8' });
};

describe('design system check scanner', () => {
  it('suggests Button for a raw button and links to its docs', () => {
    const out = scan('a.tsx', 'export const A = () => <button>Ok</button>;\n');
    expect(out).toContain('[element] → Button');
    expect(out).toContain('https://designsystemet.no/no/components/docs/button/overview');
  });

  it('suggests Tabs for a hand-built tab list', () => {
    expect(scan('b.tsx', 'export const B = () => <div role="tablist" />;\n')).toContain(
      '[role] → Tabs',
    );
  });

  it('skips a deviation marked ds-ok on the line or the line above', () => {
    const out = scan(
      'c.tsx',
      'export const C = () => (\n  <>\n    {/* ds-ok: native on purpose */}\n    <button>x</button>\n    <button>y</button> {/* ds-ok: also */}\n  </>\n);\n',
    );
    expect(out).toContain('No candidates');
  });

  it('flags a font size written in px', () => {
    expect(scan('d.css', '.x {\n  font-size: 15px;\n}\n')).toContain('[css:type]');
  });

  it('leaves values that come from a token, fall back to one or draw nothing', () => {
    const out = scan(
      'e.css',
      [
        '.x {',
        '  gap: var(--ds-size-2);',
        '  padding: var(--genai-pad, var(--ds-size-3));',
        '  border-top: 1px solid var(--ds-color-neutral-border-subtle);',
        '  border: 0;',
        '  box-shadow: var(--genai-shadow, var(--ds-shadow-sm));',
        '  --dsc-button-border-radius: var(--genai-r, var(--ds-border-radius-xl));',
        '}',
        '',
      ].join('\n'),
    );
    expect(out).toContain('No candidates');
  });

  it('ignores what is inside a CSS comment', () => {
    expect(
      scan(
        'f.css',
        '/* color: #fff;\n   gap: 8px; */\n.x { color: var(--ds-color-text-default); }\n',
      ),
    ).toContain('No candidates');
  });
});
