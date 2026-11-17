import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string;
  environment?: string;
  permissions: Record<string, string>;
  steps: Step[];
}

const deployGate = [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'workflow_dispatch'",
  "github.event.workflow_run.head_branch == 'main'",
];

const workflow = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/demos.yml'), 'utf8'),
) as {
  on: Record<string, { workflows?: string[]; types?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const { voice, record } = workflow.jobs as { voice: Job; record: Job };

describe('the demos workflow', () => {
  it('runs by hand or after a deploy, never on a pull request, and grants nothing by default', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(workflow.on.workflow_run).toEqual({ workflows: ['deploy'], types: ['completed'] });
    expect(workflow.permissions).toEqual({});
  });

  it('records only from main, and after a deploy only when a deploy from main succeeded', () => {
    for (const job of [voice, record]) {
      expect(job.if).toContain(
        "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      );
      for (const condition of deployGate) expect(job.if).toContain(condition);
    }
  });

  it('records the deployed commit after a deploy', () => {
    for (const job of [voice, record])
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@')))
        expect(step.with?.ref).toBe('${{ github.event.workflow_run.head_sha }}');
  });

  it('narrates after a deploy, and by hand only when asked', () => {
    expect(voice.if).toMatch(
      /^\(github\.event_name == 'workflow_run' \|\| inputs\.narrate\) && \(/,
    );
  });

  it('records the demos without a voice when narration is skipped or fails', () => {
    expect(record.needs).toBe('voice');
    expect(record.if).toMatch(/^always\(\) && needs\.voice\.result != 'cancelled' && \(/);
    const download = record.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download).toMatchObject({ if: "needs.voice.result == 'success'" });
  });

  it('skips every voice step when no speech resource is set', () => {
    for (const step of voice.steps) expect(step.if).toMatch(/^vars\.SPEECH_RESOURCE [!=]= ''$/);
  });

  it('pins every action to a full commit SHA', () => {
    for (const job of [voice, record])
      for (const step of job.steps.filter((s) => s.uses))
        expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('keeps the key and the Azure identity in separate jobs, each with read access only', () => {
    expect(JSON.stringify(voice)).not.toContain('secrets.');
    expect(voice.environment).toBe('smoke-review');
    expect(voice.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(record.environment).toBe('genki-test');
    expect(record.permissions).toEqual({ contents: 'read' });
    const holders = record.steps.filter((s) => JSON.stringify(s).includes('secrets.'));
    expect(holders.map((s) => s.run)).toEqual(['node scripts/demo.ts record --only "$DEMO_ONLY"']);
    expect(holders[0]?.env?.DEMO_API_KEY).toBe('${{ secrets.SMOKE_API_KEY }}');
  });

  it('passes inputs and outputs only through env and files, never into a run script', () => {
    for (const job of [voice, record])
      for (const step of job.steps.filter((s) => s.run)) expect(step.run).not.toContain('${{');
  });

  it('checks out without keeping the token', () => {
    for (const job of [voice, record])
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@')))
        expect(step.with?.['persist-credentials']).toBe(false);
  });

  it('keeps only the videos, subtitles and failure screenshots', () => {
    const upload = record.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path?.trim().split('\n').sort()).toEqual([
      'demos/out/*/*.mp4',
      'demos/out/*/*.srt',
      'demos/out/*/failed-step-*.png',
    ]);
  });
});
