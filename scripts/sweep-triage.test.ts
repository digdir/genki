import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { report, seal, publicKeys, type Finding } from './security-sweep.ts';
import {
  decision,
  fetchAndTriage,
  fingerprint,
  ghEnv,
  insideWorkTree,
  normalizeTitle,
  parseReport,
  readLedger,
  recordDecision,
  triage,
  type Advisory,
  type Deps,
  type Ledger,
} from './sweep-triage.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

const invented = (over: Partial<Finding> = {}): Finding => ({
  severity: 'Important',
  title: 'Invented example: route skips the tenant check',
  rule: 'let one tenant read or change',
  path: 'apps/api/src/example.ts',
  line: 40,
  problem: 'An invented problem for the test.',
  evidence: 'apps/api/src/example.ts:40 invented',
  abuser: 'a person in one organisation',
  reach: 'invented reach',
  fix: 'Invented fix.',
  ...over,
});

const markdown = (findings: Finding[]) =>
  report(
    { confirmed: findings },
    { sha: 'a'.repeat(40), runUrl: 'https://example.test/run', unfinished: [] },
  );

const one = () => {
  const [found] = parseReport(markdown([invented()]));
  if (!found) throw new Error('no finding in the report');
  return found;
};

const emptyLedger = (): Ledger => ({ schema: 'digdir.security-sweep.ledger/v1', findings: {} });

const advisory = (over: Partial<Advisory> = {}): Advisory => ({
  ghsa_id: 'GHSA-2222-3333-4444',
  summary: 'Something else',
  description: '',
  state: 'draft',
  ...over,
});

const rsa = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

