import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  const stepNamed = (jobName: string, name: string) => {
    const steps = job(jobName).steps ?? [];
    const at = steps.findIndex((s) => s.name === name);
    if (at < 0) throw new Error(`no step ${name} in ${jobName}`);
    return { at, step: steps[at] as Step, steps };
  };

  it('stops every API revision but the live one before the candidate starts, so the gate runs beside live alone', () => {
    const {
      at,
      step: stop,
      steps,
    } = stepNamed('candidate', 'stop every API revision but the live one');
    expect(at).toBeLessThan(steps.findIndex((s) => s.id === 'deploy'));
    expect(stop.if).toBe("env.ALTINN_PDP_URL != '' && steps.plan.outputs.live != ''");
    expect(stop.run).toBe('scripts/stop-unused-revisions.sh "$RG" "$APP" "$LIVE" all-but-live');
    expect(stop.env?.LIVE).toBe('${{ steps.plan.outputs.live }}');
    expect(step(job('candidate'), 'deploy').run).toContain(
      'apiLiveRevision="${{ steps.plan.outputs.live }}" apiPreviousRevision="" ',
    );
  });

  it('stops the unlabelled ones after users moved, so the old live revision stays as previous for a rollback', () => {
    const { at, step: stop, steps } = stepNamed('deploy-test', 'stop unused API revisions');
    expect(at).toBeGreaterThan(steps.findIndex((s) => s.id === 'deploy'));
    expect(stop.if).toBe(
      "!cancelled() && steps.deploy.outcome == 'success' && steps.api.outputs.live != ''",
    );
    expect(stop.run).toBe('scripts/stop-unused-revisions.sh "$RG" "$APP" "$LIVE"');
    expect(stop.env?.LIVE).toBe('${{ steps.api.outputs.live }}');
    expect(stop.env?.APP).toBe('${{ needs.candidate.outputs.app }}');
    expect(step(job('deploy-test'), 'api').run).toContain('echo "previous=$LIVE"');
  });

  it('rolls back through the script that starts a stopped previous revision before it moves users', () => {
    const rollback = workflow('rollback.yml').jobs.api?.steps ?? [];
    const move = rollback.find((s) => s.name === 'move users to the previous API revision');
    expect(move?.run).toContain('previous=$(scripts/rollback-api.sh "$RG" | tail -n 1)');
    expect(move?.run).toContain('[ -n "$previous" ] || {');
    expect((move as Step & { shell?: string })?.shell).toBe('bash');
    expect(rollback.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);
  });

  it.each(['candidate', 'deploy-test'])(
    'stops the worker before the %s deploy and starts its newest revision after it, whatever the deploy did',
    (name) => {
      const steps = job(name).steps ?? [];
      const deployAt = steps.findIndex((s) => s.id === 'deploy');
      const stopAt = steps.findIndex((s) => s.run === 'scripts/worker-revisions.sh "$RG" stop');
      const startAt = steps.findIndex(
        (s) => s.run === 'scripts/worker-revisions.sh "$RG" start "$DEPLOYMENT"',
      );
      expect(stopAt).toBe(deployAt - 1);
      expect(startAt).toBe(deployAt + 1);
      expect(steps[startAt]?.if).toMatch(/^always\(\)/);
      expect(steps[deployAt]?.run).toContain(
        `--name "${steps[startAt]?.env?.DEPLOYMENT ?? 'none'}"`,
      );
    },
  );

  it('stops and starts the worker the same way when infra applies the template, but not for a what-if', () => {
    const steps = workflow('infra.yml').jobs.apply?.steps ?? [];
    const stop = steps.find((s) => s.run === 'scripts/worker-revisions.sh "$RG" stop');
    const start = steps.find(
      (s) => s.run === 'scripts/worker-revisions.sh "$RG" start "$DEPLOYMENT"',
    );
    expect(start?.env?.DEPLOYMENT).toBe('infra-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(stop?.if).toBe('${{ !inputs.what-if }}');
    expect(start?.if).toBe('${{ always() && !inputs.what-if }}');
    expect(steps.indexOf(start as Step)).toBe(steps.length - 1);
  });
});

