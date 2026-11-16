import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  if?: string;
  'continue-on-error'?: boolean;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string | string[];
  environment?: string;
  'continue-on-error'?: boolean;
  permissions: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const root = join(import.meta.dirname, '..');
const load = (name: string) =>
  parse(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow;
const deploy = load('deploy.yml');
const smoke = load('smoke.yml');
const weekly = load('weekly-summary.yml');
const changelog = deploy.jobs.changelog as Job;
const release = deploy.jobs.release as Job;
const collect = weekly.jobs.collect as Job;
const post = weekly.jobs.post as Job;
const ours = { changelog, release, collect, post };
const holdsSlack = (job: Job) => JSON.stringify(job).includes('secrets.SLACK_');
const writes = (job: Job) =>
  Object.entries(job.permissions)
    .filter(([, v]) => v === 'write')
    .map(([k]) => k);

describe('the delivery workflows', () => {
  it('pin every action to a full commit SHA', () => {
    for (const job of Object.values(ours))
      for (const step of job.steps.filter((s) => s.uses))
        expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('make the release only after a deploy to test from main, and never fail the deploy', () => {
    expect(changelog.needs).toBe('deploy-test');
    expect(changelog.if).toBe("github.ref == 'refs/heads/main'");
    expect(release.if).toContain("needs.deploy-test.result == 'success'");
    expect(release.if).toContain("github.ref == 'refs/heads/main'");
    for (const job of [changelog, release]) expect(job['continue-on-error']).toBe(true);
  });

  it('reach the model only with the federated review identity, and never hold a Slack secret there', () => {
    for (const job of [changelog, collect]) {
      expect(job.environment).toBe('smoke-review');
      expect(JSON.stringify(job)).not.toContain('secrets.');
      const login = job.steps.find((s) => s.uses?.startsWith('azure/login@'));
      expect(login?.with?.['client-id']).toBe('${{ vars.AZURE_REVIEW_CLIENT_ID }}');
      expect(login?.['continue-on-error']).toBe(true);
    }
    expect(changelog.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(collect.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
  });

  it('let only the release job write, and only contents', () => {
    expect(writes(release)).toEqual(['contents']);
    expect(release.environment).toBeUndefined();
    for (const job of [post]) expect(writes(job)).toEqual([]);
    expect(weekly.permissions).toEqual({});
  });

  it('give the Slack secrets only to the weekly post', () => {
    const holders = [deploy, smoke, weekly].flatMap((w) =>
      Object.entries(w.jobs)
        .filter(([, j]) => holdsSlack(j))
        .map(([n]) => n),
    );
    expect(holders.sort()).toEqual(['post']);
    for (const job of [post]) expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('pass untrusted text only through files and environment variables, never a run script', () => {
    for (const job of Object.values(ours))
      for (const step of job.steps.filter((s) => s.run)) expect(step.run).not.toContain('${{');
  });

  it('check out without keeping the token', () => {
    for (const job of Object.values(ours))
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@')))
        expect(step.with?.['persist-credentials']).toBe(false);
  });
});

describe('the weekly summary workflow', () => {
  it('runs on Fridays at both UTC hours that can be 13:00 in Oslo, and by hand, never on a pull request', () => {
    expect(Object.keys(weekly.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(weekly.on.schedule).toEqual([{ cron: '0 11 * * 5' }, { cron: '0 12 * * 5' }]);
  });

  it('lets the script pick the schedule that is 13:00 in Oslo and posts only then', () => {
    const due = collect.steps.find((s) => s.id === 'due');
    expect(due?.env?.SCHEDULE).toBe('${{ github.event.schedule }}');
    expect(post.if).toBe("needs.collect.outputs.due == 'true'");
    expect(collect.if).toBe("github.ref == 'refs/heads/main'");
  });

  it('posts once a week: runs queue, and only a real post leaves the posted artifact', () => {
    expect(weekly.concurrency).toEqual({ group: 'weekly-summary', 'cancel-in-progress': false });
    const upload = post.steps.find((s) => s.with?.name === 'weekly-posted');
    expect(upload?.with?.path).toBe('delivery-out/posted.json');
    expect(upload?.with?.['if-no-files-found']).toBe('ignore');
    expect(post.permissions).toEqual({ contents: 'read' });
  });
});
