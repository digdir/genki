import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string | string[];
  environment: { name: string; deployment: boolean };
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

const workflow = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/demo-recorder.yml'), 'utf8'),
) as {
  on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};
const demos = parse(
  readFileSync(join(import.meta.dirname, '../.github/workflows/demos.yml'), 'utf8'),
) as { concurrency: { group: string } };
const { queue, voice, record } = workflow.jobs as { queue: Job; voice: Job; record: Job };
const jobs = [queue, voice, record];
const list = queue.steps[0] as Step;

const runList = (key: string, answer: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-recorder-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const curl = join(bin, 'curl');
    writeFileSync(
      curl,
      `#!/usr/bin/env bash\ncat > "${dir}/headers"\necho "$@" > "${dir}/args"\nprintf '%s' '${answer}'\n`,
      {
        mode: 0o755,
      },
    );
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const log = execFileSync('bash', ['-c', list.run ?? ''], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DEMO_RECORDER_KEY: key,
        DEMO_API_URL: 'https://api.example/',
        GITHUB_OUTPUT: output,
      },
    });
    const read = (name: string) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return '';
      }
    };
    return { log, output: read('output'), headers: read('headers'), args: read('args') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('the demo-recorder workflow', () => {
  it('has jq on the path, which its first step and these tests run', () => {
    expect(() => execFileSync('jq', ['--version'])).not.toThrow();
  });

  it('looks for queued recordings every five minutes and by hand, granting nothing by default', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '*/5 * * * *' }]);
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
  });

  it('records one run at a time in its own group, so a tick never cancels a hand-run demos run', () => {
    expect(workflow.concurrency).toEqual({
      group: 'demo-recorder-genki-test',
      'cancel-in-progress': false,
    });
    expect(demos.concurrency.group).not.toBe(workflow.concurrency.group);
  });

  it('records only from main', () => {
    expect(queue.if).toContain("github.ref == 'refs/heads/main'");
    for (const job of [voice, record]) expect(job.needs).toContain('queue');
  });

  it('ends after the first step when nothing is queued, voicing and recording nothing', () => {
    expect(list.id).toBe('list');
    for (const step of queue.steps.slice(1))
      expect(step.if).toBe("steps.list.outputs.count != '0'");
    expect(queue.outputs?.count).toBe('${{ steps.list.outputs.count }}');
    expect(voice.if).toContain("needs.queue.outputs.count != '0'");
    expect(record.if).toContain("needs.queue.outputs.count != '0'");
    expect(record.if).toContain("needs.queue.result == 'success'");
    expect(record.if).toContain("needs.voice.result != 'cancelled'");
  });

  it('counts nothing queued from an empty list, sending the key as a header on stdin', () => {
    const { output, headers, args } = runList('hemmelig-nøkkel', '{"data":[]}');

    expect(output).toBe('count=0\n');
    expect(headers).toBe('x-recorder-key: hemmelig-nøkkel\n');
    expect(args).toContain('https://api.example/recorder/recordings?status=queued');
    expect(args).not.toContain('hemmelig');
  });

  it('counts the queued recordings the API lists', () => {
    const { output } = runList('k', '{"data":[{"id":"a","demo":"x"},{"id":"b","demo":"y"}]}');

    expect(output).toBe('count=2\n');
  });

  it('counts nothing and calls nobody when no recorder key is set', () => {
    const { output, args, log } = runList('', '{"data":[{"id":"a"}]}');

    expect(output).toBe('count=0\n');
    expect(args).toBe('');
    expect(log).toContain('DEMO_RECORDER_KEY is not set');
  });

  it('checks the speech setting in each voice step, where the environment variable is visible', () => {
    expect(voice.if).not.toContain('SPEECH_RESOURCE');
    for (const step of voice.steps) expect(step.if).toMatch(/^vars\.SPEECH_RESOURCE [!=]= ''$/);
  });

  it('voices only the lines of the queued recordings, without the recorder key', () => {
    expect(voice.steps.map((s) => s.run).filter(Boolean)).toContain(
      'node scripts/demo.ts voice --queued',
    );
    expect(JSON.stringify(voice)).not.toContain('secrets.');
    expect(voice.environment).toEqual({ name: 'smoke-review', deployment: false });
    expect(voice.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('records the queued recordings with the key in genki-test, with read access only', () => {
    expect(record.steps.at(-1)?.run).toBe('node scripts/demo.ts recording --queued');
    expect(record.steps.at(-1)?.env?.DEMO_RECORDER_KEY).toBe('${{ secrets.DEMO_RECORDER_KEY }}');
    expect(record.needs).toEqual(['queue', 'voice']);
    expect(record.if).toMatch(/^always\(\) && /);
    for (const job of [queue, record]) {
      expect(job.environment).toEqual({ name: 'genki-test', deployment: false });
      expect(job.permissions).toEqual({ contents: 'read' });
    }
  });

  it('pins every action to a full commit SHA and checks out without keeping the token', () => {
    for (const job of jobs)
      for (const step of job.steps.filter((s) => s.uses)) {
        expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        if (step.uses?.startsWith('actions/checkout@'))
          expect(step.with?.['persist-credentials']).toBe(false);
      }
  });

  it('passes inputs and secrets only through env, never into a run script', () => {
    for (const job of jobs)
      for (const step of job.steps.filter((s) => s.run)) expect(step.run).not.toContain('${{');
  });
});
