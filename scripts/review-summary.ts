// Keeps the model review's summary comment and resolves threads a later push fixed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- model-review-summary -->';
const BOT = 'github-actions';
const DISMISSED = /\b(not fixing|won't fix|wontfix|false positive|this is wrong|not a problem)\b/i;

export type Severity = 'Important' | 'Nit' | 'Pre-existing';
export type Status = 'open' | 'fixed' | 'dismissed';

export interface Thread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  url: string;
  body: string;
  replies: { author: string; body: string }[];
}

export interface Finding {
  threadId: string;
  severity: Severity;
  title: string;
  fix: string;
  path: string;
  line: number | null;
  url: string;
  status: Status;
  fixedIn?: string;
}

export interface Walkthrough {
  summary: string;
  changes: { area: string; summary: string }[];
}

export interface Run {
  sha: string;
  model: string;
  minutes: number | null;
}

export function parseFinding(thread: Thread): Finding | null {
  const head = /^\*\*(Important|Nit|Pre-existing)\*\*:?\s*(.*)/.exec(thread.body);
  if (!head) return null;
  const line = (head[2] ?? '').split('\n')[0]?.trim() ?? '';
  const title = thread.body.startsWith(`**${head[1]}**:`)
    ? line
    : (/^(.+?\.)(\s|$)/.exec(line)?.[1] ?? line);
  const fix =
    /\*\*Fix:\*\*\s*([\s\S]*?)(?:\n\n|<\/details>|$)/.exec(thread.body)?.[1]?.trim() ?? '';
  const botFix = thread.replies.findLast(
    (r) => r.author.startsWith(BOT) && /^Fixed in `?([0-9a-f]{7,40})/.test(r.body),
  );
  const human = thread.replies.filter((r) => !r.author.startsWith(BOT));
  const reopened =
    !thread.isResolved &&
    botFix !== undefined &&
    thread.replies.slice(thread.replies.indexOf(botFix) + 1).some((r) => !r.author.startsWith(BOT));
  const status: Status = reopened
    ? 'open'
    : thread.isResolved || botFix
      ? 'fixed'
      : human.some((r) => DISMISSED.test(r.body))
        ? 'dismissed'
        : 'open';
  return {
    threadId: thread.id,
    severity: head[1] as Severity,
    title,
    fix,
    path: thread.path,
    line: thread.line,
    url: thread.url,
    status,
    fixedIn:
      botFix && !reopened ? /([0-9a-f]{7,40})/.exec(botFix.body)?.[1]?.slice(0, 7) : undefined,
  };
}

const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const order: Record<Severity, number> = { Important: 0, Nit: 1, 'Pre-existing': 2 };

export function renderSummary(
  repo: string,
  pr: number,
  findings: Finding[],
  walkthrough: Walkthrough | null,
  run: Run | null,
): string {
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const count = (s: Status) => findings.filter((f) => f.status === s).length;
  const important = findings.filter(
    (f) => f.severity === 'Important' && f.status === 'open',
  ).length;
  const head =
    findings.length === 0
      ? 'No findings.'
      : `**${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}**: ${count('open')} open` +
        (important ? ` (${important} Important)` : '') +
        `, ${count('fixed')} fixed, ${count('dismissed')} dismissed.`;
  const out = [MARKER, '## Model review', '', head, ''];
  if (walkthrough) {
    out.push('### Walkthrough', '', walkthrough.summary, '');
    if (walkthrough.changes.length) {
      out.push('| Area | What changes |', '| --- | --- |');
      for (const c of walkthrough.changes) out.push(`| \`${cell(c.area)}\` | ${cell(c.summary)} |`);
      out.push('');
    }
  }
  if (sorted.length) {
    out.push('### Findings', '', '| | Where | Finding | Status |', '| --- | --- | --- | --- |');
    for (const f of sorted) {
      const where = `[\`${f.path}${f.line ? `:${f.line}` : ''}\`](${f.url})`;
      const status =
        f.status === 'fixed'
          ? f.fixedIn
            ? `Fixed in ${f.fixedIn}`
            : 'Resolved'
          : f.status === 'dismissed'
            ? 'Dismissed'
            : '**Open**';
      out.push(`| ${f.severity} | ${where} | ${cell(f.title)} | ${status} |`);
    }
    out.push('');
  }
  const open = sorted.filter((f) => f.status === 'open');
  if (open.length) {
    out.push(
      '<details>',
      '<summary>Fix the open findings with your coding agent</summary>',
      '',
      '```text',
      `Fix these review findings on ${repo}#${pr}. Read each thread first; if a finding is wrong, reply in the thread instead of changing code. Add or update a test for each fix, then run npm run check.`,
      '',
      ...open.map(
        (f, i) =>
          `${i + 1}. ${f.path}${f.line ? `:${f.line}` : ''}: ${f.title}${f.fix ? `\n   Fix: ${f.fix.replaceAll('\n', ' ')}` : ''}`,
      ),
      '```',
      '',
      '</details>',
      '',
    );
  }
  const meta = run
    ? `Reviewed at ${run.sha.slice(0, 7)} with ${run.model}${run.minutes != null ? ` in ${run.minutes.toFixed(1)} min` : ''}. `
    : '';
  out.push(
    `<sub>${meta}Pushes are checked against open findings, and fixed ones are resolved. Add the label \`review again\` to review new commits.</sub>`,
  );
  return out.join('\n');
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const graphql = async (query: string, variables: Record<string, unknown>) => {
  const out = await api('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (out.errors) throw new Error(JSON.stringify(out.errors));
  return out.data;
};

interface ThreadPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    id: string;
    isResolved: boolean;
    path: string;
    line: number | null;
    comments: { nodes: { author: { login: string } | null; body: string; url: string }[] };
  }[];
}

