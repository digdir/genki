import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { parse } from 'yaml';
import { z } from 'zod';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const archDir = join(repoRoot, 'docs/architecture');
const modulesDir = join(archDir, 'modules');
const templatePath = join(archDir, 'system-atlas.template.html');
export const outputPath = join(archDir, 'system-atlas.html');
const marker = '/*{{ATLAS}}*/ null';

export interface Witness {
  file: string;
  imports?: string;
  contains?: string;
}

export interface Edge {
  to: string;
  label: string;
  kind: 'call' | 'http' | 'sql' | 'mock';
  target: 'call' | 'http' | 'sql' | 'mock';
  witness: Witness;
}

export interface ContractRef {
  name: string;
  file: string;
  export: string;
}

export interface Module {
  id: string;
  plane: string;
  name: string;
  external?: boolean;
  packages?: string[];
  files?: string[];
  replaces?: { module: string; how: string }[];
  edges?: Edge[];
  contract?: ContractRef[];
  [key: string]: unknown;
}

export interface Trace {
  id: string;
  name: string;
  steps: { module: string; text: string }[];
}

const readYaml = <T>(path: string): T => parse(readFileSync(path, 'utf8')) as T;

export const readOrder = (): string[] => readYaml<string[]>(join(modulesDir, 'order.yaml'));

export const moduleFileIds = (): string[] =>
  readdirSync(modulesDir)
    .filter((f) => f.endsWith('.yaml') && f !== 'order.yaml')
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();

export const loadModules = (): Module[] => {
  const order = readOrder();
  const present = moduleFileIds();
  const unlisted = present.filter((id) => !order.includes(id));
  const missing = order.filter((id) => !present.includes(id));
  if (unlisted.length) throw new Error(`module files not listed in order.yaml: ${unlisted}`);
  if (missing.length) throw new Error(`order.yaml lists ids with no module file: ${missing}`);
  return order.map((id) => {
    const m = readYaml<Module>(join(modulesDir, `${id}.yaml`));
    if (m.id !== id) throw new Error(`${id}.yaml declares id ${m.id}`);
    return m;
  });
};

export const loadHeadlessRag = () =>
  readYaml<{ id: string; name: string; note: string }[]>(join(archDir, 'headless-rag.yaml'));

export const loadTraces = () => readYaml<Trace[]>(join(archDir, 'traces.yaml'));

export const workspacePackages = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const group of ['packages', 'apps']) {
    for (const dir of readdirSync(join(repoRoot, group))) {
      const manifest = join(repoRoot, group, dir, 'package.json');
      if (existsSync(manifest)) {
        found.set(
          (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name,
          `${group}/${dir}`,
        );
      }
    }
  }
  return found;
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test(-utils)?\.tsx?$/.test(entry.name) ? [path] : [];
  });

const importPattern = /(?:from|import\()\s*['"](@genai\/[a-z0-9-]+)/g;

export const importsOf = (file: string): string[] =>
  [...readFileSync(join(repoRoot, file), 'utf8').matchAll(importPattern)].map(
    (m) => m[1] as string,
  );

export const crossModuleImports = (modules: Module[]): Map<string, Witness[]> => {
  const owner = new Map<string, string>();
  for (const m of modules) for (const p of m.packages ?? []) owner.set(p, m.id);
  const result = new Map<string, Witness[]>();
  for (const [name, dir] of workspacePackages()) {
    const from = owner.get(name);
    const src = join(repoRoot, dir, 'src');
    if (!from || !existsSync(src)) continue;
    for (const path of sourceFiles(src)) {
      const file = relative(repoRoot, path);
      for (const imported of importsOf(file)) {
        const to = owner.get(imported);
        if (!to || to === from) continue;
        const key = `${from}>${to}`;
        result.set(key, [...(result.get(key) ?? []), { file, imports: imported }]);
      }
    }
  }
  return result;
};

const contractSchemas = async (id: string, refs: ContractRef[] = []) => {
  const out = [];
  for (const ref of refs) {
    const mod = (await import(pathToFileURL(join(repoRoot, ref.file)).href)) as Record<
      string,
      unknown
    >;
    const schema = mod[ref.export];
    if (!(schema instanceof z.ZodType))
      throw new Error(`${id}: ${ref.file} exports no Zod schema ${ref.export}`);
    out.push({ ...ref, schema: z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) });
  }
  return out;
};

export const renderAtlas = async (): Promise<string> => {
  const template = readFileSync(templatePath, 'utf8');
  if (!template.includes(marker)) throw new Error(`template has no ${marker} marker`);
  const modules = await Promise.all(
    loadModules().map(async ({ contract, ...rest }) => ({
      ...rest,
      schemas: await contractSchemas(rest.id, contract),
    })),
  );
  const data = JSON.stringify({ modules, headlessRag: loadHeadlessRag(), traces: loadTraces() });
  const html = template.replace(marker, () => data.replace(/</g, '\\u003c'));
  return format(html, { ...(await resolveConfig(outputPath)), filepath: outputPath });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const html = await renderAtlas();
  const target = relative(repoRoot, outputPath);
  if (process.argv.includes('--check')) {
    if (readFileSync(outputPath, 'utf8') !== html) {
      console.error(`${target} is out of date; run npm run atlas:build`);
      process.exit(1);
    }
    console.log(`${target} is up to date`);
  } else {
    writeFileSync(outputPath, html);
    console.log(`System Atlas: ${target} (${Buffer.byteLength(html)} bytes)`);
  }
}
