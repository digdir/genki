import type { T } from '../i18n';
import type { TableColumnSpec } from './service-definition';

export type TableColumnType = 'string' | 'number' | 'enum';
export type TableColumnKind = 'document' | 'assessment';

export interface TableColumn {
  key: string;
  name: string;
  type: TableColumnType;
  desc: string;
  kind: TableColumnKind;
  values: string;
}

export interface TableOutput {
  columns: TableColumn[];
  rowKey: string;
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const columnValues = (c: TableColumn) => [
  ...new Set(
    c.values
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];

export const tableOutputSpec = (
  t: TableOutput | undefined,
): { columns?: TableColumnSpec[]; rowKey?: string } => {
  if (!t?.columns.length) return {};
  return {
    columns: t.columns.map((c) => {
      const values = columnValues(c);
      return {
        key: c.key,
        name: c.name.trim() || c.key,
        type: c.type,
        ...(c.desc.trim() ? { description: c.desc.trim() } : {}),
        kind: c.kind,
        ...(values.length && (c.type === 'enum' || c.kind === 'assessment') ? { values } : {}),
      };
    }),
    ...(t.columns.some((c) => c.key === t.rowKey) ? { rowKey: t.rowKey } : {}),
  };
};

const types = new Set<string>(['string', 'number', 'enum']);

export const tableOutputFrom = (output: Record<string, unknown>): TableOutput | undefined => {
  if (!Array.isArray(output.columns)) return undefined;
  const columns = output.columns.map(record).map((c): TableColumn => ({
    key: typeof c.key === 'string' ? c.key : '',
    name: typeof c.name === 'string' ? c.name : '',
    type: types.has(String(c.type)) ? (c.type as TableColumnType) : 'string',
    desc: typeof c.description === 'string' ? c.description : '',
    kind: c.kind === 'assessment' ? 'assessment' : 'document',
    values: Array.isArray(c.values) ? c.values.map(String).join(', ') : '',
  }));
  return { columns, rowKey: typeof output.rowKey === 'string' ? output.rowKey : '' };
};

const columnKey = /^[a-zA-Z0-9_-]{1,64}$/;

export const columnKeyFrom = (name: string, taken: string[]) => {
  const base =
    name
      .toLowerCase()
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'aa')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'kolonne';
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
};

export interface ColumnProblem {
  key?: string;
  values?: string;
}

export const columnProblems = (t: T, table: TableOutput): Record<number, ColumnProblem> => {
  const out: Record<number, ColumnProblem> = {};
  table.columns.forEach((c, i) => {
    const p: ColumnProblem = {};
    if (!columnKey.test(c.key)) p.key = t('tableOutput.keyFormat');
    else if (table.columns.findIndex((x) => x.key === c.key) !== i)
      p.key = t('tableOutput.keyTaken', { key: c.key });
    if (c.type === 'enum' && columnValues(c).length === 0) p.values = t('tableOutput.valuesNeeded');
    if (p.key || p.values) out[i] = p;
  });
  return out;
};
