import { parse as parseYaml } from 'yaml';
import type { CaseSplit, CaseType, NewServiceCase } from '../../api/quality';

export type RowProblem =
  | 'inputMissing'
  | 'inputStructured'
  | 'expectedMissing'
  | 'typeUnknown'
  | 'splitUnknown'
  | 'idInvalid'
  | 'idDuplicate'
  | 'idExists';

export type FileProblem = 'formatUnknown' | 'unreadable' | 'noCases' | 'headerMissing';

export interface ImportRow {
  row: number;
  value: NewServiceCase & { id?: string };
  problems: RowProblem[];
}

export type ImportResult =
  { ok: true; unit: 'row' | 'case'; rows: ImportRow[] } | { ok: false; problem: FileProblem };

const caseTypes: CaseType[] = ['criteria', 'exact', 'must_reject'];
const idPattern = /^[a-z0-9][a-z0-9-]*$/;

const splitOf = (raw: unknown): CaseSplit | undefined => {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (value === undefined || value === '' || value === null) return 'open';
  if (value === 'holdout' || value === 'locked' || value === 'låst') return 'locked';
  if (value === 'train' || value === 'validation' || value === 'open' || value === 'åpen')
    return 'open';
  return undefined;
};

const textOf = (raw: unknown) =>
  typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';

const expectedOf = (raw: unknown) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const e = raw as Record<string, unknown>;
    const criteria = e.criteria as Record<string, unknown> | undefined;
    return textOf(criteria?.criteria) || textOf(e.referenceAnswer) || textOf(e.answerPattern);
  }
  return textOf(raw);
};

const toRow = (raw: Record<string, unknown>, row: number): ImportRow => {
  const problems: RowProblem[] = [];
  const structured = raw.input !== undefined && typeof raw.input === 'object';
  const input = structured ? '' : textOf(raw.input);
  const expected = expectedOf(raw.expected);
  const typeText = textOf(raw.type) || 'criteria';
  const type = caseTypes.find((x) => x === typeText);
  const split = splitOf(raw.split);
  const id = textOf(raw.id);
  if (structured) problems.push('inputStructured');
  else if (!input) problems.push('inputMissing');
  if (!type) problems.push('typeUnknown');
  if (type !== 'must_reject' && !expected) problems.push('expectedMissing');
  if (!split) problems.push('splitUnknown');
  if (id && !idPattern.test(id)) problems.push('idInvalid');
  return {
    row,
    value: {
      ...(id ? { id } : {}),
      input,
      expected,
      type: type ?? 'criteria',
      split: split ?? 'open',
    },
    problems,
  };
};

const header: Record<string, string> = {
  id: 'id',
  input: 'input',
  inndata: 'input',
  spørsmål: 'input',
  question: 'input',
  expected: 'expected',
  forventet: 'expected',
  'godt svar': 'expected',
  referenceanswer: 'expected',
  type: 'type',
  split: 'split',
  del: 'split',
};

const csvRecords = (text: string) => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      records.push({ line: start, cells });
      cells = [];
      cell = '';
      line++;
      start = line;
    } else cell += ch;
  }
  if (cell || cells.length) {
    cells.push(cell);
    records.push({ line: start, cells });
  }
  return records.filter((r) => r.cells.some((c) => c.trim()));
};

const fromCsv = (text: string): ImportResult => {
  const [head, ...body] = csvRecords(text.replace(/^\uFEFF/, ''));
  if (!head) return { ok: false, problem: 'noCases' };
  const columns = head.cells.map((c) => header[c.trim().toLowerCase()]);
  if (!columns.includes('input')) return { ok: false, problem: 'headerMissing' };
  if (body.length === 0) return { ok: false, problem: 'noCases' };
  return {
    ok: true,
    unit: 'row',
    rows: body.map((r) =>
      toRow(
        Object.fromEntries(columns.flatMap((name, i) => (name ? [[name, r.cells[i] ?? '']] : []))),
        r.line,
      ),
    ),
  };
};

const casesIn = (data: unknown): unknown[] | undefined => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const d = data as { spec?: { cases?: unknown }; cases?: unknown };
    if (Array.isArray(d.spec?.cases)) return d.spec.cases;
    if (Array.isArray(d.cases)) return d.cases;
  }
  return undefined;
};

const fromData = (data: unknown): ImportResult => {
  const cases = casesIn(data);
  if (!cases) return { ok: false, problem: 'unreadable' };
  if (cases.length === 0) return { ok: false, problem: 'noCases' };
  return {
    ok: true,
    unit: 'case',
    rows: cases.map((c, i) =>
      c && typeof c === 'object' && !Array.isArray(c)
        ? toRow(c as Record<string, unknown>, i + 1)
        : toRow({}, i + 1),
    ),
  };
};

const formatOf = (name: string) => {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return undefined;
};

export const parseCaseFile = (
  name: string,
  text: string,
  existingIds: readonly string[] = [],
): ImportResult => {
  const format = formatOf(name);
  if (!format) return { ok: false, problem: 'formatUnknown' };
  let result: ImportResult;
  try {
    result =
      format === 'csv'
        ? fromCsv(text)
        : fromData(format === 'json' ? JSON.parse(text) : parseYaml(text));
  } catch {
    return { ok: false, problem: 'unreadable' };
  }
  if (!result.ok) return result;
  const seen = new Set<string>();
  for (const row of result.rows) {
    const id = row.value.id;
    if (!id) continue;
    if (existingIds.includes(id)) row.problems.push('idExists');
    else if (seen.has(id)) row.problems.push('idDuplicate');
    seen.add(id);
  }
  return result;
};
