// Decides which CI jobs a pull request needs, from `git diff --name-status <base> HEAD`.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TestScope = 'none' | 'changed' | 'all';

export interface Scope {
  static: boolean;
  tests: TestScope;
  size: boolean;
  image: boolean;
}

export interface Change {
  status: string;
  path: string;
}

const everything: Scope = { static: true, tests: 'all', size: true, image: true };

const isEdit = (c: Change) => c.status === 'A' || c.status === 'M';

export const isDocsOnly = (c: Change) =>
  isEdit(c) &&
  (/^[^/]+\.md$/.test(c.path) || /^docs\/.+\.md$/.test(c.path)) &&
  !c.path.startsWith('docs/adr/0017-');

const sourceDirs = /^(apps|packages|scripts|examples)\//;
const configDirs = /^apps\/[^/]+\/config\//;

export const isSource = (c: Change) =>
  isEdit(c) &&
  sourceDirs.test(c.path) &&
  !configDirs.test(c.path) &&
  /\.(ts|tsx|js|mjs|css)$/.test(c.path);

export const isTest = (c: Change) =>
  /\.test\.tsx?$/.test(c.path) || /\.test-utils\.ts$/.test(c.path);

const serverOnly = /^(apps\/(api|worker|parity)\/|infra\/|\.github\/(?!workflows\/))/;

export const scopeOf = (changes: Change[]): Scope => {
  const code = changes.filter((c) => !isDocsOnly(c));
  if (code.length === 0) return { static: false, tests: 'none', size: false, image: false };
  if (code.some((c) => c.path.startsWith('.github/workflows/'))) return everything;
  const tests: TestScope = code.every(isSource) ? 'changed' : 'all';
  const shipped = code.filter((c) => !isTest(c));
  const size = shipped.some((c) => !serverOnly.test(c.path));
  const image = shipped.some((c) => !/^(infra\/|\.github\/)/.test(c.path));
  return { static: true, tests, size, image };
};

export const parseNameStatus = (output: string): Change[] =>
  output
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [status = '', ...paths] = line.split('\t');
      return paths.map((path) => ({ status: status.charAt(0), path }));
    });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  const scope = base
    ? scopeOf(
        parseNameStatus(
          execFileSync('git', ['diff', '--name-status', base, 'HEAD'], { encoding: 'utf8' }),
        ),
      )
    : everything;
  console.log(JSON.stringify(scope));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(scope)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
}
