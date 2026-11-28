import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNameStatus, scopeOf, type Change, type Scope } from './ci-scope.ts';
import { npmCommand, pinnedNode, repoRoot } from './setup.ts';

export interface Step {
  name: string;
  command: string;
  args: string[];
  display: string;
}

export const git = (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', env: env ?? process.env }).trim();

export const workingTree = (root: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'genki-verify-'));
  try {
    const index = join(dir, 'index');
    const realIndex = resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(root, ['add', '--all', '--', ':/'], env);
    return git(root, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const stampPath = (root: string) =>
  resolve(root, git(root, ['rev-parse', '--git-dir']), 'genki-verify-ok');

export const readStamp = (root: string): string | undefined => {
  const path = stampPath(root);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
};

export const writeStamp = (root: string, stamp: string) =>
  writeFileSync(stampPath(root), `${stamp}\n`);

export const stampFresh = (stamp: string | undefined, tree: string) => stamp === tree;

export const mergeBase = (root: string): string | undefined => {
  try {
    return git(root, ['merge-base', 'origin/main', 'HEAD']);
  } catch {
    return undefined;
  }
};

export const hasOwnChanges = (root: string, base: string, tree = workingTree(root)) =>
  git(root, ['rev-parse', `${base}^{tree}`]) !== tree;

export const untrackedFiles = (root: string) =>
  git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ':/'])
    .split('\0')
    .filter(Boolean);

export const changesSince = (root: string, base: string): Change[] => [
  ...parseNameStatus(git(root, ['diff', '--name-status', base, '--', ':/'])),
  ...untrackedFiles(root).map((path) => ({ status: 'A', path })),
];

