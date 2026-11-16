import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency?: { group: string };
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as Workflow;
const deploy = workflow('deploy.yml');
const job = (name: string) => {
  const found = deploy.jobs[name];
  if (!found) throw new Error(`no job ${name}`);
  return found;
};
const step = (j: Job, id: string) => {
  const found = j.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

describe('a deploy to genki-test', () => {
  it('starts the new API as a candidate with no traffic and keeps the other apps as they are', () => {
    const run = step(job('candidate'), 'deploy').run ?? '';
    expect(run).toContain('apiRevisionSuffix="${{ steps.plan.outputs.suffix }}"');
    expect(run).toContain('apiLiveRevision="${{ steps.plan.outputs.live }}"');
    for (const app of ['worker', 'apps', 'docling'])
      expect(run).toContain(`${app}Image="\${{ steps.plan.outputs.${app} }}"`);
    expect(step(job('candidate'), 'plan').run).toContain(
      'suffix="r${{ github.run_id }}-${{ github.run_attempt }}"',
    );
  });

  it('keeps the worker reporting the version it runs while the candidate is checked', () => {
    expect(step(job('candidate'), 'deploy').run).toContain(
      'workerVersion="${{ steps.plan.outputs.worker_version }}"',
    );
    expect(step(job('deploy-test'), 'deploy').run).not.toContain('workerVersion=');
  });

  it('stops a candidate that failed its health check or the gate, never the live revision', () => {
    const discard = job('discard');
    expect(discard.needs).toEqual(['candidate', 'gate']);
    expect(discard.if).toContain("needs.gate.result == 'failure'");
    expect(discard.if).toContain("needs.candidate.result == 'failure'");
    expect(discard.if).toContain("needs.candidate.outputs.live != ''");
    const stop = discard.steps.find((s) => s.name === 'stop the candidate that failed');
    expect(stop?.env?.CANDIDATE).toBe('${{ needs.candidate.outputs.revision }}');
    expect(stop?.run).toContain('[ "$CANDIDATE" != "$LIVE" ] || exit 0');
    expect(stop?.run).toContain('az containerapp revision deactivate');
    expect(discard.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('promotes the candidate only when a model check ran on it, whatever the daily cap', () => {
    const gate = job('gate');
    expect(step(gate, 'run').env?.SMOKE_CAPPED).toBe('false');
    expect(gate.steps.find((s) => s.name === 'no failed check')?.run).toContain(
      '[ "$MODELS" != true ]',
    );
  });

  it('gives users the new API only after the smoke test passed on the candidate', () => {
    const promote = job('deploy-test');
    expect(promote.needs).toEqual(['build', 'candidate', 'gate']);
    expect(promote.if).toContain("needs.gate.result == 'success'");
    expect(promote.if).toContain("needs.candidate.result == 'success'");
    expect(step(promote, 'api').run).toContain('echo "live=$CANDIDATE"');
    expect(step(promote, 'deploy').run).toContain(
      'apiLiveRevision="${{ steps.api.outputs.live }}" apiPreviousRevision="${{ steps.api.outputs.previous }}"',
    );
  });

  it('runs the gate against the candidate with the smoke key, no model and no browser', () => {
    const gate = job('gate');
    expect(gate.needs).toBe('candidate');
    expect(gate.environment).toBe('genki-test');
    expect(gate.permissions['id-token']).toBeUndefined();
    const text = JSON.stringify(gate);
    expect(text).not.toContain('claude-code-action');
    expect(text).not.toContain('playwright');
    const run = step(gate, 'run');
    expect(run.env?.SMOKE_API_URL).toBe('${{ needs.candidate.outputs.url }}');
    expect(run.env?.SMOKE_EXPECT_SHA).toBe('${{ github.sha }}');
    expect(run.env?.SMOKE_REVIEW).toBe('false');
    expect(gate.steps.find((s) => s.name === 'no failed check')?.run).toContain(
      '[ "$OUTCOME" = fail ]',
    );
  });

  it('stops only API revisions that no label names, and only after the template listed the live one', () => {
    const cleanup = job('candidate').steps.find((s) => s.name === 'stop unused API revisions');
    expect(cleanup?.if).toContain("steps.deploy.outcome == 'success'");
    expect(cleanup?.run).toContain('grep -qx "${{ steps.plan.outputs.live }}" || exit 0');
  });
});

describe('the rollback workflow', () => {
  const rollback = workflow('rollback.yml');

  it('swaps the live and previous API revisions in one run, never during a deploy', () => {
    expect(Object.keys(rollback.on)).toEqual(['workflow_dispatch']);
    expect(rollback.concurrency?.group).toBe('deploy-test');
    const run = rollback.jobs.api?.steps.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('az containerapp revision label swap');
    expect(run).toContain('--source previous --target live');
  });

  it('keeps the labels and the worker version when infra runs alone', () => {
    const run = workflow('infra.yml')
      .jobs.apply?.steps.map((s) => s.run ?? '')
      .join('\n');
    expect(run).toContain(
      'apiRevisionSuffix="${{ steps.current.outputs.suffix }}" apiLiveRevision="${{ steps.current.outputs.live }}" apiPreviousRevision="${{ steps.current.outputs.previous }}"',
    );
    expect(run).toContain('workerVersion="${{ steps.current.outputs.worker_version }}"');
  });
});

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Resource {
  type: string;
  name: string;
  properties: {
    configuration: { activeRevisionsMode?: string; ingress?: { traffic?: string } };
    template: { revisionSuffix?: string };
  };
}

describe.skipIf(!hasAz && !process.env.CI)('API revisions in the template', () => {
  let resources: Resource[] = [];
  let variables: Record<string, string> = {};
  beforeAll(() => {
    const built = JSON.parse(
      execFileSync('az', ['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as {
      resources: {
        name: string;
        properties: {
          template: { resources: Resource[]; variables: Record<string, string> };
        };
      }[];
    };
    const module = built.resources.find((r) => r.name === 'containerapps')?.properties.template;
    resources = (module?.resources ?? []).filter((r) => r.type === 'Microsoft.App/containerApps');
    variables = module?.variables ?? {};
  }, 120_000);

  it('runs several revisions of the API only, and only once a live revision is named', () => {
    const modes = Object.fromEntries(
      resources.map((r) => [r.name, r.properties.configuration.activeRevisionsMode]),
    );
    expect(modes["[format('{0}-api', parameters('name'))]"]).toBe(
      "[if(empty(parameters('apiLiveRevision')), 'Single', 'Multiple')]",
    );
    const others = Object.entries(modes).filter(([name]) => !name.includes("'{0}-api'"));
    expect(others.length).toBeGreaterThan(0);
    for (const [name, mode] of others) expect({ name, mode }).toEqual({ name, mode: 'Single' });
  });

  it('keeps the previous label after a rollback, when the template names the previous revision', () => {
    expect(variables.apiCandidateLabelled).toContain(
      "not(contains(createArray(parameters('apiLiveRevision'), parameters('apiPreviousRevision')), variables('apiCandidateRevision')))",
    );
    expect(variables.apiTraffic).toContain(
      "if(or(empty(parameters('apiPreviousRevision')), equals(parameters('apiPreviousRevision'), parameters('apiLiveRevision'))), createArray(), createArray(createObject('revisionName', parameters('apiPreviousRevision'), 'weight', 0, 'label', 'previous')))",
    );
  });

  it('gives the worker its own version, the API version unless one is named', () => {
    const worker = resources.find((r) => r.name.includes("'{0}-worker'"));
    expect(JSON.stringify(worker?.properties.template)).toContain(
      "createObject('name', 'APP_VERSION', 'value', if(empty(parameters('workerVersion')), parameters('appVersion'), parameters('workerVersion')))",
    );
    expect(variables.serverEnv).not.toContain('APP_VERSION');
  });

  it('labels the live revision with all traffic and the candidate and previous with none', () => {
    const traffic = variables.apiTraffic ?? '';
    expect(traffic).toContain("'weight', 100, 'label', 'live'");
    expect(traffic).toContain("'weight', 0, 'label', 'candidate'");
    expect(traffic).toContain("'weight', 0, 'label', 'previous'");
  });
});