describe.skipIf(process.platform === 'win32')('stopping unused API revisions', () => {
  interface Route {
    revisionName: string;
    label?: string;
  }
  const stop = (traffic: Route[], active: string[], live: string, mode?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'revisions-'));
    const calls = join(dir, 'calls');
    writeFileSync(calls, '');
    const names = traffic.map((t) => t.revisionName).join(' ');
    const labels = traffic
      .filter((t) => t.label && t.revisionName !== live)
      .map((t) => t.label)
      .join(' ');
    writeFileSync(
      join(dir, 'az'),
      [
        '#!/usr/bin/env bash',
        'case "$2 $3" in',
        `  "ingress traffic") case "$*" in *.label*) printf '%s\n' ${labels} ;; *) printf '%s\n' ${names} ;; esac ;;`,
        `  "revision list") printf '%s\n' ${active.join(' ')} ;;`,
        '  "revision deactivate") echo "stop ${@: -1}" >> "$CALLS" ;;',
        '  "revision label") echo "unlabel $(printf \'%s\\n\' "$@" | grep -A1 -x -- --label | tail -1)" >> "$CALLS" ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(join(dir, 'az'), 0o755);
    execFileSync(
      join(root, 'scripts/stop-unused-revisions.sh'),
      ['rg', 'genai-test-api', live, ...(mode ? [mode] : [])],
      { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CALLS: calls } },
    );
    return readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  };
  const r3 = { revisionName: 'api--r3', label: 'live' };
  const r2 = { revisionName: 'api--r2', label: 'previous' };

  it('stops every active revision the traffic list does not name, and keeps live and previous', () => {
    expect(stop([r3, r2], ['api--r1', 'api--r2', 'api--r3'], 'api--r3')).toEqual(['stop api--r1']);
  });

  it('stops nothing while the traffic list does not yet name the live revision', () => {
    expect(stop([r2], ['api--r1', 'api--r2', 'api--r3'], 'api--r3')).toEqual([]);
  });

  it('before a candidate, takes the other labels off and stops every revision but the live one', () => {
    expect(stop([r3, r2], ['api--r1', 'api--r2', 'api--r3'], 'api--r3', 'all-but-live')).toEqual([
      'unlabel previous',
      'stop api--r1',
      'stop api--r2',
    ]);
  });
});

const hasJq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const posix = process.platform !== 'win32' && (hasJq || Boolean(process.env.CI));