const testRoots = /^(packages\/[^/]+\/src\/|apps\/[^/]+\/src\/|scripts\/|examples\/[^/]+\/[^/]+$)/;
const readsFromDisk = /\b(readFileSync|readFile|readdirSync|readdir|globSync)\(/;

export const fileReadingTests = (root: string): string[] =>
  git(root, ['ls-files', '-z', '--', '*.test.ts', '*.test.tsx'])
    .split('\0')
    .filter((path) => testRoots.test(path) && existsSync(join(root, path)))
    .filter((path) => readsFromDisk.test(readFileSync(join(root, path), 'utf8')));

export const rerunsEverything = /(^|\/)(package\.json|(vitest|vite)\.config\.[cm]?[jt]s)$/;

const npmStep = (name: string, args: string[]): Step => {
  const npm = npmCommand(args);
  return { name, ...npm, display: `npm ${args.join(' ')}` };
};

export interface Plan {
  scope: Scope;
  base: string;
  staticOnly: boolean;
  changedFiles: string[];
  fileReadingTests: string[];
}

export const verifySteps = ({ scope, base, staticOnly, changedFiles, ...rest }: Plan): Step[] => {
  const steps: Step[] = [npmStep('format', ['run', 'format:check'])];
  if (scope.static)
    steps.push(
      npmStep('lint', ['run', 'lint']),
      npmStep('typecheck', ['run', 'typecheck']),
      npmStep('boundaries', ['run', 'boundaries']),
      npmStep('definitions compat', ['run', 'definitions:compat']),
      npmStep('api compat', ['run', 'api:compat', '--', base]),
      npmStep('atlas', ['run', 'atlas:build', '--', '--check']),
    );
  if (staticOnly) return steps;
  if (scope.size) steps.push(npmStep('size', ['run', 'size']));
  if (scope.tests !== 'none')
    steps.push(
      npmStep('tests', [
        'exec',
        '--',
        'vitest',
        'related',
        '--run',
        '--passWithNoTests',
        ...new Set([
          ...changedFiles.filter((path) => !rerunsEverything.test(path)),
          ...rest.fileReadingTests,
        ]),
      ]),
    );
  return steps;
};

const majorOf = (version: string) => version.replace(/^v/, '').split('.')[0];

export const nodeMismatch = (running: string, pinned: string | undefined) =>
  pinned && majorOf(running) !== majorOf(pinned)
    ? `Node ${running} runs, mise.toml pins ${pinned}. Run through mise: \`mise exec -- npm run verify\`.`
    : undefined;

export const lockfileStale = (root: string): boolean | 'npm failed' => {
  const path = join(root, 'package-lock.json');
  const before = readFileSync(path, 'utf8');
  try {
    const npm = npmCommand([
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const result = spawnSync(npm.command, npm.args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) return 'npm failed';
    return readFileSync(path, 'utf8') !== before;
  } finally {
    writeFileSync(path, before);
  }
};

export const hasCommand = (command: string) =>
  spawnSync(command, ['version'], { stdio: 'ignore' }).status === 0;

export const gitleaksStep = (range: string): Step => {
  const args = [
    'git',
    `--log-opts=${range}`,
    '--redact',
    '--verbose',
    '--no-banner',
    '--exit-code',
    '1',
    '.',
  ];
  return { name: 'secrets', command: 'gitleaks', args, display: `gitleaks ${args.join(' ')}` };
};

export const gitleaksMissing =
  'gitleaks is not installed, so the secret scan did not run here (CI runs it on every pull request). Install it with `brew install gitleaks` or from https://github.com/gitleaks/gitleaks.';

const fail = (message: string): never => {
  console.error(`\nverify failed: ${message}`);
  process.exit(1);
};

const run = (root: string, step: Step) => {
  console.log(`\n> ${step.name}: ${step.display}`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0)
    fail(
      step.display.length > 200
        ? `${step.name}. Rerun the command printed after "> ${step.name}:" above.`
        : `${step.name}. Rerun it with: ${step.display}`,
    );
};

export interface Options {
  staticOnly: boolean;
  all: boolean;
  base?: string;
}

export const parseOptions = (argv: string[]): Options => {
  const at = argv.indexOf('--base');
  const base = at >= 0 ? argv[at + 1] : undefined;
  return {
    staticOnly: argv.includes('--static'),
    all: argv.includes('--all'),
    ...(base ? { base } : {}),
  };
};

const everything: Scope = { static: true, tests: 'all', size: true, image: true };

const main = () => {
  const root = repoRoot;
  const { staticOnly, all, ...options } = parseOptions(process.argv.slice(2));
  const base =
    options.base ??
    mergeBase(root) ??
    fail('no merge base with origin/main; run git fetch origin main');

  const mismatch = nodeMismatch(process.versions.node, pinnedNode(root));
  if (mismatch) fail(mismatch);

  const changes = changesSince(root, base);
  const scope = all ? everything : scopeOf(changes);
  console.log(`verify against ${base.slice(0, 12)}: ${JSON.stringify(scope)}`);

  const tree = workingTree(root);

  console.log('\n> lockfile: npm install --package-lock-only --ignore-scripts');
  const lockfile = lockfileStale(root);
  if (lockfile === 'npm failed')
    fail('lockfile. npm install --package-lock-only failed; see the output above.');
  if (lockfile)
    fail('package-lock.json does not match package.json. Run npm install and keep the lockfile.');

  const changedFiles = changes
    .map((change) => change.path)
    .filter((path) => existsSync(join(root, path)));
  for (const step of verifySteps({
    scope,
    base,
    staticOnly,
    changedFiles,
    fileReadingTests: staticOnly ? [] : fileReadingTests(root),
  }))
    run(root, step);

  if (staticOnly) return;

  if (hasCommand('gitleaks')) run(root, gitleaksStep(`${base}..HEAD`));
  else console.warn(`\n${gitleaksMissing}`);

  const untracked = untrackedFiles(root);
  if (untracked.length)
    console.log(
      `\nUntracked files, check that each belongs in the change:\n  ${untracked.join('\n  ')}`,
    );

  if (workingTree(root) !== tree) fail('the working tree changed while verify ran; run it again.');
  writeStamp(root, tree);
  console.log(`\nverify green ${tree}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
