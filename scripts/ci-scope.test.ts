import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseNameStatus, scopeOf, type Change } from './ci-scope.ts';

const m = (path: string): Change => ({ status: 'M', path });

describe('the CI scope of a pull request', () => {
  it('runs only format and gitleaks when it changes Markdown in the root or under docs', () => {
    expect(scopeOf([m('docs/adr/0033-locked-test-environment.md'), m('README.md')])).toEqual({
      static: false,
      tests: 'none',
      size: false,
      image: false,
    });
  });

  it('treats ADR 0017 as code, because a parity test reads it', () => {
    expect(scopeOf([m('docs/adr/0017-parity-scope-and-intentional-divergences.md')]).tests).toBe(
      'all',
    );
  });

  it('runs every test when a doc is deleted or renamed, because the docs bundle test lists files', () => {
    expect(scopeOf([{ status: 'D', path: 'docs/development.md' }]).tests).toBe('all');
    expect(scopeOf(parseNameStatus('R100\tdocs/old.md\tdocs/new.md')).tests).toBe('all');
  });

  it('runs every test when only TypeScript source changes, so a green pull request means a green merge queue', () => {
    expect(
      scopeOf([
        m('apps/console/src/screens/SupportAccess.tsx'),
        m('packages/identity/src/claims.ts'),
      ]).tests,
    ).toBe('all');
  });

  it('runs every test when a file outside the module graph changes, such as config, prompts or test data', () => {
    for (const path of [
      'apps/api/config/local/services/klarsprak.yaml',
      'apps/api/config/local/prompts/svar.md',
      'apps/api/config/local/models.ts',
      'packages/eval/testsets/builder-assistant.yaml',
      'package-lock.json',
      'vitest.config.ts',
      'Dockerfile',
    ])
      expect(scopeOf([m(path)]).tests, path).toBe('all');
  });

  it('runs everything when the workflows change', () => {
    expect(scopeOf([m('.github/workflows/ci.yml')])).toEqual({
      static: true,
      tests: 'all',
      size: true,
      image: true,
    });
  });

  it('skips the size budget and the image when only tests change', () => {
    expect(scopeOf([m('apps/console/src/support.test.tsx')])).toEqual({
      static: true,
      tests: 'all',
      size: false,
      image: false,
    });
  });

  it('skips the size budget when only the API, worker, parity or infrastructure change', () => {
    expect(scopeOf([m('apps/api/src/lockdown.ts')]).size).toBe(false);
    expect(scopeOf([m('infra/env/test.bicepparam')]).size).toBe(false);
    expect(scopeOf([m('apps/portal/src/App.tsx')]).size).toBe(true);
    expect(scopeOf([m('packages/identity/src/claims.ts')]).size).toBe(true);
  });

  it('builds the image for anything that ships, but not for infrastructure alone', () => {
    expect(scopeOf([m('apps/api/src/lockdown.ts')]).image).toBe(true);
    expect(scopeOf([m('infra/env/test.bicepparam')]).image).toBe(false);
  });

  it('reads renames as both paths', () => {
    expect(parseNameStatus('M\ta.ts\nR090\tb.ts\tc.ts\n')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', path: 'b.ts' },
      { status: 'R', path: 'c.ts' },
    ]);
  });
});

interface Step {
  uses?: string;
  with?: Record<string, string | number>;
  env?: Record<string, string>;
  run?: string;
  if?: string;
}

interface Job {
  needs?: string | string[];
  if?: string;
  strategy?: { matrix: { shard: number[] } };
  steps: Step[];
}

const workflow = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'),
) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const steps = (job: string) => workflow.jobs[job]?.steps ?? [];
const env = (job: string, name: string) =>
  steps(job)
    .map((s) => s.env?.[name])
    .find(Boolean) ?? '';

