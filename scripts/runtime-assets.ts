import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const repo = join(import.meta.dirname, '..');

const segments = (args: string) => [...args.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);

export const codeRelativePaths = (source: string, sourceDir: string): string[] => {
  const bases = new Map<string, string>([['import.meta.dirname', sourceDir]]);
  for (const m of source.matchAll(
    /const (\w+) = join\(\s*import\.meta\.dirname((?:\s*,\s*'[^']*')+)\s*,?\s*\)/g,
  ))
    bases.set(m[1] as string, join(sourceDir, ...segments(m[2] as string)));
  const found: string[] = [];
  for (const [name, base] of bases)
    for (const m of source.matchAll(
      new RegExp(`join\\(\\s*${name.replaceAll('.', '\\.')}((?:\\s*,\\s*'[^']*')+)`, 'g'),
    ))
      found.push(join(base, ...segments(m[1] as string)));
  return found;
};

const workspaceOf = (name: string) =>
  ['packages', 'apps']
    .map((d) => join(d, name.replace('@genai/', '')))
    .find((d) => existsSync(join(repo, d)));

export const runtimeWorkspaces = (roots = ['apps/api', 'apps/worker']): string[] => {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      if (dep.startsWith('@genai/')) {
        const workspace = workspaceOf(dep);
        if (workspace) queue.push(workspace);
      }
  }
  return [...seen].sort();
};

const notShipped = /\.test\.tsx?$|\.test-utils\.ts$|\/testkit\.ts$|\/scripts\//;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

export const runtimeAssetReads = (): { file: string; path: string }[] =>
  runtimeWorkspaces().flatMap((workspace) =>
    sourceFiles(join(repo, workspace, 'src'))
      .filter((file) => !notShipped.test(file))
      .flatMap((file) =>
        codeRelativePaths(readFileSync(file, 'utf8'), dirname(file))
          .map((path) => relative(repo, path))
          .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
          .filter((path) => !relative(repo, file).startsWith(`${path}/`) && path !== '')
          .filter((path) => existsSync(join(repo, path)))
          .map((path) => ({ file: relative(repo, file), path })),
      ),
  );

export const shippedAssets = (): string[] =>
  readFileSync(join(repo, 'docker', 'runtime-assets'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export const dockerfile = () => readFileSync(join(repo, 'Dockerfile'), 'utf8');

export const assetExists = (path: string) => existsSync(join(repo, path));
