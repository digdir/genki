import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scopeOf } from './ci-scope.ts';
import {
  changesSince,
  fileReadingTests,
  gitleaksStep,
  hasOwnChanges,
  nodeMismatch,
  parseOptions,
  readStamp,
  rerunsEverything,
  stampFresh,
  verifySteps,
  workingTree,
  writeStamp,
  type Plan,
} from './verify.ts';
import { repoRoot } from './setup.ts';

const dirs: string[] = [];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'genki-verify-test-'));
  dirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the verify stamp', () => {
  it('changes when a tracked file changes and when an untracked file appears', () => {
    const dir = repo();
    const clean = workingTree(dir);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    const edited = workingTree(dir);
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    const added = workingTree(dir);
    expect(new Set([clean, edited, added]).size).toBe(3);
  });

  it('ignores files git ignores', () => {
    const dir = repo();
    const before = workingTree(dir);
    writeFileSync(join(dir, 'ignored.txt'), 'local');
    expect(workingTree(dir)).toBe(before);
  });

  it('stays fresh when the verified working tree is committed as it is', () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    writeStamp(dir, workingTree(dir));
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'second');
    expect(stampFresh(readStamp(dir), sh(dir, 'rev-parse', 'HEAD^{tree}'))).toBe(true);
    expect(stampFresh(readStamp(dir), workingTree(dir))).toBe(true);
  });

  it('goes stale after any later edit', () => {
    const dir = repo();
    writeStamp(dir, workingTree(dir));
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n');
    expect(stampFresh(readStamp(dir), workingTree(dir))).toBe(false);
  });

  it('is missing until verify has passed once', () => {
    expect(stampFresh(readStamp(repo()), 'anything')).toBe(false);
  });

  it('lives in the git directory, not in the working tree', () => {
    const dir = repo();
    writeStamp(dir, workingTree(dir));
    expect(readFileSync(join(dir, '.git', 'genki-verify-ok'), 'utf8').trim()).toBe(
      workingTree(dir),
    );
    expect(sh(dir, 'status', '--porcelain')).toBe('');
  });

  it('leaves the real index alone', () => {
    const dir = repo();
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    workingTree(dir);
    expect(sh(dir, 'status', '--porcelain')).toBe('?? b.ts');
  });
});

describe('the change verify checks', () => {
  it('counts uncommitted and untracked files, as the pushed commit will hold them', () => {
    const dir = repo();
    const base = sh(dir, 'rev-parse', 'HEAD');
    expect(hasOwnChanges(dir, base)).toBe(false);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    expect(hasOwnChanges(dir, base)).toBe(true);
    expect(changesSince(dir, base)).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
    ]);
  });

  it('picks the same scope as PR CI, through scopeOf', () => {
    const dir = repo();
    const base = sh(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'README.md'), '# docs\n');
    expect(scopeOf(changesSince(dir, base))).toEqual({
      static: false,
      tests: 'none',
      size: false,
      image: false,
    });
  });
});

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  scope: { static: true, tests: 'changed', size: true, image: true },
  base: 'abc123',
  staticOnly: false,
  changedFiles: ['apps/api/src/a.ts', 'package.json'],
  fileReadingTests: ['scripts/flags.test.ts'],
  ...overrides,
});
const names = (p: Plan) => verifySteps(p).map((step) => step.name);

describe('the steps verify runs', () => {
  it('runs the static checks, size and the related tests for a code change', () => {
    expect(names(plan())).toEqual([
      'format',
      'lint',
      'typecheck',
      'boundaries',
      'definitions compat',
      'api compat',
      'atlas',
      'size',
      'tests',
    ]);
  });

  it('runs the type check that covers test files, never tsc -b alone', () => {
    const step = verifySteps(plan()).find((s) => s.name === 'typecheck');
    expect(step?.display).toBe('npm run typecheck');
  });

  it('compares the API with the merge base and checks the atlas without writing it', () => {
    const displays = verifySteps(plan()).map((s) => s.display);
    expect(displays).toContain('npm run api:compat -- abc123');
    expect(displays).toContain('npm run atlas:build -- --check');
  });

  it('runs the tests related to the change plus every test that reads files from disk, never the whole suite', () => {
    const step = verifySteps(plan()).find((s) => s.name === 'tests');
    expect(step?.display).toBe(
      'npm exec -- vitest related --run --passWithNoTests apps/api/src/a.ts scripts/flags.test.ts',
    );
  });

  it('leaves out the files that make vitest run the whole suite', () => {
    for (const path of [
      'package.json',
      'apps/api/package.json',
      'vitest.config.ts',
      'apps/portal/vite.config.ts',
    ])
      expect(rerunsEverything.test(path), path).toBe(true);
    expect(rerunsEverything.test('apps/api/src/package-json.ts')).toBe(false);
  });

  it('runs only format for a docs-only change, as CI does', () => {
    expect(names(plan({ scope: scopeOf([{ status: 'M', path: 'README.md' }]) }))).toEqual([
      'format',
    ]);
  });

  it('runs only the static steps with --static', () => {
    expect(names(plan({ staticOnly: true }))).not.toContain('tests');
    expect(names(plan({ staticOnly: true }))).not.toContain('size');
    expect(names(plan({ staticOnly: true }))).toContain('atlas');
  });

  it('skips the size budget when the change does not ship to a frontend', () => {
    expect(
      names(plan({ scope: scopeOf([{ status: 'M', path: 'apps/api/src/x.ts' }]) })),
    ).not.toContain('size');
  });
});

describe('the options', () => {
  it('takes a base to compare with and can force the whole scope', () => {
    expect(parseOptions(['--static', '--base', 'abc'])).toEqual({
      staticOnly: true,
      all: false,
      base: 'abc',
    });
    expect(parseOptions(['--all'])).toEqual({ staticOnly: false, all: true });
  });
});

describe('the other checks', () => {
  it('scans only the commits of the change for secrets, verbosely and redacted', () => {
    expect(gitleaksStep('abc..HEAD').args).toEqual(
      expect.arrayContaining(['git', '--log-opts=abc..HEAD', '--redact', '--verbose']),
    );
  });

  it('refuses a Node major other than the one mise.toml pins', () => {
    expect(nodeMismatch('26.5.0', '24.22.2')).toMatch(/mise exec/);
    expect(nodeMismatch('24.1.0', '24.22.2')).toBeUndefined();
  });

  it('finds the tests that read source from disk, which vitest --changed misses', () => {
    const found = fileReadingTests(repoRoot);
    expect(found).toContain('scripts/size-budget.test.ts');
    expect(found).not.toContain('scripts/demo-pointer.test.ts');
    expect(found.length).toBeGreaterThan(150);
  });
});
