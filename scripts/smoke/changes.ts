// What changed since the last green smoke run, and which check groups that touches.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const statusContext = 'smoke/genki-test';
export const experimentStart = '2026-11-09T00:00:00Z';

export interface GroupMap {
  groups: Record<string, string>;
  docs: string[];
  rules: { group: string; paths: string[] }[];
  ignore: string[];
}

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

export interface ChangedPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  url: string;
  files: string[];
  diff: string;
  aiReviewed: boolean;
}

export interface Targets {
  full: string[];
  reasons: Record<string, number[]>;
  unmapped: string[];
}

export const loadGroups = (): GroupMap =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'groups.json'), 'utf8')) as GroupMap;

const matches = (path: string, pattern: string) =>
  pattern.startsWith('*') ? path.endsWith(pattern.slice(1)) : path.startsWith(pattern);

export const groupsOfPath = (map: GroupMap, path: string): string[] | 'all' | 'none' => {
  if (map.ignore.some((p) => matches(path, p))) return 'none';
  if (map.docs.some((p) => matches(path, p))) return 'none';
  const groups = map.rules.filter((r) => r.paths.some((p) => matches(path, p))).map((r) => r.group);
  return groups.length ? [...new Set(groups)] : 'all';
};

export const targetsOf = (map: GroupMap, prs: Pick<ChangedPr, 'number' | 'files'>[]): Targets => {
  const reasons: Record<string, Set<number>> = {};
  const unmapped = new Set<string>();
  const add = (group: string, pr: number) => (reasons[group] ??= new Set()).add(pr);
  for (const pr of prs)
    for (const file of pr.files) {
      const groups = groupsOfPath(map, file);
      if (groups === 'none') continue;
      if (groups === 'all') {
        unmapped.add(file);
        for (const g of Object.keys(map.groups)) add(g, pr.number);
      } else for (const g of groups) add(g, pr.number);
    }
  const full = Object.keys(map.groups).filter((g) => reasons[g]);
  return {
    full,
    reasons: Object.fromEntries(
      full.map((g) => [g, [...(reasons[g] ?? [])].sort((a, b) => a - b)]),
    ),
    unmapped: [...unmapped].sort(),
  };
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

export const inExperiment = (pr: Pick<ChangedPr, 'mergedAt' | 'aiReviewed'>) =>
  pr.aiReviewed && pr.mergedAt >= experimentStart;

export const clipDiff = (diff: string, max: number) =>
  diff.length <= max ? diff : `${diff.slice(0, max)}\n[diff cut at ${max} characters]`;

export interface Api {
  (
    path: string,
    init?: { method?: string; body?: unknown; allow?: number[]; accept?: string },
  ): Promise<{ status: number; body: unknown; text: string }>;
}

const temporary = new Set([502, 503, 504]);

export const github =
  (
    token: string,
    options: {
      send?: typeof fetch;
      wait?: (ms: number) => Promise<void>;
      tries?: number;
    } = {},
  ): Api =>
  async (path, init = {}) => {
    const send = options.send ?? fetch;
    const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const tries = (init.method ?? 'GET') === 'GET' ? (options.tries ?? 4) : 1;
    let response: Response | undefined;
    let text = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        response = await send(`https://api.github.com${path}`, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: init.accept ?? 'application/vnd.github+json',
            'content-type': 'application/json',
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(30_000),
        });
        text = await response.text();
      } catch (error) {
        if (attempt === tries) throw error;
        await wait(500 * 2 ** (attempt - 1));
        continue;
      }
      if (!temporary.has(response.status) || attempt === tries) break;
      await wait(500 * 2 ** (attempt - 1));
    }
    if (!response) throw new Error(`GitHub did not answer ${path}`);
    if (response.status >= 400 && !init.allow?.includes(response.status))
      throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}`);
    const json = (init.accept ?? '').includes('json') || init.accept === undefined;
    return {
      status: response.status,
      body: json && text ? (JSON.parse(text) as unknown) : undefined,
      text,
    };
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

interface HistoryResponse {
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

export const historyOf = async (
  api: Api,
  repo: string,
  sha: string,
): Promise<HistoryNode[] | undefined> => {
  const [owner, name] = repo.split('/');
  const { body } = await api('/graphql', {
    method: 'POST',
    body: { query: historyQuery, variables: { owner, name, sha } },
  });
  const response = body as HistoryResponse | undefined;
  if (response?.errors?.length) return undefined;
  return response?.data?.repository?.object?.history?.nodes?.map((n) => ({
    oid: n.oid,
    messageHeadline: n.messageHeadline,
    ...(n.status?.context?.state ? { smoke: n.status.context.state } : {}),
  }));
};

interface PullResponse {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  html_url: string;
  head: { ref: string };
}

export const moreFiles = '(more files than GitHub lists)';

const reviewedByAi = async (api: Api, repo: string, branch: string) => {
  const { body } = await api(
    `/repos/${repo}/actions/workflows/review.yml/runs?event=pull_request&branch=${encodeURIComponent(branch)}&per_page=20`,
    { allow: [404] },
  );
  const runs = (body as { workflow_runs?: { id: number }[] } | undefined)?.workflow_runs ?? [];
  for (const run of runs.slice(0, 10)) {
    const jobs = await api(`/repos/${repo}/actions/runs/${run.id}/jobs`, { allow: [404] });
    const list = (jobs.body as { jobs?: { name: string; conclusion: string | null }[] } | undefined)
      ?.jobs;
    if (list?.some((j) => j.name === 'review' && j.conclusion === 'success')) return true;
  }
  return false;
};

export const changedPrs = async (
  api: Api,
  repo: string,
  numbers: number[],
  limits: { diffChars: number; prs: number },
): Promise<ChangedPr[]> => {
  const out: ChangedPr[] = [];
  for (const number of numbers.slice(0, limits.prs)) {
    const found = await api(`/repos/${repo}/pulls/${number}`, { allow: [404] });
    if (found.status === 404) continue;
    const pull = found.body as PullResponse;
    const files = (await api(`/repos/${repo}/pulls/${number}/files?per_page=100`)).body as {
      filename: string;
    }[];
    const diff = await api(`/repos/${repo}/pulls/${number}`, {
      accept: 'application/vnd.github.diff',
      allow: [406],
    });
    out.push({
      number,
      title: pull.title,
      body: pull.body ?? '',
      mergedAt: pull.merged_at ?? '',
      url: pull.html_url,
      files: [...files.map((f) => f.filename), ...(files.length >= 100 ? [moreFiles] : [])],
      diff: clipDiff(diff.status === 200 ? diff.text : '', limits.diffChars),
      aiReviewed: await reviewedByAi(api, repo, pull.head.ref),
    });
  }
  return out;
};
