// Fetches, opens and filters the weekly security sweep for a maintainer, in a private folder outside the repository.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, stepOutcomes, type Sealed } from './security-sweep.ts';

export const REPO = 'digdir/genki';
const WORKFLOW = 'security-sweep.yml';
const SEALED = 'security-sweep.sealed.json';
const RECORD = 'security-sweep-run.json';
const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

export interface SweepFinding {
  fingerprint: string;
  severity: string;
  title: string;
  path: string;
  line: string;
  rule: string;
  text: string;
}

export const normalizeTitle = (text: string) =>
  text
    .toLowerCase()
    .replace(/\bline\s+\d+/g, ' ')
    .replace(/:\d+(?:-\d+)?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const fingerprint = (f: Pick<SweepFinding, 'rule' | 'path' | 'title'>) =>
  createHash('sha256')
    .update([normalizeTitle(f.rule), f.path.trim(), normalizeTitle(f.title)].join('\n'))
    .digest('hex')
    .slice(0, 16);

export function parseReport(markdown: string): SweepFinding[] {
  return markdown
    .split(/^## (?=\d+\. )/m)
    .slice(1)
    .flatMap((section) => {
      const head = /^\d+\. (\w+): (.*)$/m.exec(section);
      const where = /^- \*\*Where:\*\* `([^`]*)`/m.exec(section)?.[1] ?? '';
      const rule = /^- \*\*Rule:\*\* (.*)$/m.exec(section)?.[1] ?? '';
      if (!head) return [];
      const colon = where.lastIndexOf(':');
      const found = {
        severity: head[1] ?? '',
        title: (head[2] ?? '').trim(),
        path: colon > 0 ? where.slice(0, colon) : where,
        line: colon > 0 ? where.slice(colon + 1) : '',
        rule: rule.trim(),
        text: `## ${section.trim()}\n`,
      };
      return [{ fingerprint: fingerprint(found), ...found }];
    });
}

export type Decision =
  | { state: 'confirmed'; ghsa: string }
  | { state: 'refuted'; reason: string }
  | { state: 'fixed'; pr: string };

export type LedgerEntry = Decision & { title: string; path: string; at: string };

export interface Ledger {
  schema: 'digdir.security-sweep.ledger/v1';
  findings: Record<string, LedgerEntry>;
}

const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const PR = /^(?:#?\d+|https:\/\/github\.com\/digdir\/genki\/pull\/\d+)$/;

export function decision(state: string | undefined, value: string): Decision {
  if (state === 'confirmed' && GHSA.test(value)) return { state, ghsa: value };
  if (state === 'fixed' && PR.test(value)) return { state, pr: value.replace(/^#/, '') };
  if (state === 'refuted' && value.trim() !== '') return { state, reason: value.trim() };
  throw new Error(
    'record takes: confirmed <GHSA id> | refuted <reason> | fixed <pull request number>',
  );
}

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { schema: 'digdir.security-sweep.ledger/v1', findings: {} };
  const ledger = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (ledger.schema !== 'digdir.security-sweep.ledger/v1' || typeof ledger.findings !== 'object')
    throw new Error(`${path} is not a sweep ledger; fix or move it before triaging`);
  return ledger;
}

const writePrivate = (path: string, text: string) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
};

export interface Advisory {
  ghsa_id: string;
  summary: string;
  description: string | null;
  state: string;
}

export interface Triage {
  handled: { finding: SweepFinding; by: string }[];
  fresh: (SweepFinding & { related: string[] })[];
}

export function triage(findings: SweepFinding[], ledger: Ledger, advisories: Advisory[]): Triage {
  const result: Triage = { handled: [], fresh: [] };
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    const same = advisories.find(
      (a) =>
        (normalizeTitle(a.summary) === normalizeTitle(finding.title) &&
          finding.path !== '' &&
          (a.description ?? '').includes(finding.path)) ||
        (a.description ?? '').includes(finding.fingerprint),
    );
    if (entry) result.handled.push({ finding, by: `ledger: ${entry.state}` });
    else if (same) result.handled.push({ finding, by: `advisory ${same.ghsa_id} (${same.state})` });
    else
      result.fresh.push({
        ...finding,
        related: advisories
          .filter((a) => finding.path !== '' && (a.description ?? '').includes(finding.path))
          .map((a) => a.ghsa_id),
      });
  }
  return result;
}

export function insideWorkTree(path: string): boolean {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'],
    { encoding: 'utf8', env },
  );
  return git.status === 0 && git.stdout.split('\n').includes('true');
}

export interface Deps {
  gh: (args: string[]) => string;
  env: Record<string, string | undefined>;
  home: string;
  repoRoot: string;
  now: () => Date;
  out: (line: string) => void;
}

export function places(deps: Pick<Deps, 'env' | 'home'>) {
  const base = resolve(deps.env.GENKI_SWEEP_DIR || join(deps.home, '.config/genki/sweep'));
  return {
    base,
    ledger: join(base, 'ledger.json'),
    key: resolve(deps.env.GENKI_SWEEP_KEY || join(deps.home, '.config/genki/sweep.pem')),
  };
}

