import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The stylesheets hold no literal colour (`styles.test.ts`, and the assembly's own). A colour can
// still be written in the code: in an inline style, in a style the code sets on an element, or on
// an SVG's fill, stroke or color. This holds the blocks and the assembly to the same rule, so
// every colour they draw comes from the theme.

/** A colour written out: hex, a colour function, or a colour by name (the stylesheets' list). */
const literalColour =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![\w-])(?:white|black|red|blue|green|gr[ae]y|orange|yellow|purple)(?![\w-])/i;
/** What a paint on its own may be: a variable, or a value that paints no colour of its own. */
const themed = /^(?:var\(--[\s\S]*\)|currentColor|none|transparent|inherit)$/;
/** A property that holds a colour and nothing else, as a CSS name, a React name or a variable. */
const paintProperty = (name: string) =>
  /^(?:fill|stroke)$|color$/i.test(name) || /^--[\w-]+-(?:background|fill|stroke)$/.test(name);
const svgPaint = /^(?:fill|stroke|color|(?:stop|flood|lighting)-?color)$/i;

/** The expression under parentheses and type assertions. */
const bare = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node)
    ? bare(node.expression)
    : node;

/** The literal text an expression can take: its strings, a template's text, both branches. */
const values = (expression: ts.Expression): string[] => {
  const node = bare(expression);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return [
      ...(parts.join('').trim() ? [parts.join('x')] : []),
      ...node.templateSpans.flatMap((span) => values(span.expression)),
    ];
  }
  if (ts.isConditionalExpression(node))
    return [...values(node.whenTrue), ...values(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return values(node.right);
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken)
      return [...values(node.left), ...values(node.right)];
  }
  return [];
};

/** Every colour the source writes out where it is drawn, as `file:line name: value`. */
const literalColours = (file: string, source: string): string[] => {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const check = (at: ts.Node, name: string, value: ts.Expression, paint: boolean) => {
    for (const text of values(value))
      if (literalColour.test(text) || (paint && !themed.test(text.trim())))
        found.push(
          `${file}:${sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1} ${name}: ${text}`,
        );
  };
  const nameOf = (name: ts.PropertyName) =>
    ts.isComputedPropertyName(name)
      ? (values(name.expression)[0] ?? '')
      : ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? name.text
        : name.getText(sf);
  const cssProperties = (type: ts.TypeNode | undefined) =>
    !!type && /(?:^|\.)CSSProperties$/.test(type.getText(sf));

  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      consts.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sf);

  // A style's objects: written in place, in either branch, spread into another, or held in a const.
  const followed = new Set<string>();
  const style = (expression: ts.Expression) => {
    const node = bare(expression);
    const held = ts.isIdentifier(node) && !followed.has(node.text) && consts.get(node.text);
    if (ts.isConditionalExpression(node)) {
      style(node.whenTrue);
      style(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) style(node.left);
      style(node.right);
    } else if (held) {
      followed.add(node.getText(sf));
      style(held);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties)
        if (ts.isPropertyAssignment(property)) {
          const name = nameOf(property.name);
          check(property, name, property.initializer, paintProperty(name));
        } else if (ts.isSpreadAssignment(property)) style(property.expression);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const value = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      const tag = node.parent.parent.tagName.getText(sf);
      if (name === 'style' && value) style(value);
      // An SVG's paint, on the element or on an icon that hands it to its SVG.
      if (svgPaint.test(name) && value)
        check(node, name, value, /^[a-z]/.test(tag) || /Icon$/.test(tag));
    }
    // A style held apart from the element, typed as one.
    if ((ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) && cssProperties(node.type))
      style(node.expression);
    if (ts.isVariableDeclaration(node) && cssProperties(node.type) && node.initializer)
      style(node.initializer);
    // A style the code sets on an element: `style.setProperty(name, value)` or `style.color = …`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setProperty' &&
      /(?:^|\.)style$/.test(node.expression.expression.getText(sf)) &&
      node.arguments[0] &&
      node.arguments[1]
    ) {
      const name = values(node.arguments[0])[0] ?? '';
      check(node, name, node.arguments[1], paintProperty(name));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      /(?:^|\.)style$/.test(node.left.expression.getText(sf))
    )
      check(node, node.left.name.text, node.right, paintProperty(node.left.name.text));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A style reached twice, from its element and from its type, is reported once.
  return [...new Set(found)];
};

const roots = [
  ['@genai/ui-blocks', import.meta.dirname],
  ['@genai/ui-assembly', `${import.meta.dirname}/../../ui-assembly/src`],
] as const;

describe.each(roots)('the code of %s', (_, root) => {
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|test-utils|d)\.tsx?$/.test(path))
    .sort();

  it('is found, its components with it', () => {
    expect(files.filter((path) => path.endsWith('.tsx')).length).toBeGreaterThan(1);
  });

  it('draws every colour from the theme: an inline style colour, or an SVG fill, stroke or color, is a var(--…), currentColor or none', () => {
    expect(
      files.flatMap((path) => literalColours(path, readFileSync(`${root}/${path}`, 'utf8'))),
    ).toEqual([]);
  });
});

describe('the inline colour lint', () => {
  it.each([
    ['a hex fill on a path', '<path fill="#1e2b3c" />'],
    ['a named stroke on an svg', '<svg stroke="black" />'],
    ['an rgb() fill given as an expression', "<circle fill={'rgb(0 98 186)'} />"],
    ['a colour on an icon, which its SVG takes', '<CheckIcon color="#0d7a5f" />'],
    ['a fill that is a colour by any name', '<rect fill="tomato" />'],
    ['a colour in an inline style', "<div style={{ color: '#fff' }} />"],
    ['a colour in a shorthand', "<div style={{ border: '1px solid #e2e3e4' }} />"],
    [
      'a colour in one branch of an inline style',
      "<div style={{ backgroundColor: open ? 'var(--genai-x-background)' : 'white' }} />",
    ],
    [
      'a colour in a style spread into another',
      "<div style={{ inlineSize: '100%', ...(open ? { outlineColor: 'Canvas' } : {}) }} />",
    ],
    [
      'a colour in a style held in a const',
      "const ground = { background: '#f7f7f8' };\nconst A = () => <div style={ground} />;",
    ],
    [
      'a variable set to a colour in a CSSProperties object',
      "const s = { '--genai-x-color': 'hsl(0 0% 50%)' } as CSSProperties;",
    ],
    ['a variable set to a colour on an element', "node.style.setProperty('--x-color', '#123456');"],
    ['a colour set on an element', "node.style.backgroundColor = 'red';"],
  ])('finds %s', (_, source) => {
    expect(literalColours('x.tsx', source)).toHaveLength(1);
  });

  it.each([
    ['currentColor and none on SVG', '<path fill="currentColor" stroke="none" />'],
    [
      'a variable with a token as its fallback',
      '<path fill="var(--genai-x-fill, var(--ds-color-text-default))" />',
    ],
    [
      'a colour family on a block or a component',
      '<Sources color="neutral" data-color="accent" />',
    ],
    ['a size in an inline style', '<div style={{ insetBlockStart: `${top}px` }} />'],
    [
      'a token in an inline style',
      "<div style={{ '--genai-x-color': 'var(--ds-color-neutral-text-default)' } as CSSProperties} />",
    ],
    ['a link to a fragment that reads as hex', '<a href="#add" title="red" />'],
    ['a colour word outside any style', "const tone = { label: 'black', color: 'neutral' };"],
  ])('lets %s pass', (_, source) => {
    expect(literalColours('x.tsx', source)).toEqual([]);
  });
});
