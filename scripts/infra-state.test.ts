import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// A fake `az` answers build-params with FAKE_PARAMS and the deployment list with FAKE_NEWEST.
const script = join(import.meta.dirname, 'infra-state.sh');
const hasJq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const built = (settings: object, generator = '0.49.2', resources: object[] = []) => {
  const stamp = { _generator: { name: 'bicep', version: generator } };
  return JSON.stringify({
    parametersJson: JSON.stringify({ parameters: settings }),
    templateJson: JSON.stringify({
      metadata: stamp,
      resources: [{ name: 'module', properties: { template: { metadata: stamp } } }, ...resources],
    }),
  });
};
const newest = (state: string, fingerprint: string | null) =>
  JSON.stringify({ state, fingerprint });

describe.skipIf(process.platform === 'win32' || (!hasJq && !process.env.CI))(
  'whether a deploy applies the infrastructure',
  () => {
    let dir = '';
    let fingerprint = '';
    const settings = built({ minReplicas: { value: 1 } });
    const state = (params: string, found: string, force?: string) => {
      const out = execFileSync(
        script,
        ['infra/env/test.bicepparam', 'rg-test', ...(force ? [force] : [])],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            FAKE_PARAMS: params,
            FAKE_NEWEST: found,
            FAKE_ASKED: join(dir, 'asked'),
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1];
      return { fingerprint: value('fingerprint') ?? '', infrastructure: value('infrastructure') };
    };

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'infra-state-'));
      writeFileSync(
        join(dir, 'az'),
        `#!/usr/bin/env bash
if [ "$1 $2" = "bicep build-params" ]; then printf '%s' "$FAKE_PARAMS"; exit 0; fi
if [ "$1 $2 $3" = "deployment group list" ]; then printf '%s\\n' "$*" > "$FAKE_ASKED"; printf '%s\\n' "$FAKE_NEWEST"; exit 0; fi
exit 1
`,
      );
      chmodSync(join(dir, 'az'), 0o755);
      fingerprint = state(settings, 'null').fingerprint;
    });

    it('applies it when no full deploy is recorded', () => {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(state(settings, 'null').infrastructure).toBe('true');
    });

    it('skips it when the newest full deploy succeeded with the same template and settings', () => {
      expect(state(settings, newest('Succeeded', fingerprint)).infrastructure).toBe('false');
    });

    it('applies it when the newest full deploy failed, even with the same fingerprint', () => {
      expect(state(settings, newest('Failed', fingerprint)).infrastructure).toBe('true');
    });

    it('applies it when the newest full deploy has no fingerprint', () => {
      expect(state(settings, newest('Succeeded', null)).infrastructure).toBe('true');
    });

    it('applies it when a setting changed', () => {
      const changed = built({ minReplicas: { value: 2 } });
      expect(state(changed, newest('Succeeded', fingerprint)).infrastructure).toBe('true');
    });

    it('applies it when only the template changed', () => {
      const changed = built({ minReplicas: { value: 1 } }, '0.49.2', [{ name: 'added' }]);
      expect(state(changed, newest('Succeeded', fingerprint)).infrastructure).toBe('true');
    });

    it('applies it when asked to, even when nothing changed', () => {
      expect(state(settings, newest('Succeeded', fingerprint), 'true').infrastructure).toBe('true');
    });

    it('keeps the fingerprint when only the Bicep version changed, in every module', () => {
      expect(state(built({ minReplicas: { value: 1 } }, '0.50.0'), 'null').fingerprint).toBe(
        fingerprint,
      );
    });

    it('reads the newest full deploy of main.bicep, failed or not, never a deploy of the apps alone', () => {
      state(settings, 'null');
      const asked = readFileSync(join(dir, 'asked'), 'utf8');
      expect(asked).toContain('properties.parameters.postgresAdminGroupObjectId != null');
      expect(asked).toContain('properties.parameters.deployInfrastructure.value != `false`');
      expect(asked).not.toContain('provisioningState==');
      expect(asked).toContain('sort_by(@, &properties.timestamp) | [-1]');
      expect(asked).toContain('-g rg-test');
    });
  },
);
