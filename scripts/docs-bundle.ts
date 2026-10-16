import { cpSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repo = join(import.meta.dirname, '..');

export const docsPipelineFile = join(
  repo,
  'apps',
  'api',
  'config',
  'local',
  'pipelines',
  'genki-docs.yaml',
);

export const docsBundleFolder = 'genki-docs';

export const docsBundleIncludes = (file = docsPipelineFile): string[] =>
  (parseYaml(readFileSync(file, 'utf8')) as { spec: { source: { include: string[] } } }).spec.source
    .include;

export const docsBundleFiles = (root = repo, includes = docsBundleIncludes()): string[] =>
  [
    ...new Set(
      globSync(includes, {
        cwd: root,
        exclude: (path) => path.split(/[\\/]/).some((p) => p === 'node_modules' || p === 'dist'),
      }),
    ),
  ]
    .map((path) => path.split('\\').join('/'))
    .sort();

export const writeDocsBundle = (out: string, root = repo): string[] => {
  const files = docsBundleFiles(root);
  for (const file of files) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    cpSync(join(root, file), join(out, file));
  }
  return files;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/docs-bundle.ts <folder>');
    process.exit(1);
  }
  console.log(`${writeDocsBundle(out).length} files in ${out}`);
}
