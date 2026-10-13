import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en, nb } from './index.js';

interface Found {
  file: string;
  line: number;
  text: string;
}

const helpers = new Set(['failed', 'failure', 'refused', 'refuse', 'fail']);

const nameOf = (expression: ts.Expression, sf: ts.SourceFile) =>
  expression
    .getText(sf)
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !['as', 'String', 'join', 'length'].includes(w))
    .at(-1) ?? 'value';

const literal = (node: ts.Node, sf: ts.SourceFile): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((s) => `{${nameOf(s.expression, sf)}}${s.literal.text}`).join('')
    );
  if (ts.isParenthesizedExpression(node)) return literal(node.expression, sf);
  return undefined;
};

const props = (node: ts.ObjectLiteralExpression, sf: ts.SourceFile) =>
  new Map(
    node.properties.flatMap((p) =>
      ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
        ? [[p.name.getText(sf), p] as const]
        : [],
    ),
  );

const scanSource = (file: string, source: string): Found[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Found[] = [];
  const add = (node: ts.Node | undefined) => {
    const text = node && literal(node, sf);
    if (node && text?.trim())
      found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === 'problem') add(n.arguments[2]);
      if (helpers.has(n.expression.text))
        for (const arg of n.arguments) {
          const text = literal(arg, sf);
          if (text !== undefined && !/^[a-z][\w.[\]{}-]*$/.test(text)) add(arg);
        }
    }
    if (ts.isObjectLiteralExpression(n)) {
      const all = props(n, sf);
      const init = (name: string) => {
        const p = all.get(name);
        return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
      };
      if (all.has('title') && all.has('status')) add(init('title'));
      if (all.has('title') || all.has('status') || n.properties.some(ts.isSpreadAssignment))
        add(init('detail'));
      if (all.has('message') && all.has('path')) add(init('message'));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

const scanDirectory = (root: string): Found[] => {
  const out: Found[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'i18n') walk(path);
      } else if (/(?<!\.test)\.ts$/.test(entry.name) && entry.name !== 'testkit.ts')
        out.push(...scanSource(path, readFileSync(path, 'utf8')));
    }
  };
  walk(root);
  return out;
};

const shape = (text: string) => text.replace(/\{[^}]*\}/g, '{}');
const shapes = (catalogue: Record<string, Record<string, unknown>>) =>
  new Set(
    Object.values(catalogue).flatMap((ns) =>
      Object.values(ns).flatMap((m) =>
        typeof m === 'string'
          ? [shape(m)]
          : Object.values(m as object)
              .map(String)
              .map(shape),
      ),
    ),
  );

describe('API message coverage', () => {
  it('every literal problem title, detail and error message in apps/api has a catalogue entry in both languages', () => {
    const known = new Set([...shapes(nb), ...shapes(en)]);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const missing = scanDirectory(root)
      .filter((f) => !known.has(shape(f.text)))
      .map((f) => `${relative(root, f.file)}:${f.line} ${JSON.stringify(f.text)}`);
    expect(missing).toEqual([]);
  });

  it('finds problem titles, error messages and helper messages but not field paths', () => {
    const found = scanSource(
      'x.ts',
      [
        "problem(c, 404, 'Fant ikke kjøringen');",
        'c.json({ type: "about:blank", title: `Steg ${n}`, status: 400, errors: [{ path: "a.b", message: "must be an object" }] });',
        "failed(target, 'principal', 'only the tenant adopts building blocks');",
        "label({ title: 'Ikke en feil' });",
      ].join('\n'),
    ).map((f) => f.text);
    expect(found).toEqual([
      'Fant ikke kjøringen',
      'Steg {n}',
      'must be an object',
      'only the tenant adopts building blocks',
    ]);
  });
});
