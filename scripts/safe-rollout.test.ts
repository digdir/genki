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
  uses?: string;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  env?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
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
  const found = (j.steps ?? []).find((s) => s.id === id);
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
    const stop = (discard.steps ?? []).find((s) => s.name === 'stop the candidate that failed');
    expect(stop?.env?.CANDIDATE).toBe('${{ needs.candidate.outputs.revision }}');
    expect(stop?.run).toContain('[ "$CANDIDATE" != "$LIVE" ] || exit 0');
    expect(stop?.run).toContain('az containerapp revision deactivate');
    expect(discard.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('promotes the candidate only when a model check ran on it, whatever the daily cap', () => {
    const gate = job('gate');
    expect(step(gate, 'run').env?.SMOKE_CAPPED).toBe('false');
    expect((gate.steps ?? []).find((s) => s.name === 'no failed check')?.run).toContain(
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
    expect((gate.steps ?? []).find((s) => s.name === 'no failed check')?.run).toContain(
      '[ "$OUTCOME" = fail ]',
    );
  });

  it('stops only API revisions that no label names, and only after the template listed the live one', () => {
    const cleanup = (job('candidate').steps ?? []).find(
      (s) => s.name === 'stop unused API revisions',
    );
    expect(cleanup?.if).toContain("steps.deploy.outcome == 'success'");
    expect(cleanup?.run).toContain('grep -qx "${{ steps.plan.outputs.live }}" || exit 0');
  });
});

