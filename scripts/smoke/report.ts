// Reports a smoke run: job summary table, commit status, and the one `smoke` issue.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CheckResult, SmokeReport } from './assess.ts';

export const statusContext = 'smoke/genki-test';
export const issueLabel = 'smoke';
export const issueTitle = 'Smoke test fails on genki-test';

export interface HistoryNode {
  oid: string;
  messageHeadline: string;
  smoke?: string;
}

export interface SuspectRange {
  green?: string;
  commits: HistoryNode[];
  pullRequests: number[];
}

const marks: Record<CheckResult['outcome'], string> = {
  pass: 'pass',
  flaky: 'flaky (passed on retry)',
  fail: '**FAIL**',
  skip: 'skip',
};

export const renderTable = (report: SmokeReport) => {
  const rows = report.checks.map((c) =>
    [
      c.tier,
      `\`${c.id}\``,
      marks[c.outcome],
      c.attempts,
      c.tokens ? `${c.tokens.input}/${c.tokens.output}` : '',
      c.tasks.map((t) => `\`${t}\``).join(' '),
      c.skipReason ? `${c.skipReason}: ${c.detail}` : c.detail,
    ].join(' | '),
  );
  return [
    `### Smoke test of ${report.sha ? `\`${report.sha.slice(0, 8)}\`` : 'an unknown version'}: ${report.outcome}`,
    '',
    `API ${report.api}, tiers ${report.tiers.join(', ')}, about ${report.spentKr} kr.`,
    ...report.notes.map((n) => `\n${n}`),
    '',
    '| Tier | Check | Outcome | Attempts | Tokens in/out | Runs | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
};

const prNumber = /\(#(\d{1,7})\)$/;

export const suspectRange = (nodes: HistoryNode[]): SuspectRange => {
  const at = nodes.findIndex((n, i) => i > 0 && n.smoke === 'SUCCESS');
  const commits = at < 0 ? nodes : nodes.slice(0, at);
  const pullRequests = [
    ...new Set(
      commits.flatMap((c) => {
        const match = prNumber.exec(c.messageHeadline.trim());
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const green = nodes[at]?.oid;
  return { ...(green && at > 0 ? { green } : {}), commits, pullRequests };
};

export const commitStatus = (report: SmokeReport) =>
  report.outcome === 'pass' ? 'success' : report.outcome === 'fail' ? 'failure' : undefined;

export type IssueAction = 'open' | 'comment' | 'close' | 'none';

export const issueAction = (report: SmokeReport, openIssue: number | undefined): IssueAction => {
  if (report.outcome === 'fail') return openIssue ? 'comment' : 'open';
  return report.outcome === 'pass' && openIssue ? 'close' : 'none';
};

const short = (sha: string) => sha.slice(0, 8);

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

export const failureBody = (report: SmokeReport, repo: string, range: SuspectRange | undefined) => {
  const failed = report.checks.filter((c) => c.outcome === 'fail');
  return [
    `The smoke test of ${report.sha ? `\`${short(report.sha)}\`` : 'an unknown version'} on genki-test failed${report.runUrl ? ` ([run](${report.runUrl}))` : ''}.`,
    '',
    'Failing checks:',
    '',
    ...failed.map(
      (c) =>
        `- \`${c.id}\`: ${c.detail}${c.tasks.length ? ` (genki runs ${c.tasks.map((t) => `\`${t}\``).join(', ')})` : ''}`,
    ),
    '',
    rangeText(repo, report.sha, range),
    '',
    'This is the range to look in, not a verdict on any pull request. When the cause is a merged pull request the AI review saw, label the fix pull request `escaped`.',
  ].join('\n');
};

export const greenBody = (report: SmokeReport) =>
  `Green again at \`${short(report.sha)}\`${report.runUrl ? ` ([run](${report.runUrl}))` : ''}. Closing.`;

interface Api {
  (
    path: string,
    init?: { method?: string; body?: unknown; allow?: number[] },
  ): Promise<{ status: number; body: unknown }>;
}

const github =
  (token: string): Api =>
  async (path, init = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (response.status >= 400 && !init.allow?.includes(response.status))
      throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}`);
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
  };

const historyQuery = `query($owner: String!, $name: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        history(first: 100) {
          nodes { oid messageHeadline status { context(name: "${statusContext}") { state } } }
        }
      }
    }
  }
}`;

const historyOf = async (api: Api, repo: string, sha: string) => {
  const [owner, name] = repo.split('/');
  const { body } = await api('/graphql', {
    method: 'POST',
    body: { query: historyQuery, variables: { owner, name, sha } },
  });
  const nodes = (
    body as {
      errors?: unknown[];
      data?: {
        repository?: {
          object?: {
            history?: {
              nodes?: {
                oid: string;
                messageHeadline: string;
                status?: { context?: { state: string } | null } | null;
              }[];
            };
          } | null;
        };
      };
    }
  )?.data?.repository?.object?.history?.nodes;
  if ((body as { errors?: unknown[] } | undefined)?.errors?.length) return undefined;
  return nodes?.map((n) => ({
    oid: n.oid,
    messageHeadline: n.messageHeadline,
    ...(n.status?.context?.state ? { smoke: n.status.context.state } : {}),
  }));
};

const openIssue = async (api: Api, repo: string) => {
  const { body } = await api(`/repos/${repo}/issues?labels=${issueLabel}&state=open&per_page=10`);
  return (body as { number: number; pull_request?: unknown }[] | undefined)?.find(
    (i) => !i.pull_request,
  )?.number;
};

export const main = async () => {
  const { REPORT, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY } = process.env;
  if (!REPORT || !GITHUB_TOKEN || !GITHUB_REPOSITORY)
    throw new Error('REPORT, GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const report = JSON.parse(REPORT) as SmokeReport;
  const repo = GITHUB_REPOSITORY;
  const api = github(GITHUB_TOKEN);
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
  const issue = await openIssue(api, repo);
  const action = issueAction(report, issue);
  if (action === 'open' || action === 'comment') {
    const nodes = known ? await historyOf(api, repo, report.sha) : undefined;
    const range = nodes ? suspectRange(nodes) : undefined;
    const body = failureBody(report, repo, range);
    if (GITHUB_STEP_SUMMARY)
      appendFileSync(GITHUB_STEP_SUMMARY, `${rangeText(repo, report.sha, range)}\n`);
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
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
