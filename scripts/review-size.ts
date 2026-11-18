// Measures a pull request without generated files and posts one soft note when it is large.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- review-size -->';
export const MAX_LINES = 3000;
export const MAX_FILES = 50;

const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.lock)$|(^|\/)__snapshots__\/|\.snap$|^docs\/architecture\/system-atlas\.html$/;

export const isGenerated = (path: string) => GENERATED.test(path);

export interface Size {
  lines: number;
  files: number;
}

export function measure(numstat: string): Size {
  let lines = 0;
  let files = 0;
  for (const row of numstat.split('\n')) {
    const [added, deleted, path] = row.split('\t');
    if (!path || isGenerated(path)) continue;
    files++;
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { lines, files };
}

export const oversized = (size: Size) => size.lines > MAX_LINES || size.files > MAX_FILES;

export function note(size: Size, sha: string): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return [
    MARKER,
    `**Large pull request.** At ${sha.slice(0, 7)} it changes ${n(size.lines)} lines in ${n(size.files)} files, not counting lockfiles, generated files and snapshots.`,
    '',
    `Above ${n(MAX_LINES)} lines or ${MAX_FILES} files, people and models review a change less well. If it splits into smaller pull requests that each make sense on their own, consider doing that.`,
    '',
    '<sub>This note is not a review finding and does not block the merge.</sub>',
  ].join('\n');
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
  return res.json();
};

async function post(size: Size) {
  const repo = process.env.REPO ?? '';
  const pr = Number(process.env.PR);
  const body = note(size, process.env.HEAD ?? '');
  const comments: { id: number; body: string; user: { login: string } }[] = await api(
    `/repos/${repo}/issues/${pr}/comments?per_page=100`,
  );
  const existing = comments.find(
    (c) => c.user.login.startsWith('github-actions') && c.body.startsWith(MARKER),
  );
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const size = measure(
    execFileSync('git', ['diff', '--numstat', '--no-renames', `${process.env.BASE}...HEAD`], {
      encoding: 'utf8',
    }),
  );
  if (process.argv[2] === 'post') await post(size);
  else console.log(`lines=${size.lines}\nfiles=${size.files}\noversized=${oversized(size)}`);
}
