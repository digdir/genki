import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  confirmedFindings,
  hasEvidence,
  mergeCandidates,
  open,
  publicKeys,
  report,
  runRecord,
  seal,
  structuredOutput,
  unfinishedSteps,
  type Candidate,
  type Finding,
} from './security-sweep.ts';

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'Route skips the tenant check',
  rule: 'let one tenant read or change',
  path: 'apps/api/src/a.ts',
  line: 40,
  problem: 'The second route reads rows of any tenant.',
  evidence: 'apps/api/src/a.ts:40 reads without the tenant',
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  ...candidate(),
  severity: 'Important',
  abuser: 'a person in one organisation',
  reach: "another organisation's runs",
  fix: 'Check the tenant on the route.',
  ...over,
});

const rsa = (bits = 3072) =>
  generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

describe('candidates from the passes', () => {
  it('drops a candidate without a file and line in its evidence', () => {
    expect(hasEvidence(candidate())).toBe(true);
    expect(hasEvidence(candidate({ evidence: 'the name suggests it is unchecked' }))).toBe(false);
    expect(hasEvidence(candidate({ line: 0 }))).toBe(false);
    expect(hasEvidence(candidate({ path: ' ' }))).toBe(false);
  });

  it('checks evidence in linear time on a long adversarial string', () => {
    const started = performance.now();
    hasEvidence(candidate({ evidence: `${'a.'.repeat(200_000)}a` }));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('merges the same problem found by two passes into one, keeping the fuller evidence', () => {
    const merged = mergeCandidates({
      tenancy: { candidates: [candidate()] },
      rights: {
        candidates: [
          candidate({
            start_line: 38,
            line: 41,
            evidence: 'apps/api/src/a.ts:40 reads without the tenant, and b.ts:12 calls it',
          }),
          candidate({ path: 'apps/api/src/b.ts', line: 7, evidence: 'apps/api/src/b.ts:7' }),
        ],
      },
      secrets: null,
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      passes: ['tenancy', 'rights'],
      evidence: 'apps/api/src/a.ts:40 reads without the tenant, and b.ts:12 calls it',
    });
    expect(merged[1]?.passes).toEqual(['rights']);
  });

  it('keeps going when a pass returned nothing', () => {
    expect(mergeCandidates({ tenancy: null, rights: {}, secrets: { candidates: [] } })).toEqual([]);
  });
});

describe('confirmed findings', () => {
  it('drops a finding that does not say who could abuse it or how far it reaches', () => {
    const kept = confirmedFindings({
      findings: [finding(), finding({ abuser: '' }), finding({ reach: ' ' })],
    });
    expect(kept).toHaveLength(1);
  });

  it('drops a finding without file and line evidence, also after the coordinator', () => {
    expect(confirmedFindings({ findings: [finding({ evidence: 'trust me' })] })).toEqual([]);
  });

  it('lists Important findings first', () => {
    const kept = confirmedFindings({
      findings: [finding({ severity: 'Nit', title: 'n' }), finding({ title: 'i' })],
    });
    expect(kept.map((f) => f.title)).toEqual(['i', 'n']);
  });

  it('says the report may miss findings when a pass or the coordinator did not finish', () => {
    expect(
      unfinishedSteps('tenancy=success rights=failure secrets=skipped coordinate=skipped'),
    ).toEqual(['rights', 'secrets']);
    const text = report([], { sha: 'a'.repeat(40), runUrl: 'u', unfinished: ['rights'] });
    expect(text).toContain('rights did not finish');
    expect(text).toContain('No confirmed findings.');
  });

  it('writes who could abuse each finding and how far it reaches into the report', () => {
    const text = report([finding()], { sha: 'abc', runUrl: 'u', unfinished: [] });
    expect(text).toContain('**Who could abuse it:** a person in one organisation');
    expect(text).toContain("**How far it reaches:** another organisation's runs");
    expect(text).toContain('`apps/api/src/a.ts:40`');
  });
});

describe('sealing the findings', () => {
  const alice = rsa();
  const bob = rsa();

  it('can be opened by every maintainer key it was sealed to, and by no other key', () => {
    const sealed = seal('secret report', publicKeys(`${alice.publicKey}\n${bob.publicKey}`));
    expect(open(sealed, alice.privateKey)).toBe('secret report');
    expect(open(sealed, bob.privateKey)).toBe('secret report');
    expect(() => open(sealed, rsa().privateKey)).toThrow('not one the findings were sealed to');
    expect(JSON.stringify(sealed)).not.toContain('secret report');
  });

  it('refuses a sealed report that was changed', () => {
    const sealed = seal('secret report', publicKeys(alice.publicKey));
    const data = Buffer.from(sealed.data, 'base64');
    data[0] = (data[0] ?? 0) ^ 1;
    expect(() => open({ ...sealed, data: data.toString('base64') }, alice.privateKey)).toThrow();
  });

  it('refuses to start without a public key, or with a weak one', () => {
    expect(() => publicKeys('')).toThrow('no public key');
    expect(() => publicKeys(rsa(2048).publicKey)).toThrow('at least 3072 bits');
  });
});

describe('the run record', () => {
  it('adds up cost, time and turns over every model step and holds no findings', () => {
    const record = runRecord({
      repo: 'digdir/genki',
      sha: 'abc',
      runId: '1',
      model: 'claude-opus-5-5',
      startedAt: '2026-11-16T03:17:00Z',
      executions: [
        [{ type: 'result', total_cost_usd: 2.5, duration_ms: 60_000, num_turns: 30 }],
        [{ type: 'result', total_cost_usd: 1.25, duration_ms: 30_000, num_turns: 10 }],
        [],
      ],
    });
    expect(record).toMatchObject({
      schema: 'digdir.security-sweep.run/v1',
      steps: 3,
      steps_completed: 2,
      cost_usd: 3.75,
      duration_s: 90,
      turns: 40,
    });
    expect(Object.keys(record)).not.toContain('findings');
  });
});

const execution = (output: unknown, over: Record<string, unknown> = {}) => [
  { type: 'system', subtype: 'init' },
  { type: 'result', subtype: 'success', is_error: false, structured_output: output, ...over },
];

describe('reading what the model returned', () => {
  it('takes the structured output from the result message of the execution file', () => {
    expect(structuredOutput(execution({ candidates: [candidate()] }))).toEqual({
      candidates: [candidate()],
    });
  });

  it('takes nothing from a run that failed or never reached a result', () => {
    expect(structuredOutput(execution({ candidates: [] }, { is_error: true }))).toBeNull();
    expect(
      structuredOutput(execution({ candidates: [] }, { subtype: 'error_max_turns' })),
    ).toBeNull();
    expect(structuredOutput([{ type: 'system', subtype: 'init' }])).toBeNull();
    expect(structuredOutput(null)).toBeNull();
  });
});

describe('the sweep commands in the workflow', () => {
  const script = join(import.meta.dirname, 'security-sweep.ts');
  const secret = 'sk-leaked-token-in-evidence';
  const run = (command: string, cwd: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [script, command], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: cwd, ...env },
    });

  it('merge reads the passes from their execution files and prints only the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    const found = candidate({ evidence: `apps/api/src/a.ts:40 logs ${secret}` });
    writeFileSync(
      join(dir, 'sweep-tenancy.json'),
      JSON.stringify(execution({ candidates: [found] })),
    );
    writeFileSync(
      join(dir, 'sweep-secrets.json'),
      JSON.stringify(execution({ candidates: [found] })),
    );
    const merge = run('merge', dir, {});
    expect(merge.status, merge.stderr).toBe(0);
    expect(merge.stdout).toBe('count=1\n');
    expect(merge.stderr).not.toContain(secret);
    expect(readFileSync(join(dir, '.sweep/candidates.json'), 'utf8')).toContain(secret);
  });

  it('seal reads the findings from the coordinator execution file and prints none of them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    const coordinator = join(dir, 'claude-execution-output.json');
    writeFileSync(
      coordinator,
      JSON.stringify(
        execution({ findings: [finding({ evidence: `apps/api/src/a.ts:40 logs ${secret}` })] }),
      ),
    );
    const key = rsa();
    const sealed = run('seal', dir, {
      COORDINATE_EXECUTION: coordinator,
      SWEEP_PUBLIC_KEYS: key.publicKey,
      SHA: 'a'.repeat(40),
      OUTCOMES: 'tenancy=success rights=success secrets=success coordinate=success',
    });
    expect(sealed.status, sealed.stderr).toBe(0);
    expect(`${sealed.stdout}${sealed.stderr}`).not.toContain(secret);
    const file = readFileSync(join(dir, 'security-sweep.sealed.json'), 'utf8');
    expect(file).not.toContain(secret);
    expect(open(JSON.parse(file), key.privateKey)).toContain(secret);
    expect(readFileSync(join(dir, 'security-sweep-run.json'), 'utf8')).not.toContain(secret);
  });
});
