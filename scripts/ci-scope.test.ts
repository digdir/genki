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

  it('runs only the affected tests when every change is TypeScript, JavaScript or CSS source', () => {
    expect(
      scopeOf([
        m('apps/console/src/screens/SupportAccess.tsx'),
        m('packages/identity/src/claims.ts'),
      ]).tests,
    ).toBe('changed');
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
      tests: 'changed',
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

describe('the CI workflow in the merge queue', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8'),
  ) as {
    on: Record<string, unknown>;
    jobs: Record<string, { steps: { env?: Record<string, string> }[] }>;
  };
  const env = (job: string, name: string) =>
    workflow.jobs[job]?.steps.map((s) => s.env?.[name]).find(Boolean) ?? '';

  it('runs for a merge group, so two pull requests that pass alone are checked together', () => {
    expect(workflow.on).toHaveProperty('merge_group');
  });

  it('scopes a merge group from the commit it lands on, as it scopes a pull request from its base', () => {
    expect(env('scope', 'BASE')).toContain('github.event.merge_group.base_sha');
    expect(env('test', 'CHANGED')).toContain('github.event.merge_group.base_sha');
  });
});
