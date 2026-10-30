import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = join(import.meta.dirname, '..');

export const budgets: Record<string, number> = {
  portal: 400_000,
  console: 360_000,
  workspace: 200_000,
};

export interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

export type Manifest = Record<string, ManifestChunk>;

export interface FirstLoad {
  app: string;
  files: string[];
  raw: number;
  gzip: number;
  budget: number;
}

export const firstLoadFiles = (manifest: Manifest): string[] => {
  const entries = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);
  if (entries.length === 0) throw new Error('the manifest has no entry chunk');
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) visit(next);
  };
  entries.forEach(visit);
  return [...seen]
    .map((key) => manifest[key]?.file)
    .filter((file): file is string => file?.endsWith('.js') ?? false);
};

export const measureFirstLoad = (
  app: string,
  manifest: Manifest,
  read: (file: string) => Buffer,
): FirstLoad => {
  const files = firstLoadFiles(manifest);
  const bytes = files.map(read);
  return {
    app,
    files,
    raw: bytes.reduce((sum, b) => sum + b.length, 0),
    gzip: bytes.reduce((sum, b) => sum + gzipSync(b, { level: 9 }).length, 0),
    budget: budgets[app] ?? 0,
  };
};

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

export const overBudget = (loads: FirstLoad[]): string[] =>
  loads
    .filter((load) => load.gzip > load.budget)
    .map(
      (load) =>
        `${load.app}: the first load is ${kB(load.gzip)} gzip, over its budget of ${kB(load.budget)}`,
    );

export const report = (load: FirstLoad) =>
  `${load.app.padEnd(10)} ${String(load.files.length).padStart(3)} files  ${kB(load.raw).padStart(10)}  ${kB(load.gzip).padStart(9)} gzip  budget ${kB(load.budget)}`;

const build = (app: string, outDir: string) => {
  const result = spawnSync(
    'npx',
    ['vite', 'build', '--manifest', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
    { cwd: join(repo, 'apps', app), encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`${app} did not build:\n${result.stderr}`);
  const manifest = JSON.parse(
    readFileSync(join(outDir, '.vite/manifest.json'), 'utf8'),
  ) as Manifest;
  return measureFirstLoad(app, manifest, (file) => readFileSync(join(outDir, file)));
};

const main = () => {
  const dir = mkdtempSync(join(tmpdir(), 'genki-size-'));
  try {
    const loads = Object.keys(budgets).map((app) => build(app, join(dir, app)));
    console.log('First load: the entry and the chunks it imports up front, JS only');
    for (const load of loads) console.log(report(load));
    const failures = overBudget(loads);
    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      process.exit(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
