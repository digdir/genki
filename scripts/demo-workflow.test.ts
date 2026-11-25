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

const workflow = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/demos.yml'), 'utf8'),
) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const { voice, record } = workflow.jobs as { voice: Job; record: Job };

describe('the demos workflow', () => {
  it('runs only by hand, never on a pull request or a deploy, and grants nothing by default', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
  });

  it('records only from main', () => {
    for (const job of [voice, record]) expect(job.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('records the demos without a voice when narration is skipped or fails', () => {
    expect(record.needs).toBe('voice');
    expect(record.if).toMatch(/^always\(\) && needs\.voice\.result != 'cancelled'/);
    const download = record.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download).toMatchObject({ if: "needs.voice.result == 'success'" });
  });

  it('uploads the voiced clips from the hidden .voice folder and downloads them where recording looks', () => {
    const upload = voice.steps.find((s) => s.with?.name === 'demo-voice');
    const download = record.steps.find((s) => s.with?.name === 'demo-voice');
    expect(upload?.with?.path).toBe('demos/out/.voice/*.mp3');
    expect(upload?.with?.['include-hidden-files']).toBe(true);
    expect(download?.with?.path).toBe('demos/out/.voice');
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

  it('hands the recordings to the library with the recorder key, in the job that records', () => {
    const recorder = record.steps.find((s) => s.env?.DEMO_RECORDER_KEY);
    expect(recorder?.env?.DEMO_RECORDER_KEY).toBe('${{ secrets.DEMO_RECORDER_KEY }}');
    expect(recorder?.env?.DEMO_API_URL).toBe('${{ vars.SMOKE_API_URL }}');
    expect(JSON.stringify(voice)).not.toContain('DEMO_RECORDER_KEY');
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
