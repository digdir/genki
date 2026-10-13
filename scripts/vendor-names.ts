import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export const repoRoot = join(import.meta.dirname, '..');

export const vendorNames = [
  'openai',
  'anthropic',
  'azure',
  'foundry',
  'typesense',
  'colbert',
  'langfuse',
  'pgvector',
  'cohere',
  'mistral',
  'gemini',
  'bedrock',
  'vertex',
];

const vendorPattern = new RegExp(vendorNames.join('|'), 'i');

export const allowedPaths: { path: RegExp; why: string }[] = [
  { path: /^packages\/providers-/, why: 'provider packages own the vendor code' },
  {
    path: /^(apps\/(api\/src\/(composition|main|knowledge-engines)|worker\/src\/main)|packages\/composition\/src\/runtime)\.ts$/,
    why: 'composition roots wire the providers in',
  },
  { path: /^apps\/parity\/src\//, why: 'the parity CLI composes providers to compare engines' },
  { path: /^packages\/[^/]+\/src\/scripts\//, why: 'live scripts compose providers' },
  {
    path: /^packages\/adapter-openai\//,
    why: 'the adapter for the OpenAI-compatible protocol (ADR 0021) is named after the protocol',
  },
  { path: /\.test\.tsx?$|\.test-utils\.ts$|\.d\.ts$/, why: 'tests and type declarations' },
  {
    path: /^apps\/[^/]+\/src\/i18n\//,
    why: 'text catalogues name the protocols and integrations users see in labels',
  },
];

export const knownViolations: Record<string, string[]> = {};

const skippedFile = (path: string) => allowedPaths.some((a) => a.path.test(path));

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
};

export const scannedFiles = (root = repoRoot) =>
  ['apps', 'packages']
    .flatMap((top) =>
      readdirSync(join(root, top))
        .map((pkg) => join(root, top, pkg, 'src'))
        .filter((src) => statSync(src, { throwIfNoEntry: false })?.isDirectory()),
    )
    .flatMap((src) => sourceFiles(src))
    .map((full) => relative(root, full))
    .filter((path) => !skippedFile(path))
    .sort();

export interface VendorName {
  file: string;
  line: number;
  name: string;
}

const insideProviderImport = (node: ts.Node) => {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) {
      const from = at.moduleSpecifier;
      return Boolean(from && ts.isStringLiteral(from) && from.text.startsWith('@genai/providers-'));
    }
  }
  return false;
};

const configKey = (node: ts.Identifier | ts.PrivateIdentifier) => {
  if (!vendorNames.includes(node.text)) return false;
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node)
  );
};

export const vendorIdentifiers = (file: string, text: string): VendorName[] => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: VendorName[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      vendorPattern.test(node.text) &&
      !configKey(node) &&
      !insideProviderImport(node)
    )
      found.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        name: node.text,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

export const scanVendorNames = (root = repoRoot) =>
  scannedFiles(root).flatMap((file) =>
    vendorIdentifiers(file, readFileSync(join(root, file), 'utf8')),
  );

export const vendorViolations = (root = repoRoot) =>
  scanVendorNames(root).filter((v) => !knownViolations[v.file]?.includes(v.name));