describe('a deploy that takes minutes, not half an hour', () => {
  it('takes the result of ci.yml’s run on this commit from the merge queue or the push to main', () => {
    const ci = step(job('ci'), 'ci').run ?? '';
    expect(ci).toContain('actions/workflows/ci.yml/runs?head_sha=$SHA&per_page=20');
    expect(ci).toContain(
      'echo "passed=$([ "$state" = success ] || [ "$state" = queue ] && echo true || echo false)"',
    );
    expect(step(job('ci'), 'ci').env?.SHA).toBe('${{ github.sha }}');
    expect(job('ci').permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('runs the checks itself when ci has not passed on main', () => {
    const check = job('check');
    expect(check.if).toBe("needs.ci.outputs.passed != 'true'");
    expect(check.uses).toBe('./.github/workflows/ci.yml');
    const candidate = job('candidate');
    expect(candidate.needs).toEqual(['ci', 'check', 'build']);
    expect(candidate.if).toContain("needs.ci.result == 'success'");
    expect(candidate.if).toContain(
      "(needs.ci.outputs.passed == 'true' || needs.check.result == 'success')",
    );
  });

  it('runs the checks itself when GitHub does not answer', () => {
    expect(step(job('ci'), 'ci').run).toMatch(/end'\) \|\| state=failure/);
  });

  const sha = 'c'.repeat(40);
  const verdict = (runs: object[]) => {
    const filter = /--jq '([\s\S]*?)'\)/.exec(step(job('ci'), 'ci').run ?? '')?.[1] ?? '';
    return execFileSync('jq', ['-r', filter], {
      input: JSON.stringify({ workflow_runs: runs }),
      encoding: 'utf8',
      env: { ...process.env, SHA: sha },
    }).trim();
  };
  const push = {
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    path: '.github/workflows/ci.yml',
  };
  const queue = {
    event: 'merge_group',
    head_branch: `gh-readonly-queue/main/pr-1-${'b'.repeat(40)}`,
    head_sha: sha,
    path: '.github/workflows/ci.yml',
  };

  it.skipIf(!posix)('counts a push run on main of ci.yml as passed only when it succeeded', () => {
    expect(verdict([])).toBe('none');
    expect(verdict([{ ...push, status: 'in_progress', conclusion: null }])).toBe('running');
    expect(verdict([{ ...push, status: 'completed', conclusion: 'cancelled' }])).toBe('failure');
    expect(verdict([{ ...push, status: 'completed', conclusion: 'failure' }])).toBe('failure');
    expect(
      verdict([
        { ...push, status: 'completed', conclusion: 'failure' },
        { ...push, status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('success');
    expect(
      verdict([{ ...push, head_branch: 'feature', status: 'completed', conclusion: 'success' }]),
    ).toBe('none');
    expect(
      verdict([
        {
          ...push,
          path: '.github/workflows/other.yml',
          status: 'completed',
          conclusion: 'success',
        },
      ]),
    ).toBe('none');
  });

  it.skipIf(!posix)(
    'takes the merge queue’s run on the same commit, which runs every check in full',
    () => {
      expect(verdict([{ ...queue, status: 'completed', conclusion: 'success' }])).toBe('queue');
      const ci = parse(read('.github/workflows/ci.yml')) as Workflow;
      for (const name of ['scope', 'test'])
        for (const s of ci.jobs[name]?.steps ?? [])
          expect(s.env?.BASE ?? '').not.toContain('merge_group');
    },
  );

  it.skipIf(!posix)('never takes a run on another commit, branch or event as this commit’s', () => {
    const green = { status: 'completed', conclusion: 'success' };
    expect(verdict([{ ...queue, ...green, head_sha: 'd'.repeat(40) }])).toBe('none');
    expect(verdict([{ ...push, ...green, head_sha: 'd'.repeat(40) }])).toBe('none');
    expect(
      verdict([{ ...queue, ...green, head_branch: `gh-readonly-queue/feature/pr-1-${sha}` }]),
    ).toBe('none');
    expect(verdict([{ ...queue, ...green, event: 'pull_request', head_branch: 'feature' }])).toBe(
      'none',
    );
    expect(verdict([{ ...queue, status: 'completed', conclusion: 'failure' }])).toBe('none');
  });

  const ciLoop = (answers: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-'));
    writeFileSync(join(dir, 'answers'), answers.join('\n') + '\n');
    writeFileSync(
      join(dir, 'gh'),
      '#!/usr/bin/env bash\nhead -n 1 "$FAKE_ANSWERS"; sed -i.bak 1d "$FAKE_ANSWERS"\n',
    );
    writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(dir, 'gh'), 0o755);
    chmodSync(join(dir, 'sleep'), 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-c', step(job('ci'), 'ci').run ?? ''], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        FAKE_ANSWERS: join(dir, 'answers'),
        GITHUB_OUTPUT: output,
        REPO: 'digdir/genki',
        SHA: 'c'.repeat(40),
      },
      stdio: 'ignore',
    });
    return readFileSync(output, 'utf8').trim();
  };

  it.skipIf(!posix)('deploys at once on the merge queue’s green run', () => {
    expect(ciLoop(['queue'])).toBe('passed=true');
  });

  it.skipIf(!posix)('waits a minute for a push run that has not started yet', () => {
    expect(ciLoop(['none', 'none', 'running', 'success'])).toBe('passed=true');
  });

  it.skipIf(!posix)('runs the checks itself when no push run starts within a minute', () => {
    expect(ciLoop(Array.from({ length: 10 }, () => 'none'))).toBe('passed=false');
  });

  it('builds the images on every push to main, and when the deploy calls it', () => {
    expect(job('build').uses).toBe('./.github/workflows/images.yml');
    const images = workflow('images.yml');
    expect(Object.keys(images.on)).toEqual(['push', 'workflow_call']);
    expect(images.on.push).toEqual({ branches: ['main'] });
  });

  it('builds only the images it cannot reuse', () => {
    const steps = workflow('images.yml').jobs.build?.steps ?? [];
    for (const image of ['api', 'worker', 'apps', 'docling'])
      expect(steps.find((s) => s.id === image)?.if, image).toBe(
        `steps.have.outputs.${image} == ''`,
      );
  });

  it('signs a build attestation for every image it builds', () => {
    const images = workflow('images.yml').jobs.build;
    expect(images?.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(job('build').permissions).toEqual(images?.permissions);
    const steps = images?.steps ?? [];
    for (const image of ['api', 'worker', 'apps', 'docling']) {
      const at = steps.findIndex((s) => s.id === image);
      const attest = steps[at + 1];
      expect(attest?.uses, image).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
      expect(attest?.if, image).toBe(`steps.${image}.outputs.digest != ''`);
      expect(JSON.stringify(attest), image).toContain(`steps.${image}.outputs.digest`);
    }
  });

  it('names each attempt’s deployment apart, so a re-run never replaces the record of a full deploy', () => {
    expect(step(job('candidate'), 'deploy').run).toContain(
      '--name "genki-${{ github.run_id }}-${{ github.run_attempt }}-candidate"',
    );
    expect(step(job('deploy-test'), 'deploy').run).toContain(
      '--name "genki-${{ github.run_id }}-${{ github.run_attempt }}"',
    );
    expect(
      (workflow('infra.yml').jobs.apply?.steps ?? []).map((s) => s.run ?? '').join('\n'),
    ).toContain('--name "infra-${{ github.run_id }}-${{ github.run_attempt }}"');
  });

  it('decides in the candidate whether to apply the whole template', () => {
    const state = step(job('candidate'), 'infra');
    expect(state.run).toContain(
      'scripts/infra-state.sh infra/env/test.bicepparam "$RG" "$FORCE_INFRASTRUCTURE"',
    );
    expect(state.env?.FORCE_INFRASTRUCTURE).toBe('${{ inputs.infrastructure }}');
    expect(step(job('candidate'), 'deploy').run).toContain(
      'deployInfrastructure="${{ steps.infra.outputs.infrastructure }}" infraFingerprint="${{ steps.infra.outputs.fingerprint }}"',
    );
    expect(job('candidate').outputs?.infrastructure).toBe(
      '${{ steps.infra.outputs.infrastructure }}',
    );
  });

  it('forces the whole template on users’ deploy only when the candidate did not apply it', () => {
    const users = step(job('deploy-test'), 'deploy');
    expect(users.env?.FORCE_INFRASTRUCTURE).toBe(
      "${{ inputs.infrastructure && needs.candidate.outputs.infrastructure != 'true' }}",
    );
    expect(users.run).toContain(
      '--parameters deployInfrastructure="$infrastructure" infraFingerprint="$fingerprint"',
    );
  });

  it('records the fingerprint when infra runs alone', () => {
    const infra = workflow('infra.yml').jobs.apply?.steps ?? [];
    expect(infra.find((s) => s.id === 'fingerprint')?.run).toContain(
      'scripts/infra-state.sh "infra/env/$ENVIRONMENT.bicepparam" "$RG" true',
    );
    expect(infra.map((s) => s.run ?? '').join('\n')).toContain(
      'infraFingerprint="${{ steps.fingerprint.outputs.fingerprint }}"',
    );
  });

  it('gives the template every setting it reads from its variable, in every job that applies it', () => {
    const reads = [
      ...read('infra/env/test.bicepparam').matchAll(/readEnvironmentVariable\('([A-Z_]+)'/g),
    ].map((m) => m[1] ?? '');
    expect(reads.length).toBeGreaterThan(20);
    const passed = {
      candidate: job('candidate').env ?? {},
      'deploy-test': step(job('deploy-test'), 'deploy').env ?? {},
      infra: workflow('infra.yml').jobs.apply?.env ?? {},
    };
    for (const [name, env] of Object.entries(passed))
      for (const variable of reads)
        expect(env[variable], `${name} ${variable}`).toBe(`\${{ vars.${variable} }}`);
  });

  it('gives users the new API only through the gate, also when the checks were not run again', () => {
    expect(job('gate').if).toContain("needs.candidate.result == 'success'");
    expect(job('deploy-test').if).toContain(
      "(needs.gate.result == 'success' || (needs.gate.result == 'skipped' && needs.candidate.outputs.url == ''))",
    );
    // A job without a status function is skipped when one before it was.
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

  it('gives up on a health call after ten seconds, so a hanging one cannot stall the polling', () => {
    const polls = Object.values(deploy.jobs)
      .flatMap((j) => j.steps ?? [])
      .map((s) => s.run ?? '')
      .filter((run) => run.includes('/health"'));
    for (const run of polls) expect(run).toContain('curl -fsS --max-time 10 ');
  });

  it('lets SMOKE_LANES set how many model checks the gate and the smoke test run at once', () => {
    expect(step(job('gate'), 'run').env?.SMOKE_LANES).toBe('${{ vars.SMOKE_LANES }}');
    expect(read('.github/workflows/smoke.yml')).toContain('SMOKE_LANES: ${{ vars.SMOKE_LANES }}');
  });
});

describe.skipIf(!posix)('the candidate’s plan of the running apps', () => {
  const helpers = (step(job('candidate'), 'plan').run ?? '')
    .split('\n')
    .filter((line) => /^\s*(field|version_of|image_of)\(\)/.test(line))
    .join('\n');
  const listed = [
    {
      name: 'genai-test-api',
      properties: {
        latestReadyRevisionName: 'genai-test-api--r2',
        template: {
          revisionSuffix: 'r2',
          containers: [{ image: 'api@sha256:a', env: [{ name: 'APP_VERSION', value: 'abc' }] }],
        },
        configuration: {
          ingress: {
            traffic: [
              { revisionName: 'genai-test-api--r2', weight: 100, label: 'live' },
              { revisionName: 'genai-test-api--r1', weight: 0, label: 'previous' },
            ],
          },
        },
      },
    },
    {
      name: 'genai-test-worker',
      properties: {
        template: {
          containers: [{ image: 'worker@sha256:w', env: [{ name: 'APP_VERSION', value: 'def' }] }],
        },
        configuration: { ingress: null },
      },
    },
  ];
  const plan = (expression: string, apps: object[] = listed) => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-'));
    writeFileSync(join(dir, 'apps.json'), JSON.stringify(apps));
    return execFileSync('bash', ['-c', `placeholder=none\n${helpers}\n${expression}`], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  };

  it('finds the API app by its name', () => {
    expect(helpers.split('\n')).toHaveLength(3);
    expect(plan('field api .name')).toBe('genai-test-api');
  });

  it('takes the live revision from the one with all traffic', () => {
    expect(
      plan(
        `field api '.properties.configuration.ingress.traffic[]? | select(.weight == 100) | .revisionName'`,
      ),
    ).toBe('genai-test-api--r2');
  });

  it('takes the previous revision from its label', () => {
    expect(
      plan(
        `field api '.properties.configuration.ingress.traffic[]? | select(.label == "previous") | .revisionName'`,
      ),
    ).toBe('genai-test-api--r1');
  });

  it('reads each app’s version and image', () => {
    expect(plan('version_of worker')).toBe('def');
    expect(plan('image_of api')).toBe('api@sha256:a');
  });

  it('gives the placeholder image and nothing else for an app that does not exist', () => {
    expect(plan('image_of docling')).toBe('none');
    expect(plan('field api .name', [])).toBe('');
  });
});

describe.skipIf(!posix)('reusing an image', () => {
  const sha = 'c'.repeat(40);
  const have = (
    tags: Record<string, string>,
    attested: string[],
    subjects: Record<string, string> = {},
  ) => {
    const script =
      workflow('images.yml').jobs.build?.steps?.find((s) => s.id === 'have')?.run ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'have-'));
    writeFileSync(
      join(dir, 'docker'),
      `#!/usr/bin/env bash
tag="\${4#reg.example/}"
digest=$(jq -r --arg tag "$tag" '.[$tag] // empty' <<< "$FAKE_TAGS")
[ -n "$digest" ] || exit 1
printf '{"digest":"%s"}\\n' "$digest"
`,
    );
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_ASKED"
ref="\${3#oci://}"
digest="\${ref##*@}"
if ! grep -qx "$digest" <<< "$FAKE_ATTESTED"; then echo "Error: no attestations found for $digest" >&2; exit 1; fi
name=$(jq -r --arg d "$digest" --arg n "\${ref%@*}" '.[$d] // $n' <<< "$FAKE_SUBJECTS")
printf '[{"verificationResult":{"statement":{"subject":[{"name":"%s"}]}}}]\\n' "$name"
`,
    );
    chmodSync(join(dir, 'docker'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    const output = join(dir, 'output');
    const askedFile = join(dir, 'asked');
    writeFileSync(output, '');
    writeFileSync(askedFile, '');
    const log = execFileSync('bash', ['-e', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        SERVER: 'reg.example',
        SHA: sha,
        REPO: 'digdir/genki',
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: dir,
        FAKE_TAGS: JSON.stringify(tags),
        FAKE_ATTESTED: attested.join('\n'),
        FAKE_SUBJECTS: JSON.stringify(subjects),
        FAKE_ASKED: askedFile,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const values = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=') as [string, string]),
    );
    return { values, log, asked: readFileSync(askedFile, 'utf8') };
  };

  it('builds again an image whose build attestation is for another image', () => {
    const { values } = have({ [`genai-api:${sha}`]: 'sha256:w' }, ['sha256:w'], {
      'sha256:w': 'reg.example/genai-worker',
    });
    expect(values.api).toBe('');
  });

  it('says why an attestation did not verify', () => {
    const { log } = have({ [`genai-api:${sha}`]: 'sha256:planted' }, []);
    expect(log).toContain('::warning::genai-api');
    expect(log).toContain('no attestations found for sha256:planted');
  });

  it('reuses an image whose build attestation verifies', () => {
    const { values } = have({ [`genai-api:${sha}`]: 'sha256:a' }, ['sha256:a']);
    expect(values.api).toBe('sha256:a');
  });

  it('builds again an image whose build attestation does not verify', () => {
    const { values } = have({ [`genai-api:${sha}`]: 'sha256:planted' }, []);
    expect(values.api).toBe('');
  });

  it('builds an image that is not in the registry', () => {
    expect(have({}, []).values.worker).toBe('');
  });

  it('accepts only an attestation from images.yml on main, for this commit', () => {
    const { asked } = have({ [`genai-api:${sha}`]: 'sha256:a' }, ['sha256:a']);
    expect(asked).toContain('attestation verify oci://reg.example/genai-api@sha256:a');
    expect(asked).toContain('--repo digdir/genki');
    expect(asked).toContain('--signer-workflow digdir/genki/.github/workflows/images.yml');
    expect(asked).toContain('--source-ref refs/heads/main');
    expect(asked).toContain('--deny-self-hosted-runners');
    expect(asked).toContain(`--source-digest ${sha}`);
  });

  it('tags the Docling image by the tree of docker/docling and the week, so it is rebuilt weekly', () => {
    expect(have({}, []).values.docling_tag).toMatch(/^tree-[0-9a-f]{40}-\d{4}-W\d{2}$/);
  });
});

describe('the rollback workflow', () => {
  const rollback = workflow('rollback.yml');

  it('swaps the live and previous API revisions in one run, never during a deploy', () => {
    expect(Object.keys(rollback.on)).toEqual(['workflow_dispatch']);
    expect(rollback.concurrency?.group).toBe('deploy-test');
    const run = rollback.jobs.api?.steps?.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('scripts/rollback-api.sh "$RG"');
    expect(read('scripts/rollback-api.sh')).toContain(
      'az containerapp revision label swap -g "$group" -n "$app" --source previous --target live',
    );
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
      'budget-infra',
      'budget-models',
      'files-backup',
      'platform-backup',
      'dns',
      'assistant-host-infra',
    ];
    expect(Object.keys(conditions).sort()).toEqual(
      [...infrastructure, 'containerapps', 'assistant-host'].sort(),
    );
    for (const name of infrastructure)
      expect(conditions[name], name).toContain("variables('infra')");
    expect(conditions.containerapps).toBe('');
    expect(conditions['assistant-host']).toBe("[parameters('assistantHostEnabled')]");
  });

  it('reads no infrastructure module’s outputs unless it deploys the infrastructure', () => {
    // Azure evaluates the references of a module it does not deploy, and the record of an old one can be gone.
    const reads = expressions.filter((e) =>
      Object.keys(conditions)
        .filter((name) => name !== 'containerapps' && name !== 'assistant-host')
        .some((name) => e.includes(`resourceId('Microsoft.Resources/deployments', '${name}')`)),
    );
    expect(reads.length).toBeGreaterThan(10);
    for (const e of reads) expect(e).toContain("variables('infra')");
  });

  it('reads the existing registry, vault, storage and servers only when it skips the infrastructure', () => {
    const types = [
      'Microsoft.ContainerRegistry/registries',
      'Microsoft.KeyVault/vaults',
      'Microsoft.Storage/storageAccounts',
      'Microsoft.DBforPostgreSQL/flexibleServers',
    ];
    const reads = expressions.filter((e) =>
      types.some((type) => e.includes(`reference(resourceId('${type}', variables(`)),
    );
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const e of reads) expect(e).toContain("variables('infra')");
  });

  it('runs several revisions of the API once a live revision is named, and of the worker only where the parameters ask', () => {
    const modes = Object.fromEntries(
      resources.map((r) => [r.name, r.properties.configuration.activeRevisionsMode]),
    );
    expect(modes["[format('{0}-api', parameters('name'))]"]).toBe(
      "[if(empty(parameters('apiLiveRevision')), 'Single', 'Multiple')]",
    );
    expect(modes["[format('{0}-worker', parameters('name'))]"]).toBe(
      "[parameters('workerRevisionsMode')]",
    );
    const others = Object.entries(modes).filter(
      ([name]) => !name.includes("'{0}-api'") && !name.includes("'{0}-worker'"),
    );
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
