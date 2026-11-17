import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/infra-state.sh with a fake `az`: build-params answers with the template and settings in FAKE_PARAMS, and
// the deployment list with the fingerprint in FAKE_LAST, after writing the query it was asked to a file.
const script = join(import.meta.dirname, 'infra-state.sh');
const dir = mkdtempSync(join(tmpdir(), 'infra-state-'));
writeFileSync(
  join(dir, 'az'),
  `#!/usr/bin/env bash
if [ "$1 $2" = "bicep build-params" ]; then printf '%s' "$FAKE_PARAMS"; exit 0; fi
if [ "$1 $2 $3" = "deployment group list" ]; then printf '%s\\n' "$*" > "$FAKE_ASKED"; printf '%s\\n' "$FAKE_LAST"; exit 0; fi
exit 1
`,
);
chmodSync(join(dir, 'az'), 0o755);

const built = (settings: object, generator = '0.49.2') =>
  JSON.stringify({
    parametersJson: JSON.stringify({ parameters: settings }),
    templateJson: JSON.stringify({
      metadata: { _generator: { name: 'bicep', version: generator } },
      resources: [],
    }),
  });

const state = (params: string, last: string, force?: string) => {
  const asked = join(dir, 'asked');
  const out = execFileSync(
    script,
    ['infra/env/test.bicepparam', 'rg-test', ...(force ? [force] : [])],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        FAKE_PARAMS: params,
        FAKE_LAST: last,
        FAKE_ASKED: asked,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1];
  return {
    fingerprint: value('fingerprint') ?? '',
    infrastructure: value('infrastructure'),
    asked: readFileSync(asked, 'utf8'),
  };
};

describe('whether a deploy applies the infrastructure', () => {
  const settings = built({ minReplicas: { value: 1 } });
  const fingerprint = state(settings, '').fingerprint;

  it('applies it when no full deploy is recorded', () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state(settings, '').infrastructure).toBe('true');
  });

  it('skips it when the last full deploy applied the same template and settings', () => {
    expect(state(settings, fingerprint).infrastructure).toBe('false');
  });

  it('applies it when a setting or the template changed since', () => {
    const changed = built({ minReplicas: { value: 2 } });
    expect(state(changed, fingerprint).infrastructure).toBe('true');
  });

  it('applies it when asked to, even when nothing changed', () => {
    expect(state(settings, fingerprint, 'true').infrastructure).toBe('true');
  });

  it('keeps the fingerprint when only the Bicep version changed', () => {
    expect(state(built({ minReplicas: { value: 1 } }, '0.50.0'), '').fingerprint).toBe(fingerprint);
  });

  it('compares with the last full deploy that succeeded, never a deploy of the apps alone', () => {
    const asked = state(settings, fingerprint).asked;
    expect(asked).toContain("properties.provisioningState=='Succeeded'");
    expect(asked).toContain('properties.outputs.infrastructureDeployed.value != `false`');
    expect(asked).toContain('sort_by(@, &properties.timestamp) | [-1]');
    expect(asked).toContain('-g rg-test');
  });
});