const privateFolder = (dir: string) => {
  if (insideWorkTree(dir))
    throw new Error(
      `${dir} is inside a git working tree; set GENKI_SWEEP_DIR to a private folder outside every repository`,
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

interface Run {
  databaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  createdAt: string;
  event: string;
  url: string;
}

const hasCommit = (repoRoot: string, sha: string) =>
  spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;

export function fetchAndTriage(runArg: string | undefined, deps: Deps): Triage | null {
  const { base, ledger: ledgerPath, key } = places(deps);
  if (runArg !== undefined && !/^\d+$/.test(runArg))
    throw new Error('the run id is the number in the run URL');
  const id =
    runArg ??
    String(
      (
        JSON.parse(
          deps.gh([
            'run',
            'list',
            '-R',
            REPO,
            '--workflow',
            WORKFLOW,
            '--limit',
            '1',
            '--json',
            'databaseId',
          ]),
        ) as { databaseId: number }[]
      )[0]?.databaseId ?? '',
    );
  if (!id) throw new Error(`no ${WORKFLOW} run found in ${REPO}`);
  const run = JSON.parse(
    deps.gh([
      'run',
      'view',
      id,
      '-R',
      REPO,
      '--json',
      'databaseId,status,conclusion,headSha,createdAt,event,url',
    ]),
  ) as Run;
  deps.out(
    `Run ${id} (${run.event}, ${run.createdAt}): ${run.status} ${run.conclusion || ''}`.trim() +
      `, commit ${run.headSha.slice(0, 12)}\n${run.url}`,
  );
  if (!hasCommit(deps.repoRoot, run.headSha))
    throw new Error(
      `this checkout does not contain the run's commit ${run.headSha.slice(0, 12)}: run git fetch and use current main, then try again`,
    );
  if (run.status !== 'completed') {
    deps.out('The run has not finished yet. Try again when it has.');
    return null;
  }

  privateFolder(base);
  const dir = join(base, id);
  privateFolder(dir);
  if (!existsSync(join(dir, SEALED))) {
    try {
      deps.gh(['run', 'download', id, '-R', REPO, '-n', `security-sweep-${id}`, '-D', dir]);
    } catch (error) {
      deps.out(
        `Could not download the findings artifact: ${error instanceof Error ? error.message : String(error)}\n` +
          'If the run has no findings artifact, it stopped before sealing, or the artifact has expired after 14 days.',
      );
      return null;
    }
  }

  const record = JSON.parse(readFileSync(join(dir, RECORD), 'utf8')) as {
    cost_usd?: number;
    outcomes?: Record<string, string | null>;
  };
  const outcomes = Object.entries(record.outcomes ?? stepOutcomes(''));
  deps.out(
    `Steps: ${outcomes.map(([step, outcome]) => `${step}=${outcome ?? 'unknown'}`).join(' ')}` +
      (record.cost_usd === undefined ? '' : `, cost ${record.cost_usd} USD`),
  );
  if (outcomes.some(([step, o]) => o !== 'success' && !(step === 'coordinate' && o === 'skipped')))
    deps.out('Not every step finished, so this sweep may miss findings.');

  if (!existsSync(key))
    throw new Error(`no private key at ${key}; set GENKI_SWEEP_KEY to the path of yours`);
  const markdown = open(
    JSON.parse(readFileSync(join(dir, SEALED), 'utf8')) as Sealed,
    readFileSync(key, 'utf8'),
  );
  writePrivate(join(dir, 'report.md'), markdown);

  const advisories = (
    JSON.parse(
      deps.gh(['api', '--paginate', '--slurp', `repos/${REPO}/security-advisories?per_page=100`]),
    ) as Advisory[][]
  ).flat();
  const result = triage(parseReport(markdown), readLedger(ledgerPath), advisories);
  writePrivate(join(dir, 'new.json'), JSON.stringify(result.fresh, null, 2));

  deps.out(`Folder: ${dir}`);
  deps.out(
    `Findings: ${result.handled.length + result.fresh.length}, already handled ${result.handled.length}, new ${result.fresh.length}`,
  );
  for (const { finding, by } of result.handled)
    deps.out(`- handled by ${by}: ${finding.fingerprint}`);
  for (const f of result.fresh)
    deps.out(
      `- new ${f.fingerprint} ${f.severity}: ${f.title} (${f.path}:${f.line})` +
        (f.related.length ? `; mentions the same file: ${f.related.join(', ')}` : ''),
    );
  return result;
}

export function recordDecision(args: string[], deps: Deps): LedgerEntry {
  const [id, print, state, ...rest] = args;
  if (!id || !/^\d+$/.test(id) || !print)
    throw new Error('usage: sweep-triage.ts record <run id> <fingerprint> <state> <value>');
  const { base, ledger: ledgerPath } = places(deps);
  privateFolder(base);
  const report = join(base, id, 'report.md');
  const finding = parseReport(readFileSync(report, 'utf8')).find((f) => f.fingerprint === print);
  if (!finding) throw new Error(`no finding ${print} in run ${id}`);
  const ledger = readLedger(ledgerPath);
  const entry: LedgerEntry = {
    ...decision(state, rest.join(' ')),
    title: finding.title,
    path: finding.path,
    at: deps.now().toISOString(),
  };
  ledger.findings[print] = entry;
  writePrivate(ledgerPath, JSON.stringify(ledger, null, 2));
  deps.out(`Recorded ${print} as ${entry.state}.`);
  return entry;
}

function main(args: string[]) {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('needs Node 24: run `mise install` in the repository');
  const deps: Deps = {
    gh: (ghArgs) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !TOKENS.includes(name)),
      );
      const gh = spawnSync('gh', ghArgs, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
      if (gh.status !== 0)
        throw new Error(`gh ${ghArgs.slice(0, 2).join(' ')} failed: ${gh.stderr}`);
      return gh.stdout;
    },
    env: process.env,
    home: homedir(),
    repoRoot: resolve(import.meta.dirname, '..'),
    now: () => new Date(),
    out: (line) => console.log(line),
  };
  if (args[0] === 'record') recordDecision(args.slice(1), deps);
  else fetchAndTriage(args[0], deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