describe('fingerprints', () => {
  it('a finding with the same rule, file and title after a line shift has the same fingerprint', () => {
    const before = parseReport(
      markdown([invented({ line: 40, title: 'Unchecked tenant at line 40' })]),
    );
    const after = parseReport(
      markdown([invented({ line: 52, title: 'Unchecked tenant at line 52' })]),
    );
    expect(before[0]?.fingerprint).toBe(after[0]?.fingerprint);
  });

  it('a finding in another file or under another rule has another fingerprint', () => {
    const base = { rule: 'rule a', path: 'a.ts', title: 'Title' };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, path: 'b.ts' }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, rule: 'rule b' }));
  });

  it('normalizes titles in linear time on a long adversarial string', () => {
    const started = performance.now();
    normalizeTitle(`${'line :1-'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('reading the report', () => {
  it('reads every finding with its severity, place and rule from the opened report', () => {
    const found = parseReport(
      markdown([invented(), invented({ severity: 'Nit', path: 'b.ts', line: 3, start_line: 1 })]),
    );
    expect(found.map(({ severity, path, line, rule }) => ({ severity, path, line, rule }))).toEqual(
      [
        {
          severity: 'Important',
          path: 'apps/api/src/example.ts',
          line: '40',
          rule: 'let one tenant read or change',
        },
        { severity: 'Nit', path: 'b.ts', line: '1-3', rule: 'let one tenant read or change' },
      ],
    );
    expect(found[0]?.text).toContain('Invented fix.');
  });

  it('reads an unconfirmed candidate from a report sealed after the coordinator did not finish', () => {
    const { title, rule, path, line, problem, evidence } = invented();
    const candidate = { title, rule, path, line, problem, evidence };
    const [found] = parseReport(
      report(
        { unconfirmed: [{ ...candidate, passes: ['tenancy'] }] },
        { sha: 'a'.repeat(40), runUrl: 'https://example.test/run', unfinished: ['coordinator'] },
      ),
    );
    expect(found).toMatchObject({
      severity: 'Unconfirmed',
      title: candidate.title,
      rule: candidate.rule,
    });
  });

  it('reads no findings from a report without any', () => {
    expect(parseReport(markdown([]))).toEqual([]);
  });
});

describe('dropping what was already handled', () => {
  it('drops a finding the ledger has confirmed, refuted or fixed', () => {
    const found = one();
    for (const state of [
      decision('confirmed', 'GHSA-2222-3333-4444'),
      decision('refuted', 'the guard is in the middleware'),
      decision('fixed', '#12'),
    ]) {
      const ledger = emptyLedger();
      ledger.findings[found.fingerprint] = { ...state, title: '', path: '', at: '' };
      expect(triage([found], ledger, []).fresh).toEqual([]);
    }
  });

  it('drops a finding that matches an existing advisory by title and file', () => {
    const found = one();
    const result = triage([found], emptyLedger(), [
      advisory({ summary: found.title.toUpperCase(), description: `In ${found.path}.` }),
    ]);
    expect(result.handled[0]?.by).toContain('GHSA-2222-3333-4444');
    expect(result.fresh).toEqual([]);
  });

  it("drops a finding whose fingerprint is in an advisory's description", () => {
    const found = one();
    const result = triage([found], emptyLedger(), [
      advisory({ description: `Text.\n\nSweep fingerprint: ${found.fingerprint}` }),
    ]);
    expect(result.fresh).toEqual([]);
    expect(result.handled[0]?.by).toContain('GHSA-2222-3333-4444');
  });

  it('keeps a finding new when an advisory only mentions its fingerprint in passing', () => {
    const found = one();
    const result = triage([found], emptyLedger(), [
      advisory({ description: `see ${found.fingerprint} here` }),
    ]);
    expect(result.fresh).toHaveLength(1);
  });

  it('keeps a finding new when an advisory has the same title but another file', () => {
    const found = one();
    const result = triage([found], emptyLedger(), [
      advisory({ summary: found.title, description: 'In apps/other/src/route.ts.' }),
    ]);
    expect(result.handled).toEqual([]);
    expect(result.fresh).toHaveLength(1);
  });

  it('names an advisory that mentions the same file, but keeps the finding new', () => {
    const found = one();
    const result = triage([found], emptyLedger(), [
      advisory({ description: `In ${found.path} something else.` }),
    ]);
    expect(result.fresh[0]?.related).toEqual(['GHSA-2222-3333-4444']);
  });

  it('refuses a decision that is not an advisory id, a reason or a pull request', () => {
    expect(() => decision('confirmed', 'CVE-2026-1')).toThrow();
    expect(() => decision('fixed', 'https://example.test/pull/1')).toThrow();
    expect(() => decision('refuted', ' ')).toThrow();
    expect(() => decision('ignored', 'x')).toThrow();
  });
});

describe('the gh runner', () => {
  it('the gh runner drops GH_TOKEN, GITHUB_TOKEN and GH_ENTERPRISE_TOKEN', () => {
    const env = ghEnv({
      GH_TOKEN: 'a',
      GITHUB_TOKEN: 'b',
      GH_ENTERPRISE_TOKEN: 'c',
      PATH: '/bin',
    });
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('the ledger file', () => {
  it('refuses a ledger file that is not a sweep ledger', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json');
    writeFileSync(file, JSON.stringify({ schema: 'something-else', findings: {} }));
    expect(() => readLedger(file)).toThrow('is not a sweep ledger');
  });
});

describe('the private folder', () => {
  const sweep = (env: Record<string, string>, calls: string[][] = []) => {
    const key = rsa();
    const sealed = seal(markdown([invented()]), publicKeys(key.publicKey));
    const lines: string[] = [];
    const deps: Deps = {
      env,
      home: mkdtempSync(join(tmpdir(), 'home-')),
      repoRoot,
      now: () => new Date('2026-11-16T10:00:00Z'),
      out: (line) => lines.push(line),
      gh: (args) => {
        calls.push(args);
        if (args[0] === 'run' && args[1] === 'list') return JSON.stringify([{ databaseId: 7 }]);
        if (args[0] === 'run' && args[1] === 'view')
          return JSON.stringify({
            databaseId: 7,
            status: 'completed',
            conclusion: 'success',
            headSha: head,
            createdAt: '2026-11-16T03:17:00Z',
            event: 'schedule',
            url: 'https://example.test/run/7',
          });
        if (args[0] === 'run' && args[1] === 'download') {
          const dir = args[args.indexOf('-D') + 1] ?? '';
          writeFileSync(join(dir, 'security-sweep.sealed.json'), JSON.stringify(sealed));
          writeFileSync(
            join(dir, 'security-sweep-run.json'),
            JSON.stringify({
              cost_usd: 1,
              outcomes: {
                tenancy: 'success',
                rights: 'failure',
                secrets: 'success',
                coordinate: 'success',
              },
            }),
          );
          return '';
        }
        if (args[0] === 'api') return JSON.stringify([[]]);
        throw new Error(`unexpected gh ${args.join(' ')}`);
      },
    };
    return { deps, key, lines };
  };

  it('refuses to download into a git working tree', () => {
    const calls: string[][] = [];
    const repo = mkdtempSync(join(tmpdir(), 'repo-'));
    spawnSync('git', ['init', '-q', repo]);
    const inside = join(repo, 'private', 'sweep');
    const { deps } = sweep({ GENKI_SWEEP_DIR: inside }, calls);
    expect(insideWorkTree(inside)).toBe(true);
    expect(() => fetchAndTriage(undefined, deps)).toThrow(/inside a git working tree/);
    expect(calls.some((c) => c[1] === 'download')).toBe(false);
    expect(existsSync(inside)).toBe(false);
  });

  it('shows why the artifact download failed', () => {
    const { deps, lines } = sweep({ GENKI_SWEEP_DIR: mkdtempSync(join(tmpdir(), 'sweep-')) });
    const gh = deps.gh;
    deps.gh = (args) => {
      if (args[1] === 'download') throw new Error('HTTP 401: Bad credentials');
      return gh(args);
    };
    expect(fetchAndTriage('7', deps)).toBeNull();
    expect(lines.join('\n')).toContain('HTTP 401: Bad credentials');
  });

  it('stops when the checkout does not contain the run commit and says to fetch', () => {
    const calls: string[][] = [];
    const { deps } = sweep({ GENKI_SWEEP_DIR: mkdtempSync(join(tmpdir(), 'sweep-')) }, calls);
    const gh = deps.gh;
    deps.gh = (args) => (args[1] === 'view' ? gh(args).replace(head, 'f'.repeat(40)) : gh(args));
    expect(() => fetchAndTriage('7', deps)).toThrow(/git fetch/);
    expect(calls.some((c) => c[1] === 'download')).toBe(false);
  });

  it('opens the latest run with the key path, keeps the report private and prints no key', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'key-'));
    const { deps, key, lines } = sweep({
      GENKI_SWEEP_DIR: base,
      GENKI_SWEEP_KEY: join(keyDir, 'k.pem'),
    });
    writeFileSync(join(keyDir, 'k.pem'), key.privateKey, { mode: 0o600 });
    const result = fetchAndTriage(undefined, deps);
    expect(result?.fresh).toHaveLength(1);
    expect(statSync(join(base, '7', 'report.md')).mode & 0o077).toBe(0);
    expect(statSync(join(base, '7')).mode & 0o077).toBe(0);
    const printed = lines.join('\n');
    expect(printed).not.toContain('PRIVATE KEY');
    expect(printed).toContain('rights=failure');
    expect(printed).toContain('may miss findings');
  });

  it('records a decision in the ledger, readable only by the maintainer, so the next triage drops it', () => {
    const base = mkdtempSync(join(tmpdir(), 'sweep-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'key-'));
    const { deps, key } = sweep({ GENKI_SWEEP_DIR: base, GENKI_SWEEP_KEY: join(keyDir, 'k.pem') });
    writeFileSync(join(keyDir, 'k.pem'), key.privateKey, { mode: 0o600 });
    const print = fetchAndTriage('7', deps)?.fresh[0]?.fingerprint ?? '';
    recordDecision(['7', print, 'refuted', 'the', 'guard', 'holds'], deps);
    expect(readLedger(join(base, 'ledger.json')).findings[print]).toMatchObject({
      state: 'refuted',
      reason: 'the guard holds',
      at: '2026-11-16T10:00:00.000Z',
    });
    expect(statSync(join(base, 'ledger.json')).mode & 0o077).toBe(0);
    expect(fetchAndTriage('7', deps)?.fresh).toEqual([]);
  });
});
