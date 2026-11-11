// Reports a smoke run: job summary, commit status, findings and the one `smoke` issue.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, SmokeReport } from './assess.ts';
import {
  github,
  statusContext,
  type ChangedPr,
  type SuspectRange,
  type Targets,
} from './changes.ts';
import type { ExtraResult } from './extra.ts';
import type { ModelOutput } from './model-output.ts';
import {
  checkFindings,
  escapedCandidates,
  layerCounts,
  modelOnly,
  parseFindings,
  type EscapedCandidate,
  type Finding,
} from './review.ts';
import type { Bundle } from './run.ts';

export { statusContext };
export const issueLabel = 'smoke';
export const issueTitle = 'Smoke test fails on genki-test';

const marks: Record<CheckResult['outcome'], string> = {
  pass: 'pass',
  flaky: 'flaky (passed on retry)',
  fail: '**FAIL**',
  known: 'known failure',
  skip: 'skip',
};

const short = (sha: string) => sha.slice(0, 8);

export const renderTable = (report: SmokeReport) => {
  const rows = report.checks.map((c) =>
    [
      c.group ?? c.tier,
      `\`${c.id}\``,
      marks[c.outcome],
      c.attempts,
      c.tokens ? `${c.tokens.input}/${c.tokens.output}` : '',
      c.tasks.map((t) => `\`${t}\``).join(' '),
      `${c.skipReason ? `${c.skipReason}: ` : ''}${c.detail}${c.knownIssue ? ` (${c.knownIssue})` : ''}`,
    ].join(' | '),
  );
  return [
    `### Smoke test of ${report.sha ? `\`${short(report.sha)}\`` : 'an unknown version'}: ${report.outcome}`,
    '',
    `API ${report.api}, tiers ${report.tiers.join(', ')}, about ${report.spentKr} kr.${report.full?.length ? ` Run in full: ${report.full.join(', ')}.` : ''}`,
    ...report.notes.map((n) => `\n${n}`),
    '',
    '| Group | Check | Outcome | Attempts | Tokens in/out | Runs | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
};

export const commitStatus = (report: SmokeReport) =>
  report.outcome === 'pass' ? 'success' : report.outcome === 'fail' ? 'failure' : undefined;

export type IssueAction = 'open' | 'comment' | 'close' | 'none';

export const issueAction = (
  report: SmokeReport,
  openIssue: number | undefined,
  findings: Finding[] = [],
): IssueAction => {
  const alarming = report.outcome === 'fail' || findings.some((f) => f.severity === 'high');
  if (alarming) return openIssue ? 'comment' : 'open';
  return report.outcome === 'pass' && openIssue ? 'close' : 'none';
};

const secretShaped = [
  /eyJ[\w-]{8,2000}\.[\w-]{8,4000}\.[\w-]{0,4000}/g,
  /\bgp_[A-Za-z0-9_-]{16,200}/g,
  /\b(?=[A-Za-z0-9_-]{0,200}[A-Z])(?=[A-Za-z0-9_-]{0,200}[a-z])(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{32,200}/g,
  /[\w.+-]{1,64}@[\w-]{1,63}(\.[\w-]{1,63}){1,8}/g,
];

export const sanitize = (text: string, max = 600) => {
  let clean = text.slice(0, 4000);
  for (const pattern of secretShaped) clean = clean.replace(pattern, '[removed]');
  clean = clean.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  if (clean.length > max) clean = `${clean.slice(0, max - 1)}…`;
  return `\`${clean}\``;
};

export const rangeText = (repo: string, sha: string, range: SuspectRange | undefined) => {
  if (!range)
    return 'The commit history around the tested commit could not be read, so the range is unknown.';
  const head = range.green
    ? `Commits since the last green smoke run: [\`${short(range.green)}...${short(sha)}\`](https://github.com/${repo}/compare/${range.green}...${sha}), ${range.commits.length} commits.`
    : `No green smoke run in the last ${range.commits.length} commits, so the range is not bounded.`;
  const prs = range.pullRequests.length
    ? `Merged pull requests in the range: ${range.pullRequests.map((n) => `#${n}`).join(', ')}.`
    : 'No merged pull requests found in the range.';
  return `${head}\n\n${prs}`;
};

