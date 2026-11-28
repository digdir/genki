import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QuarantineEntry {
  test: string;
  owner: string;
  issue: number;
  expires: string;
}

export const MAX_ENTRIES = 10;
export const MAX_DAYS = 14;

const day = 24 * 60 * 60 * 1000;
const root = join(import.meta.dirname, '..');

const dateOf = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value ? date : undefined;
};

export const fileOf = (test: string) => test.split(' > ')[0] ?? '';

const nameOf = (entry: Partial<Record<keyof QuarantineEntry, unknown>>) =>
  typeof entry.test === 'string' && entry.test.includes(' > ') ? entry.test : undefined;

const entryProblems = (
  entry: Partial<Record<keyof QuarantineEntry, unknown>>,
  label: string,
  today: string,
): string[] => {
  const now = dateOf(today);
  if (!now) throw new Error(`today is not a date: ${today}`);
  const problems: string[] = [];
  if (!nameOf(entry)) problems.push(`${label}: test must be "<file> > <full name>"`);
  if (typeof entry.owner !== 'string' || !/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(entry.owner))
    problems.push(`${label}: owner must be a GitHub login`);
  if (typeof entry.issue !== 'number' || !Number.isInteger(entry.issue) || entry.issue < 1)
    problems.push(`${label}: issue must be an issue number`);
  const expires = dateOf(entry.expires);
  if (!expires) problems.push(`${label}: expires must be a YYYY-MM-DD date`);
  else if (expires < now) problems.push(`${label}: expired on ${String(entry.expires)}`);
  else if (expires.getTime() - now.getTime() > MAX_DAYS * day)
    problems.push(`${label}: expires more than ${MAX_DAYS} days from ${today}`);
  return problems;
};

const entriesOf = (entries: unknown[]) =>
  entries.map((raw) => (raw ?? {}) as Partial<Record<keyof QuarantineEntry, unknown>>);

export const quarantineProblems = (
  entries: unknown,
  today: string,
  knownTests: ReadonlySet<string>,
): string[] => {
  if (!Array.isArray(entries)) return ['test/quarantine.json must be a list'];
  const problems: string[] = [];
  if (entries.length > MAX_ENTRIES)
    problems.push(`${entries.length} entries; at most ${MAX_ENTRIES} tests may be quarantined`);
  const seen = new Set<string>();
  for (const [index, entry] of entriesOf(entries).entries()) {
    const name = nameOf(entry);
    const label = name ?? `entry ${index + 1}`;
    if (name && seen.has(name)) problems.push(`${label}: listed twice`);
    else if (name && !knownTests.has(name)) problems.push(`${label}: matches no test`);
    if (name) seen.add(name);
    problems.push(...entryProblems(entry, label, today));
  }
  return problems;
};

export const quarantinedTests = (entries: unknown, today: string): Set<string> => {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return new Set();
  return new Set(
    entriesOf(entries)
      .filter((entry) => entryProblems(entry, '', today).length === 0)
      .map((entry) => nameOf(entry) ?? ''),
  );
};

const testsIn = (files: string[]): Set<string> => {
  if (files.length === 0) return new Set();
  const listed = JSON.parse(
    execFileSync('npx', ['vitest', 'list', ...files, '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  ) as { name: string; file: string }[];
  return new Set(listed.map((test) => `${relative(root, test.file)} > ${test.name}`));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries: unknown = JSON.parse(readFileSync(join(root, 'test', 'quarantine.json'), 'utf8'));
  const files = Array.isArray(entries)
    ? [
        ...new Set(
          entries
            .map((entry: { test?: unknown }) =>
              typeof entry?.test === 'string' ? fileOf(entry.test) : '',
            )
            .filter((file) => file !== '' && existsSync(join(root, file))),
        ),
      ]
    : [];
  const problems = quarantineProblems(
    entries,
    new Date().toISOString().slice(0, 10),
    testsIn(files),
  );
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(
    `quarantine: ${Array.isArray(entries) ? entries.length : 0} of ${MAX_ENTRIES} entries`,
  );
}
