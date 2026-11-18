import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/review-snapshot.yml'), 'utf8'),
) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: {
    snapshot: {
      permissions: Record<string, string>;
      steps: { uses?: string; run?: string; shell?: string; env?: Record<string, string> }[];
    };
  };
};
const job = workflow.jobs.snapshot;

describe('review snapshot workflow', () => {
  it('only runs on a schedule or by hand, never on pull request code', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('can read code scanning and nothing else', () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ 'security-events': 'read' });
  });

  it('checks out no code', () => {
    expect(job.steps.some((s) => s.uses?.startsWith('actions/checkout'))).toBe(false);
  });

  it('pins every action to a full commit', () => {
    for (const s of job.steps.filter((s) => s.uses))
      expect(s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('fails the job when a command in a pipe fails', () => {
    for (const s of job.steps.filter((s) => s.run)) expect(s.shell).toBe('bash');
  });

  it('passes repository values through the environment, not into the script', () => {
    const script = job.steps.map((s) => s.run ?? '').join('\n');
    expect(script).not.toMatch(/\$\{\{/);
  });
});
