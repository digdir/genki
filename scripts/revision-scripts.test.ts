import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

const fakeAz = (body: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'az-'));
  const calls = join(dir, 'calls');
  const active = join(dir, 'active');
  writeFileSync(calls, '');
  writeFileSync(
    join(dir, 'az'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'args="$*"',
      'revision() { local next=""; for a in "$@"; do [ "$next" = 1 ] && { echo "$a"; return; }; [ "$a" = --revision ] && next=1; done; }',
      'case "$args" in',
      '  *"revision deactivate"*) r=$(revision "$@"); grep -vx "$r" "$ACTIVE" > "$ACTIVE.new" || true; mv "$ACTIVE.new" "$ACTIVE"; echo "stop $r" >> "$CALLS" ;;',
      '  *"revision activate"*) r=$(revision "$@"); echo "$r" >> "$ACTIVE"; echo "start $r" >> "$CALLS" ;;',
      `  *"revision list"*"properties.active"*) cat "$ACTIVE" ;;`,
      '  *properties.active*) if grep -qx "$(revision "$@")" "$ACTIVE"; then echo true; else echo false; fi ;;',
      '  *runningState*) r=$(revision "$@"); if grep -qx "$r" "$ACTIVE" && ! grep -qx "$r" <<< "${BROKEN:-}"; then echo Running; else echo ActivationFailed; fi ;;',
      ...body,
      'esac',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(dir, 'az'), 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
  return {
    dir,
    calls,
    active,
    read: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    running: () => readFileSync(active, 'utf8').split('\n').filter(Boolean),
  };
};

const run = (script: string, args: string[], dir: string, env: Record<string, string>) =>
  execFileSync(join(root, 'scripts', script), args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe.skipIf(process.platform === 'win32')('the worker around a deploy', () => {
  const worker = (state: {
    mode?: string;
    active: string[];
    latest: string;
    ready?: string;
    broken?: string;
    deployment?: string[];
  }) => {
    const az = fakeAz([
      '  *"containerapp list"*) echo genai-test-worker ;;',
      '  *activeRevisionsMode*) echo "$MODE" ;;',
      '  *latestReadyRevisionName*) echo "$READY" ;;',
      '  *latestRevisionName*) echo "$LATEST" ;;',
      '  *"deployment group show"*) head -n 1 "$DEPLOYMENT_STATES"; if [ "$(wc -l < "$DEPLOYMENT_STATES")" -gt 1 ]; then sed -i.bak 1d "$DEPLOYMENT_STATES"; fi ;;',
      '  *"deployment group cancel"*) echo "cancel ${@: -1}" >> "$CALLS" ;;',
    ]);
    writeFileSync(az.active, state.active.map((r) => `${r}\n`).join(''));
    const states = join(az.dir, 'deployment');
    writeFileSync(states, (state.deployment ?? ['Succeeded']).join('\n') + '\n');
    const env = {
      CALLS: az.calls,
      ACTIVE: az.active,
      MODE: state.mode ?? 'Multiple',
      LATEST: state.latest,
      READY: state.ready ?? state.latest,
      BROKEN: state.broken ?? '',
      DEPLOYMENT_STATES: states,
    };
    return {
      az,
      stop: () => (run('worker-revisions.sh', ['rg', 'stop'], az.dir, env), az),
      start: () => (run('worker-revisions.sh', ['rg', 'start', 'genki-1-1'], az.dir, env), az),
    };
  };

  it('stops every running worker revision before the deploy, so the old and new worker never run together', () => {
    expect(
      worker({ active: ['w--1'], latest: 'w--1' })
        .stop()
        .running(),
    ).toEqual([]);
  });

  it('starts the stopped worker again when the deploy made no new revision', () => {
    const az = worker({ active: [], latest: 'w--1' }).start();
    expect(az.running()).toEqual(['w--1']);
  });

  it('leaves exactly the newest running revision active', () => {
    const az = worker({ active: ['w--1', 'w--2'], latest: 'w--3', ready: 'w--3' }).start();
    expect(az.running()).toEqual(['w--3']);
  });

  it('cancels the deploy a cancelled run left running in Azure before it settles on one worker', () => {
    const az = worker({
      active: ['w--1'],
      latest: 'w--1',
      deployment: ['Running', 'Running', 'Canceled'],
    }).start();
    expect(az.read()[0]).toBe('cancel genki-1-1');
    expect(az.running()).toEqual(['w--1']);
  });

  it('fails and leaves the last good worker running when the new revision does not run', () => {
    const w = worker({ active: [], latest: 'w--2', ready: 'w--1', broken: 'w--2' });
    expect(() => w.start()).toThrow();
    expect(w.az.running()).toEqual(['w--1']);
  });

  it('leaves a worker in single revision mode to Azure', () => {
    const single = worker({ mode: 'Single', active: ['w--1'], latest: 'w--2' });
    expect(single.stop().read()).toEqual([]);
    expect(single.start().read()).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('rolling the API back', () => {
  const rollback = (state: {
    live: string;
    labelled: string;
    active: string[];
    reachedUsers: string[];
  }) => {
    const az = fakeAz([
      '  *"containerapp list"*) echo genai-test-api ;;',
      '  *"weight=="*) echo "$LIVE" ;;',
      `  *"label=='previous'"*) echo "$LABELLED" ;;`,
      `  *"revision list"*) printf '%s\\n' api--r1 api--r2 api--r3 api--r4 ;;`,
      `  *"deployment group list"*) printf '%s\\n' $REACHED ;;`,
      '  *"label add"*) echo "label previous on $(revision "$@")" >> "$CALLS" ;;',
      '  *"label swap"*) echo "swap previous and live" >> "$CALLS" ;;',
    ]);
    writeFileSync(az.active, state.active.map((name) => `${name}\n`).join(''));
    const env = {
      CALLS: az.calls,
      ACTIVE: az.active,
      LIVE: state.live,
      LABELLED: state.labelled,
      REACHED: state.reachedUsers.join(' '),
    };
    const output = run('rollback-api.sh', ['rg'], az.dir, env);
    return { previous: output.trim().split('\n').at(-1), calls: az.read() };
  };

  it('moves users to the running revision labelled previous', () => {
    expect(
      rollback({
        live: 'api--r3',
        labelled: 'api--r2',
        active: ['api--r2', 'api--r3'],
        reachedUsers: [],
      }),
    ).toEqual({ previous: 'api--r2', calls: ['swap previous and live'] });
  });

  it('starts the revision labelled previous first when it is stopped', () => {
    expect(
      rollback({ live: 'api--r3', labelled: 'api--r2', active: ['api--r3'], reachedUsers: [] }),
    ).toEqual({ previous: 'api--r2', calls: ['start api--r2', 'swap previous and live'] });
  });

  it('after a failed gate, starts the newest revision a deploy gave users, never a candidate that failed its gate', () => {
    expect(
      rollback({
        live: 'api--r3',
        labelled: '',
        active: ['api--r3'],
        reachedUsers: ['api--r3', 'api--r1'],
      }),
    ).toEqual({
      previous: 'api--r1',
      calls: ['start api--r1', 'label previous on api--r1', 'swap previous and live'],
    });
  });

  it('refuses when no other revision ever reached users', () => {
    expect(() =>
      rollback({ live: 'api--r3', labelled: '', active: ['api--r3'], reachedUsers: ['api--r3'] }),
    ).toThrow();
  });
});