export const targetsText = (targets: Targets) => {
  const lines = Object.entries(targets.reasons).map(
    ([group, prs]) => `- \`${group}\` in full, for ${prs.map((n) => `#${n}`).join(', ')}`,
  );
  if (targets.unmapped.length)
    lines.push(
      `- Paths no rule in \`scripts/smoke/groups.json\` maps, so every group ran in full: ${targets.unmapped
        .slice(0, 10)
        .map((p) => `\`${p}\``)
        .join(', ')}${targets.unmapped.length > 10 ? ', …' : ''}`,
    );
  return lines.length
    ? lines.join('\n')
    : '- Baselines only: no merged pull request touched a group.';
};

const findingLine = (f: Finding) =>
  `- **${f.severity}** (${f.source === 'checks' ? 'check' : 'model'}): ${sanitize(f.title, 200)}. ${sanitize(f.evidence)}${
    f.suspectedPrs.length ? ` Suspected: ${f.suspectedPrs.map((n) => `#${n}`).join(', ')}.` : ''
  }`;

export interface Assessment {
  findings: Finding[];
  fromChecks: Finding[];
  fromModel: Finding[];
  counts: { checks: number; model: number };
  escaped: EscapedCandidate[];
}

export const assess = (
  bundle: Pick<Bundle, 'report' | 'targets'> & {
    prs: Pick<ChangedPr, 'number' | 'mergedAt' | 'aiReviewed'>[];
  },
  extra: ExtraResult | undefined,
  judged: unknown,
): Assessment => {
  const prNumbers = bundle.prs.map((p) => p.number);
  const failed = bundle.report.checks
    .filter((c) => c.outcome === 'fail')
    .map((c) => ({ id: c.id, group: c.group ?? '', detail: c.detail }));
  const fromChecks = checkFindings(failed, bundle.targets.reasons);
  const extraFailed = (extra?.checks ?? [])
    .filter((c) => c.outcome === 'fail')
    .map((c) => ({
      source: 'model' as const,
      title: `${c.id} failed`,
      severity: 'medium' as const,
      evidence: `${c.detail}. Proposed because: ${c.why}`,
      checks: [c.id],
      suspectedPrs: c.pullRequest ? [c.pullRequest] : [],
    }));
  const ids = [...bundle.report.checks.map((c) => c.id), ...(extra?.checks ?? []).map((c) => c.id)];
  const fromModel = [...extraFailed, ...parseFindings(judged, ids, prNumbers)];
  const findings = [...fromChecks, ...modelOnly(fromModel, fromChecks)];
  return {
    findings,
    fromChecks,
    fromModel,
    counts: layerCounts(fromChecks, fromModel),
    escaped: escapedCandidates(findings, bundle.prs),
  };
};

export const issueBody = (
  report: SmokeReport,
  repo: string,
  range: SuspectRange | undefined,
  targets: Targets,
  a: Assessment,
  reviewNote?: string,
) =>
  [
    `The smoke test of ${report.sha ? `\`${short(report.sha)}\`` : 'an unknown version'} on genki-test ${report.outcome === 'fail' ? 'failed' : 'raised findings'}${report.runUrl ? ` ([run](${report.runUrl}))` : ''}.`,
    '',
    '**Findings**',
    '',
    ...(a.findings.length ? a.findings.map(findingLine) : ['- None.']),
    '',
    `Found by the checks: ${a.counts.checks}. Found only by the model review: ${a.counts.model}.${reviewNote ? ` ${reviewNote}` : ''}`,
    '',
    '**Why these checks ran**',
    '',
    targetsText(targets),
    '',
    rangeText(repo, report.sha, range),
    '',
    ...(a.escaped.length
      ? [
          '**Candidates for `escaped`**',
          '',
          'Merged on or after 2026-11-09 and seen by the AI review. A person decides; nothing is labelled automatically.',
          '',
          ...a.escaped.map(
            (e) => `- #${e.pullRequest}: ${e.findings.map((f) => sanitize(f, 120)).join('; ')}`,
          ),
          '',
        ]
      : []),
    'Suspected pull requests are where to look first, not a verdict on anyone. When the cause is a merged pull request the AI review saw, label the fix pull request `escaped`.',
  ].join('\n');

export const greenBody = (report: SmokeReport) =>
  `Green again at \`${short(report.sha)}\`${report.runUrl ? ` ([run](${report.runUrl}))` : ''}. Closing.`;

