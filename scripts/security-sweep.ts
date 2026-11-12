// Merges, checks and seals the findings of the scheduled security sweep; only maintainers can open them.
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PASSES = ['tenancy', 'rights', 'secrets'] as const;
export type Pass = (typeof PASSES)[number];

export interface Candidate {
  title: string;
  rule: string;
  invariant?: string;
  path: string;
  line: number;
  start_line?: number;
  problem: string;
  evidence: string;
}

export interface MergedCandidate extends Candidate {
  passes: Pass[];
}

export interface Finding extends Candidate {
  severity: 'Important' | 'Nit';
  abuser: string;
  reach: string;
  fix: string;
}

const FILE_LINE = /\.[A-Za-z]{1,8}:\d/;

export const hasEvidence = (c: Pick<Candidate, 'path' | 'line' | 'evidence'>) =>
  c.path.trim() !== '' && Number.isInteger(c.line) && c.line > 0 && FILE_LINE.test(c.evidence);

const range = (c: Candidate) => [c.start_line ?? c.line, c.line] as const;
const overlaps = (a: Candidate, b: Candidate) => {
  const [a1, a2] = range(a);
  const [b1, b2] = range(b);
  return a.path === b.path && a1 <= b2 && b1 <= a2;
};

export function mergeCandidates(
  outputs: Partial<Record<Pass, { candidates?: Candidate[] } | null>>,
): MergedCandidate[] {
  const merged: MergedCandidate[] = [];
  for (const pass of PASSES) {
    for (const c of outputs[pass]?.candidates ?? []) {
      if (!hasEvidence(c)) continue;
      const same = merged.find((m) => overlaps(m, c));
      if (!same) {
        merged.push({ ...c, passes: [pass] });
        continue;
      }
      if (!same.passes.includes(pass)) same.passes.push(pass);
      if (c.evidence.length > same.evidence.length) Object.assign(same, c, { passes: same.passes });
    }
  }
  return merged;
}

export const isReportable = (f: Finding) =>
  hasEvidence(f) && f.abuser.trim() !== '' && f.reach.trim() !== '';

export function confirmedFindings(output: { findings?: Finding[] } | null): Finding[] {
  const kept = (output?.findings ?? []).filter(isReportable);
  return kept.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'Important' ? -1 : 1));
}

export function unfinishedSteps(outcomes: string): string[] {
  return outcomes
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split('='))
    .filter(
      ([step, outcome]) =>
        outcome !== 'success' && !(step === 'coordinate' && outcome === 'skipped'),
    )
    .map(([step]) => step ?? '');
}

export const STEPS = [...PASSES, 'coordinate'] as const;
const OUTCOMES = ['success', 'failure', 'skipped', 'cancelled'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function stepOutcomes(outcomes: string): Record<(typeof STEPS)[number], Outcome | null> {
  const pairs = new Map(
    outcomes
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => pair.split('=') as [string, string | undefined]),
  );
  return Object.fromEntries(
    STEPS.map((step) => {
      const outcome = pairs.get(step);
      return [step, OUTCOMES.find((o) => o === outcome) ?? null];
    }),
  ) as Record<(typeof STEPS)[number], Outcome | null>;
}

export function report(
  findings: Finding[],
  meta: { sha: string; runUrl: string; unfinished: string[] },
): string {
  const warning = meta.unfinished.length
    ? `**Incomplete:** ${meta.unfinished.join(', ')} did not finish, so this report may miss findings.\n\n`
    : '';
  const head = `# Security sweep at ${meta.sha.slice(0, 12)}\n\n${meta.runUrl}\n\n${warning}`;
  if (findings.length === 0) return `${head}No confirmed findings.\n`;
  return (
    head +
    findings
      .map(
        (f, i) =>
          `## ${i + 1}. ${f.severity}: ${f.title}\n\n` +
          `- **Where:** \`${f.path}:${f.start_line && f.start_line < f.line ? `${f.start_line}-` : ''}${f.line}\`\n` +
          `- **Rule:** ${f.rule}\n` +
          (f.invariant ? `- **Invariant:** ${f.invariant}\n` : '') +
          `- **Who could abuse it:** ${f.abuser}\n` +
          `- **How far it reaches:** ${f.reach}\n\n` +
          `${f.problem}\n\n**Evidence:** ${f.evidence}\n\n**Fix:** ${f.fix}\n`,
      )
      .join('\n')
  );
}

export interface Sealed {
  schema: 'digdir.security-sweep.sealed/v1';
  recipients: { id: string; key: string }[];
  iv: string;
  tag: string;
  data: string;
}

const PEM = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;
const MIN_RSA_BITS = 3072;

export function publicKeys(text: string): KeyObject[] {
  const keys = (text.match(PEM) ?? []).map((pem) => createPublicKey(pem));
  if (keys.length === 0) throw new Error('no public key to seal the findings to');
  for (const key of keys)
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
    )
      throw new Error(`every key must be RSA with at least ${MIN_RSA_BITS} bits`);
  return keys;
}