async function threads(owner: string, name: string, pr: number): Promise<Thread[]> {
  const q = `query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:50){nodes{author{login} body url}}}}}}}`;
  const all: Thread[] = [];
  let after: string | null = null;
  do {
    const page: ThreadPage = (await graphql(q, { o: owner, n: name, pr, after })).repository
      .pullRequest.reviewThreads;
    for (const t of page.nodes) {
      const [first, ...rest] = t.comments.nodes;
      if (!first?.author?.login.startsWith(BOT)) continue;
      all.push({
        id: t.id,
        isResolved: t.isResolved,
        path: t.path,
        line: t.line,
        url: first.url,
        body: first.body,
        replies: rest.map((c: { author: { login: string } | null; body: string }) => ({
          author: c.author?.login ?? '',
          body: c.body,
        })),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return all;
}

function previousWalkthrough(body: string): Walkthrough | null {
  const m = /<!-- walkthrough (.*?) -->/.exec(body);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1] ?? '', 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const [mode] = process.argv.slice(2);
  const repo = process.env.REPO ?? '';
  const [owner, name] = repo.split('/') as [string, string];
  const pr = Number(process.env.PR);
  const findings = () =>
    threads(owner, name, pr).then((ts) =>
      ts.map(parseFinding).filter((f): f is Finding => f !== null),
    );

  if (mode === 'open') {
    const open = (await findings()).filter((f) => f.status === 'open');
    writeFileSync('open-findings.json', JSON.stringify(open, null, 2));
    console.log(`count=${open.length}`);
    return;
  }

  if (mode === 'resolve') {
    const out = JSON.parse(process.env.OUT || '{"fixed":[]}') as {
      fixed: { thread_id: string; note: string }[];
    };
    const open = new Set(
      JSON.parse(readFileSync('open-findings.json', 'utf8')).map((f: Finding) => f.threadId),
    );
    const fixed = out.fixed.filter((x) => open.has(x.thread_id));
    for (const f of fixed) {
      await graphql(
        `
          mutation ($t: ID!, $b: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $t, body: $b }) {
              comment {
                id
              }
            }
          }
        `,
        { t: f.thread_id, b: `Fixed in \`${process.env.HEAD}\`: ${f.note}` },
      );
    }
    for (const { thread_id: t } of fixed) {
      try {
        await graphql(
          `
            mutation ($t: ID!) {
              resolveReviewThread(input: { threadId: $t }) {
                thread {
                  id
                }
              }
            }
          `,
          { t },
        );
      } catch (error) {
        console.log(`::warning::Could not resolve ${t}: ${String(error)}`);
      }
    }
  }

  const comments: { id: number; body: string; user: { login: string } }[] = await api(
    `/repos/${repo}/issues/${pr}/comments?per_page=100`,
  );
  const existing = comments.find((c) => c.user.login.startsWith(BOT) && c.body.startsWith(MARKER));
  const fromRun =
    process.env.OUT && mode === 'post'
      ? (JSON.parse(process.env.OUT) as Partial<Walkthrough>)
      : null;
  const walkthrough: Walkthrough | null = fromRun?.summary
    ? { summary: fromRun.summary, changes: fromRun.changes ?? [] }
    : existing
      ? previousWalkthrough(existing.body)
      : null;
  const run: Run | null =
    mode === 'post'
      ? {
          sha: process.env.HEAD ?? '',
          model: process.env.MODEL ?? '',
          minutes: process.env.MINUTES ? Number(process.env.MINUTES) : null,
        }
      : existing
        ? (() => {
            const m = /Reviewed at ([0-9a-f]{7}) with (\S+?)(?: in ([\d.]+) min)?\./.exec(
              existing.body,
            );
            return m
              ? { sha: m[1] ?? '', model: m[2] ?? '', minutes: m[3] ? Number(m[3]) : null }
              : null;
          })()
        : null;
  const body =
    renderSummary(repo, pr, await findings(), walkthrough, run) +
    (walkthrough
      ? `\n<!-- walkthrough ${Buffer.from(JSON.stringify(walkthrough)).toString('base64')} -->`
      : '');
  if (existing)
    await api(`/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  else
    await api(`/repos/${repo}/issues/${pr}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
