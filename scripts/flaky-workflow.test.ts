import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Job {
  if?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix: { shard: number[]; run: number[] } };
  steps: Step[];
}

const text = readFileSync(join(import.meta.dirname, '../.github/workflows/flaky.yml'), 'utf8');
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const testRun = workflow.jobs.run?.steps.find((step) => step.run?.includes('vitest run'));

describe('the nightly flaky test workflow', () => {
  it('runs every shard three times on main with the quarantine off and JUnit output', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.jobs.run?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.run?.strategy?.matrix).toEqual({ shard: [1, 2, 3, 4], run: [1, 2, 3] });
    expect(testRun?.env?.QUARANTINE).toBe('off');
    expect(testRun?.run).toContain('--reporter=junit');
    expect(testRun?.run).not.toContain('--retry');
  });

  it('reads the repository only, uses no secrets and posts nothing', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toBeUndefined();
    expect(text).not.toMatch(/secrets\.|GITHUB_TOKEN|github-script|gh (?:issue|pr|api)/);
  });

  it('pins every action to a full commit SHA', () => {
    for (const step of steps.filter((s) => s.uses))
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('writes the per-test summary from every run it uploaded', () => {
    const summary = workflow.jobs.summary?.steps.at(-1)?.run;
    expect(summary).toBe('node scripts/flaky-summary.ts junit >> "$GITHUB_STEP_SUMMARY"');
    expect(workflow.jobs.summary?.if).toContain('!cancelled()');
  });
});
