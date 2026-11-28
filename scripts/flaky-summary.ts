import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Outcome = 'passed' | 'failed' | 'skipped';

export interface Tally {
  passed: number;
  failed: number;
  skipped: number;
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (whole, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? whole;
    const code = /^#x/i.test(name)
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const attributes = (text: string) => {
  const found: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(/(?<![\w:-])([\w:-]+)="([^"]*)"/g))
    if (key !== undefined && value !== undefined) found[key] = decode(value);
  return found;
};

export const outcomesOf = (xml: string): Map<string, Outcome> => {
  const outcomes = new Map<string, Outcome>();
  for (const piece of xml.split('<testcase').slice(1)) {
    if (!/^[\s/>]/.test(piece)) continue;
    const end = piece.indexOf('>');
    const head = piece.slice(0, end < 0 ? piece.length : end);
    const { classname = '', name = '' } = attributes(head);
    const close = piece.indexOf('</testcase>');
    const body = head.endsWith('/') ? '' : piece.slice(end + 1, close < 0 ? piece.length : close);
    const outcome: Outcome = /<(?:failure|error)\b/.test(body)
      ? 'failed'
      : /<skipped\b/.test(body)
        ? 'skipped'
        : 'passed';
    outcomes.set(`${classname} > ${name}`, outcome);
  }
  return outcomes;
};

export const tally = (runs: Map<string, Outcome>[]): Map<string, Tally> => {
  const tallies = new Map<string, Tally>();
  for (const run of runs)
    for (const [test, outcome] of run) {
      const counts = tallies.get(test) ?? { passed: 0, failed: 0, skipped: 0 };
      counts[outcome] += 1;
      tallies.set(test, counts);
    }
  return tallies;
};

const cell = (text: string) => text.replace(/[|\\`]/g, (c) => `\\${c}`).replace(/\s+/g, ' ');

export const summary = (tallies: Map<string, Tally>, runs: number): string => {
  const rows = [...tallies].sort(([a], [b]) => a.localeCompare(b));
  const flaky = rows.filter(([, t]) => t.failed > 0 && t.passed > 0);
  const failing = rows.filter(([, t]) => t.failed > 0 && t.passed === 0);
  const passing = rows.filter(([, t]) => t.failed === 0 && t.passed > 0).length;
  const table = (title: string, list: typeof rows) =>
    list.length === 0
      ? [`### ${title}`, '', 'None.', '']
      : [
          `### ${title}`,
          '',
          '| Test | Passed | Failed | Skipped |',
          '| --- | --- | --- | --- |',
          ...list.map(
            ([test, t]) => `| ${cell(test)} | ${t.passed} | ${t.failed} | ${t.skipped} |`,
          ),
          '',
        ];
  return [
    '## Flaky test run',
    '',
    `${runs} JUnit files, ${rows.length} tests: ${passing} passed every time, ${flaky.length} flaky, ${failing.length} failed every time.`,
    '',
    ...table('Flaky: passed and failed', flaky),
    ...table('Failed in every run', failing),
  ].join('\n');
};

const xmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return xmlFiles(path);
    return entry.name.endsWith('.xml') ? [path] : [];
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/flaky-summary.ts <junit dir>');
  const files = xmlFiles(dir);
  console.log(
    summary(tally(files.map((file) => outcomesOf(readFileSync(file, 'utf8')))), files.length),
  );
}