describe('a deploy that takes minutes, not half an hour', () => {
  it('runs the checks again only when ci has not passed on the commit’s push to main', () => {
    const ci = step(job('ci'), 'ci').run ?? '';
    expect(ci).toContain('actions/workflows/ci.yml/runs?head_sha=$SHA&event=push');
    expect(ci).toContain('select(.head_branch == "main" and .path == ".github/workflows/ci.yml")');
    expect(ci).toContain('any(.conclusion == "success")');
    expect(job('ci').permissions).toEqual({ contents: 'read', actions: 'read' });
    const check = job('check');
    expect(check.if).toBe("needs.ci.outputs.passed != 'true'");
    expect(check.uses).toBe('./.github/workflows/ci.yml');
    const candidate = job('candidate');
    expect(candidate.needs).toEqual(['ci', 'check', 'build']);
    expect(candidate.if).toContain("needs.ci.result == 'success'");
    expect(candidate.if).toContain("needs.build.result == 'success'");
    expect(candidate.if).toContain(
      "(needs.ci.outputs.passed == 'true' || needs.check.result == 'success')",
    );
  });

  it('takes the images the push to main built, and builds only those missing', () => {
    expect(job('build').uses).toBe('./.github/workflows/images.yml');
    const images = workflow('images.yml');
    expect(Object.keys(images.on)).toEqual(['push', 'workflow_call']);
    expect(images.on.push).toEqual({ branches: ['main'] });
    const build = images.jobs.build;
    expect(build?.concurrency).toEqual({
      group: 'images-${{ github.sha }}',
      'cancel-in-progress': false,
    });
    expect(build?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    for (const image of ['api', 'worker', 'apps', 'docling']) {
      const built = build?.steps?.find((s) => s.id === image);
      expect(built?.if, image).toBe(`steps.have.outputs.${image} == ''`);
      expect(JSON.stringify(built), image).toContain('provenance');
    }
    expect(build?.steps?.find((s) => s.id === 'have')?.run).toContain(
      'echo "api=$(digest "genai-api:$SHA")"',
    );
  });

  it('applies the whole template unless the last full deploy applied the same fingerprint', () => {
    const state = step(job('candidate'), 'infra');
    expect(state.run).toContain(
      'scripts/infra-state.sh infra/env/test.bicepparam "$RG" "$FORCE_INFRASTRUCTURE"',
    );
    expect(state.env?.FORCE_INFRASTRUCTURE).toBe('${{ inputs.infrastructure }}');
    expect(step(job('candidate'), 'deploy').run).toContain(
      'deployInfrastructure="${{ steps.infra.outputs.infrastructure }}" infraFingerprint="${{ steps.infra.outputs.fingerprint }}"',
    );
    const users = step(job('deploy-test'), 'deploy').run ?? '';
    expect(users).toContain('scripts/infra-state.sh infra/env/test.bicepparam');
    expect(users).toContain(
      '--parameters deployInfrastructure="$infrastructure" infraFingerprint="$fingerprint"',
    );
    const infra = workflow('infra.yml').jobs.apply?.steps ?? [];
    expect(infra.find((s) => s.id === 'fingerprint')?.run).toContain(
      'scripts/infra-state.sh "infra/env/$ENVIRONMENT.bicepparam" "$RG" true',
    );
    expect(infra.map((s) => s.run ?? '').join('\n')).toContain(
      'infraFingerprint="${{ steps.fingerprint.outputs.fingerprint }}"',
    );
  });

  it('gives the template every setting it reads, in every job that applies it', () => {
    const reads = [
      ...read('infra/env/test.bicepparam').matchAll(/readEnvironmentVariable\('([A-Z_]+)'/g),
    ].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(20);
    const passed = {
      candidate: job('candidate').env ?? {},
      'deploy-test': step(job('deploy-test'), 'deploy').env ?? {},
      infra: workflow('infra.yml').jobs.apply?.env ?? {},
    };
    for (const [name, env] of Object.entries(passed))
      expect(
        reads.filter((variable) => variable && !(variable in env)),
        name,
      ).toEqual([]);
  });

  it('gives users the new API only through the gate, also when the checks were not run again', () => {
    expect(job('gate').if).toContain('!cancelled()');
    expect(job('gate').if).toContain("needs.candidate.result == 'success'");
    expect(job('deploy-test').if).toContain(
      "(needs.gate.result == 'success' || (needs.gate.result == 'skipped' && needs.candidate.outputs.url == ''))",
    );
    // A job without a status function is skipped when one before it was, and `check` is skipped when ci passed.
    for (const name of ['candidate', 'gate', 'deploy-test', 'changelog', 'deploy-prod'])
      expect(job(name).if, name).toMatch(/^!cancelled\(\) && /);
  });

  it('polls the new revision every five seconds, for at most five minutes', () => {
    const polls = Object.values(deploy.jobs)
      .flatMap((j) => j.steps ?? [])
      .map((s) => s.run ?? '')
      .filter((run) => run.includes('/health"'));
    expect(polls).toHaveLength(3);
    for (const run of polls) {
      expect(run).toContain('for _ in $(seq 1 60); do');
      expect(run).toContain('sleep 5');
    }
  });
});

describe('the rollback workflow', () => {
  const rollback = workflow('rollback.yml');

  it('swaps the live and previous API revisions in one run, never during a deploy', () => {
    expect(Object.keys(rollback.on)).toEqual(['workflow_dispatch']);
    expect(rollback.concurrency?.group).toBe('deploy-test');
    const run = rollback.jobs.api?.steps?.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('az containerapp revision label swap');
    expect(run).toContain('--source previous --target live');
  });

  it('keeps the labels and the worker version when infra runs alone', () => {
    const run = workflow('infra.yml')
      .jobs.apply?.steps?.map((s) => s.run ?? '')
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
  let conditions: Record<string, string> = {};
  let expressions: string[] = [];
  beforeAll(() => {
    const built = JSON.parse(
      execFileSync('az', ['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as {
      outputs: Record<string, unknown>;
      resources: {
        name: string;
        type: string;
        condition?: string;
        properties?: {
          parameters?: Record<string, unknown>;
          template: { resources: Resource[]; variables: Record<string, string> };
        };
      }[];
    };
    const module = built.resources.find((r) => r.name === 'containerapps')?.properties?.template;
    resources = (module?.resources ?? []).filter((r) => r.type === 'Microsoft.App/containerApps');
    variables = module?.variables ?? {};
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(strings)
          : [];
    expressions = [
      ...built.resources.flatMap((r) => strings(r.properties?.parameters)),
      ...strings(built.outputs),
    ];
    conditions = Object.fromEntries(
      built.resources
        .filter((r) => r.type === 'Microsoft.Resources/deployments')
        .map((r) => [r.name, r.condition ?? '']),
    );
  }, 120_000);

  it('deploys the container apps alone, and no infrastructure, when deployInfrastructure is false', () => {
    const infrastructure = [
      'network',
      'monitoring',
      'registry',
      'keyvault',
      'postgres',
      'storage',
      'knowledge-network',
      'knowledge-peering',
      'knowledge-postgres',
      'alerts',
      'dns',
    ];
    expect(Object.keys(conditions).sort()).toEqual([...infrastructure, 'containerapps'].sort());
    for (const name of infrastructure)
      expect(conditions[name], name).toContain("variables('infra')");
    expect(conditions.containerapps).toBe('');
  });

  it('reads no infrastructure module’s outputs unless it deploys the infrastructure', () => {
    // Azure evaluates the references of a module it does not deploy, and the record of an old one can be gone.
    const reads = expressions.filter((e) =>
      Object.keys(conditions)
        .filter((name) => name !== 'containerapps')
        .some((name) => e.includes(`resourceId('Microsoft.Resources/deployments', '${name}')`)),
    );
    expect(reads.length).toBeGreaterThan(10);
    for (const e of reads) expect(e).toContain("variables('infra')");
  });

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