const keyId = (key: KeyObject) =>
  createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);

const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

export function seal(plaintext: string, keys: KeyObject[]): Sealed {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    schema: 'digdir.security-sweep.sealed/v1',
    recipients: keys.map((key) => ({
      id: keyId(key),
      key: publicEncrypt({ key, ...OAEP }, dataKey).toString('base64'),
    })),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function open(sealed: Sealed, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const id = keyId(createPublicKey(privateKey));
  const recipient = sealed.recipients.find((r) => r.id === id);
  if (!recipient) throw new Error('this key is not one the findings were sealed to');
  const dataKey = privateDecrypt(
    { key: privateKey, ...OAEP },
    Buffer.from(recipient.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export interface ExecutionMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  structured_output?: unknown;
}

export function structuredOutput<T>(execution: ExecutionMessage[] | null): T | null {
  const result = execution?.find((m) => m.type === 'result');
  if (result?.subtype !== 'success' || result.is_error) return null;
  return (result.structured_output as T | undefined) ?? null;
}

export function runRecord(input: {
  repo: string;
  sha: string;
  runId: string;
  model: string;
  startedAt: string;
  outcomes: string;
  executions: ExecutionMessage[][];
}) {
  const results = input.executions.map((e) => e.find((m) => m.type === 'result'));
  const sum = (pick: (r: ExecutionMessage) => number | undefined) =>
    results.reduce((total, r) => total + (r ? (pick(r) ?? 0) : 0), 0);
  return {
    schema: 'digdir.security-sweep.run/v1',
    repo: input.repo,
    sha: input.sha,
    run_id: input.runId,
    model: input.model,
    started_at: input.startedAt,
    steps_completed: results.filter(Boolean).length,
    steps: input.executions.length,
    duration_s: Math.round(sum((r) => r.duration_ms) / 1000),
    turns: sum((r) => r.num_turns),
    cost_usd: Math.round(sum((r) => r.total_cost_usd) * 100) / 100,
    outcomes: stepOutcomes(input.outcomes),
  };
}

const env = (k: string) => process.env[k] ?? '';
const parse = <T>(text: string): T | null => {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
};
const readJson = <T>(path: string): T | null => {
  if (!path) return null;
  try {
    return parse<T>(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const passExecutions = () =>
  PASSES.map((pass) =>
    readJson<ExecutionMessage[]>(join(env('RUNNER_TEMP'), `sweep-${pass}.json`)),
  );

function main(command: string | undefined, args: string[]) {
  if (command === 'keys') {
    publicKeys(env('SWEEP_PUBLIC_KEYS'));
    return;
  }
  if (command === 'merge') {
    const executions = passExecutions();
    const merged = mergeCandidates(
      Object.fromEntries(PASSES.map((pass, i) => [pass, structuredOutput(executions[i] ?? null)])),
    );
    mkdirSync('.sweep', { recursive: true });
    writeFileSync('.sweep/candidates.json', JSON.stringify(merged, null, 2));
    console.log(`count=${merged.length}`);
    return;
  }
  if (command === 'seal') {
    const coordinator = readJson<ExecutionMessage[]>(env('COORDINATE_EXECUTION'));
    const findings = confirmedFindings(structuredOutput(coordinator));
    const runUrl = `${env('GITHUB_SERVER_URL')}/${env('REPO')}/actions/runs/${env('GITHUB_RUN_ID')}`;
    const sealed = seal(
      report(findings, { sha: env('SHA'), runUrl, unfinished: unfinishedSteps(env('OUTCOMES')) }),
      publicKeys(env('SWEEP_PUBLIC_KEYS')),
    );
    writeFileSync('security-sweep.sealed.json', JSON.stringify(sealed));
    const record = runRecord({
      repo: env('REPO'),
      sha: env('SHA'),
      runId: env('GITHUB_RUN_ID'),
      model: env('MODEL'),
      startedAt: env('STARTED_AT'),
      outcomes: env('OUTCOMES'),
      executions: [...passExecutions(), coordinator].map((e) => e ?? []),
    });
    writeFileSync('security-sweep-run.json', JSON.stringify(record, null, 2));
    return;
  }
  if (command === 'open') {
    const [sealedPath, keyPath] = args;
    if (!sealedPath || !keyPath)
      throw new Error(
        'usage: security-sweep.ts open <security-sweep.sealed.json> <private-key.pem>',
      );
    process.stdout.write(
      open(JSON.parse(readFileSync(sealedPath, 'utf8')) as Sealed, readFileSync(keyPath, 'utf8')),
    );
    return;
  }
  throw new Error('usage: security-sweep.ts keys | merge | seal | open <sealed> <key>');
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv[2], process.argv.slice(3));