describe('the CI workflow in the merge queue', () => {
  it('runs for a merge group, so two pull requests that pass alone are checked together', () => {
    expect(workflow.on).toHaveProperty('merge_group');
  });

  it('runs every check in full for a merge group, since a deploy reuses its result for the commit', () => {
    expect(env('scope', 'BASE')).toBe("${{ github.event.pull_request.base.sha || '' }}");
    const scope = execFileSync(process.execPath, [join(import.meta.dirname, 'ci-scope.ts')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    expect(JSON.parse(scope)).toEqual({ static: true, tests: 'all', size: true, image: true });
  });
});

describe('the test job', () => {
  const job = workflow.jobs.test as Job;
  const vitest = () => steps('test').find((s) => s.run?.includes('vitest'));

  it('runs every test file on every pull request, never only the affected ones', () => {
    expect(vitest()?.run).not.toContain('--changed');
    expect(steps('test').some((s) => s.env?.BASE || s.env?.CHANGED)).toBe(false);
  });

  it('splits the tests over as many shards as the matrix has runners', () => {
    const shards = job.strategy?.matrix.shard ?? [];
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
    expect(vitest()?.run).toContain(`--shard=\${{ matrix.shard }}/${shards.length} `);
  });
});

describe('the static jobs', () => {
  const runs = (job: string) => steps(job).map((s) => s.run ?? '');

  it('typechecks in its own job, so format and lint do not wait for it', () => {
    expect(runs('typecheck')).toContain('npm run typecheck');
    expect(runs('static')).not.toContain('npm run typecheck');
    expect(workflow.jobs.typecheck?.if).toBe("needs.scope.outputs.static == 'true'");
  });

  it('checks the System Atlas and the workflows, and runs the quarantine check', () => {
    expect(runs('static')).toContain('npm run atlas:build -- --check');
    expect(runs('static')).toContain('npm run quarantine:check');
    expect(runs('static').find((r) => r.includes('rhysd/actionlint'))).toMatch(
      /rhysd\/actionlint:[\d.]+@sha256:[0-9a-f]{64}/,
    );
  });

  it('keys every cache it restores on the lockfile and falls back only to the same lockfile', () => {
    for (const job of ['static', 'typecheck'])
      for (const s of steps(job).filter((s) => s.with?.['restore-keys'])) {
        const key = String(s.with?.key);
        expect(key).toContain("hashFiles('package-lock.json'");
        expect(key.endsWith('-${{ github.sha }}')).toBe(true);
        expect(`${s.with?.['restore-keys']}\${{ github.sha }}`).toBe(key);
      }
  });

  it('lints without a cache, because a cached file passes a type-aware rule that a change elsewhere broke', () => {
    const lint = steps('static').find((s) => s.run?.startsWith('npm run lint'));
    expect(lint?.run).toBe('npm run lint');
  });

  it('builds the typecheck cold when a source file is added, deleted or renamed, so a stale declaration in dist cannot pass it', () => {
    const cache = steps('typecheck').find((s) => s.with?.['restore-keys']);
    expect(cache?.with?.['restore-keys']).toContain('-${{ steps.sources.outputs.hash }}-');
    expect(cache?.with?.path).toContain('packages/*/dist');
    const list = steps('typecheck').find((s) => s.run?.includes('git ls-files'))?.run ?? '';
    const command = /\$\((git ls-files .*?) \| sha256sum/.exec(list)?.[1] ?? 'false';
    const files = execFileSync('bash', ['-c', command], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(files).toContain('packages/kernel/src/index.ts');
    expect(files.some((f) => f.includes('/src/screens/'))).toBe(true);
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });
});

describe('the check every pull request needs', () => {
  const check = workflow.jobs.check as Job;
  const step = check.steps[0] as Step;
  const verdict = (results: Record<string, string>) => {
    try {
      execFileSync('bash', ['-c', step.run ?? ''], {
        env: {
          PATH: process.env.PATH,
          SCOPE: 'success',
          STATIC: 'success',
          TYPECHECK: 'success',
          TYPECHECK_IN_SCOPE: 'true',
          TEST: 'success',
          TESTS_IN_SCOPE: 'true',
          SIZE: 'success',
          SIZE_IN_SCOPE: 'true',
          DOCLING: 'success',
          ...results,
        },
      });
      return 'pass';
    } catch {
      return 'fail';
    }
  };

  it('waits for every job but the secret scan and the image, which are required on their own', () => {
    const jobs = Object.keys(workflow.jobs).filter(
      (j) => !['check', 'secrets', 'image'].includes(j),
    );
    expect([check.needs].flat().sort()).toEqual(jobs.sort());
    for (const job of jobs)
      expect(Object.values(step.env ?? {})).toContain(`\${{ needs.${job}.result }}`);
  });

  it('passes only when every job in scope succeeded', () => {
    expect(verdict({})).toBe('pass');
    expect(verdict({ TYPECHECK: 'failure' })).toBe('fail');
    expect(verdict({ TYPECHECK: 'cancelled' })).toBe('fail');
    expect(verdict({ TYPECHECK: 'skipped' })).toBe('fail');
    expect(verdict({ TYPECHECK: 'skipped', TYPECHECK_IN_SCOPE: 'false' })).toBe('pass');
    expect(verdict({ STATIC: 'skipped' })).toBe('fail');
    expect(verdict({ TEST: 'failure' })).toBe('fail');
    expect(verdict({ TEST: 'skipped', TESTS_IN_SCOPE: 'false' })).toBe('pass');
    expect(verdict({ DOCLING: 'failure' })).toBe('fail');
  });

  it('skips the typecheck exactly when the scope leaves out the static checks', () => {
    expect(step.env?.TYPECHECK_IN_SCOPE).toBe('${{ needs.scope.outputs.static }}');
    expect(workflow.jobs.typecheck?.if).toBe("needs.scope.outputs.static == 'true'");
  });
});

describe('the secret scan', () => {
  const gitleaks = () => steps('secrets').find((s) => s.run?.includes('gitleaks'));

  it('scans only the pull request’s own commits on a pull request, and the whole history of HEAD otherwise', () => {
    expect(gitleaks()?.env?.RANGE).toBe(
      "${{ github.event_name == 'pull_request' && format('{0}..HEAD', github.event.pull_request.base.sha) || 'HEAD' }}",
    );
    expect(gitleaks()?.run).toMatch(/ git \/repo --log-opts="\$RANGE" /);
  });

  it('names the file, line and rule of a leak, with the secret redacted', () => {
    expect(gitleaks()?.run).toContain(' --verbose ');
    expect(gitleaks()?.run).toContain(' --redact ');
  });

  it('still reads the whole history of that commit', () => {
    expect(
      steps('secrets').find((s) => s.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'],
    ).toBe(0);
  });
});
