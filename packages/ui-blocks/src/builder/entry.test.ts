import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as builder from '@genai/ui-blocks/builder';

const here = dirname(fileURLToPath(import.meta.url));

// The files the entry reaches through relative imports, `.js` read as the `.ts` or `.tsx` beside it.
const reached = (start: string) => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
      const base = resolve(dirname(file), spec ?? '');
      const next = [`${base}.ts`, `${base}.tsx`].find((path) => existsSync(path));
      if (next) visit(next);
    }
  };
  visit(start);
  return [...seen].map((file) => file.slice(join(here, '..').length + 1));
};

describe('the builder’s own entry, `@genai/ui-blocks/builder`', () => {
  it('gives a host the builder’s words in both languages, with the same keys', () => {
    expect(Object.keys(builder.nbBuilder).length).toBeGreaterThan(0);
    expect(Object.keys(builder.enBuilder).sort()).toEqual(Object.keys(builder.nbBuilder).sort());
  });

  it('gives a host the templates, the layout checks and a draft’s facts', () => {
    const layout = builder.fromTemplate('knowledge-assistant-next').layout;
    expect(builder.isAssistantLayout(layout)).toBe(true);
    expect(builder.layoutProblems(layout)).toEqual([]);
    expect(typeof builder.factsFromDefinition).toBe('function');
  });

  it('reaches no block and not the package root, so a host’s first load carries only the builder', () => {
    const files = reached(join(here, 'index.ts'));
    expect(files).toContain('builder/index.ts');
    expect(files.filter((file) => file.endsWith('.tsx'))).toEqual([]);
    expect(files).not.toContain('index.ts');
    expect(files).not.toContain('i18n.ts');
  });
});