export const missingBundle = (sha: string, runUrl?: string): Bundle => ({
  report: {
    sha,
    api: '',
    tiers: [],
    notes: ['The smoke job ended without a result. Read its log.'],
    checks: [
      {
        id: 'smoke:job',
        tier: 'core',
        outcome: 'fail',
        detail: 'the smoke job crashed or was cancelled before it wrote bundle.json',
        attempts: 1,
        tasks: [],
      },
    ],
    spentKr: 0,
    outcome: 'fail',
    ...(runUrl ? { runUrl } : {}),
  },
  targets: { full: [], reasons: {}, unmapped: [] },
  prs: [],
  review: false,
});

const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;

export const main = async () => {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_STEP_SUMMARY,
    SMOKE_OUT,
    SMOKE_SHA,
    SMOKE_RUN_URL,
  } = process.env;
  const out = SMOKE_OUT || 'smoke-out';
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY)
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const bundle =
    readJson<Bundle>(join(out, 'bundle.json')) ?? missingBundle(SMOKE_SHA ?? '', SMOKE_RUN_URL);
  const extra = readJson<ExtraResult>(join(out, 'extra', 'extra.json'));
  const judge = readJson<ModelOutput>(join(out, 'model', 'judged.json'));
  const propose = readJson<ModelOutput>(join(out, 'model', 'proposals.json'));
  const judged = judge?.output ?? {};
  const modelCostUsd = [judge?.costUsd, propose?.costUsd].reduce<number | null>(
    (sum, c) => (typeof c === 'number' ? (sum ?? 0) + c : sum),
    null,
  );
  const { report, targets, range } = bundle;
  const repo = GITHUB_REPOSITORY;
  const api = github(GITHUB_TOKEN);
  const a = assess(bundle, extra, judged);
  writeFileSync(join(out, 'assessment.json'), JSON.stringify({ ...a, modelCostUsd }, null, 2));
  if (GITHUB_STEP_SUMMARY)
    appendFileSync(
      GITHUB_STEP_SUMMARY,
      [
        '',
        '### Findings',
        '',
        ...(a.findings.length ? a.findings.map(findingLine) : ['- None.']),
        '',
        `Checks: ${a.counts.checks}, model review: ${a.counts.model}.${bundle.reviewNote ? ` ${bundle.reviewNote}` : ''}${modelCostUsd === null ? '' : ` The model review cost USD ${modelCostUsd.toFixed(2)}.`}`,
        ...(extra
          ? [
              `Extra checks: ${extra.checks.length} run, ${extra.rejected.length} rejected, about ${extra.spentKr} kr.${extra.notRun ? ` ${extra.notRun}.` : ''}`,
            ]
          : []),
        '',
        '### Why these checks ran',
        '',
        targetsText(targets),
        '',
      ].join('\n'),
    );
  const known = /^[0-9a-f]{40}$/.test(report.sha);
  const state = commitStatus(report);
  if (known && state)
    await api(`/repos/${repo}/statuses/${report.sha}`, {
      method: 'POST',
      body: {
        state,
        context: statusContext,
        description: `Smoke test ${report.outcome}`,
        ...(report.runUrl ? { target_url: report.runUrl } : {}),
      },
    });
  const { body: issues } = await api(
    `/repos/${repo}/issues?labels=${issueLabel}&state=open&per_page=10`,
  );
  const issue = (issues as { number: number; pull_request?: unknown }[] | undefined)?.find(
    (i) => !i.pull_request,
  )?.number;
  const action = issueAction(report, issue, a.findings);
  if (action === 'open' || action === 'comment') {
    const body = issueBody(report, repo, range, targets, a, bundle.reviewNote);
    if (action === 'comment')
      await api(`/repos/${repo}/issues/${issue}/comments`, { method: 'POST', body: { body } });
    else {
      await api(`/repos/${repo}/labels`, {
        method: 'POST',
        body: {
          name: issueLabel,
          color: 'D93F0B',
          description: 'The post-deploy smoke test on genki-test failed',
        },
        allow: [422],
      });
      await api(`/repos/${repo}/issues`, {
        method: 'POST',
        body: { title: issueTitle, body, labels: [issueLabel] },
      });
    }
  } else if (action === 'close') {
    await api(`/repos/${repo}/issues/${issue}/comments`, {
      method: 'POST',
      body: { body: greenBody(report) },
    });
    await api(`/repos/${repo}/issues/${issue}`, { method: 'PATCH', body: { state: 'closed' } });
  }
  if (report.outcome === 'fail') process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
