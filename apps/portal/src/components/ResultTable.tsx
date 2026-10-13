import { Link, Table } from '@digdir/designsystemet-react';
import { sourceUrl } from '../data/playground';
import { useT, type T } from '../i18n';

export interface TableSource {
  chunkId?: string;
  document?: string;
  title?: string;
  url?: string;
}

export interface ResultTable {
  title?: string;
  columns: { key: string; label: string }[];
  rows: { document?: string; cells: Record<string, { value: unknown; sources: TableSource[] }> }[];
  skipped: { index: number; document?: TableSource; error?: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const sourceFrom = (v: unknown): TableSource =>
  isRecord(v)
    ? {
        ...(str(v.chunkId) ? { chunkId: str(v.chunkId) as string } : {}),
        ...(str(v.document) ? { document: str(v.document) as string } : {}),
        ...(str(v.title) ? { title: str(v.title) as string } : {}),
        ...(str(v.url) ? { url: str(v.url) as string } : {}),
      }
    : {};

export const tableFrom = (value: unknown): ResultTable | undefined => {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows))
    return undefined;
  return {
    ...(str(value.title) ? { title: str(value.title) as string } : {}),
    columns: value.columns
      .filter(isRecord)
      .map((c) => ({ key: String(c.key ?? ''), label: String(c.label ?? c.key ?? '') })),
    rows: value.rows.filter(isRecord).map((row) => ({
      ...(str(row.document) ? { document: str(row.document) as string } : {}),
      cells: Object.fromEntries(
        Object.entries(isRecord(row.cells) ? row.cells : {}).map(([key, cell]) => [
          key,
          {
            value: isRecord(cell) ? cell.value : cell,
            sources:
              isRecord(cell) && Array.isArray(cell.sources) ? cell.sources.map(sourceFrom) : [],
          },
        ]),
      ),
    })),
    skipped: (Array.isArray(value.skipped) ? value.skipped : []).filter(isRecord).map((s) => ({
      index: typeof s.index === 'number' ? s.index : 0,
      ...(isRecord(s.document) ? { document: sourceFrom(s.document) } : {}),
      ...(str(s.error) ? { error: str(s.error) as string } : {}),
    })),
  };
};

const cellText = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

const sourceKey = (s: TableSource) => s.chunkId ?? s.document ?? s.url ?? s.title ?? '';
const sourceName = (s: TableSource, t: T) =>
  s.title ?? s.document ?? s.chunkId ?? t('resultTable.source');
const linkOf = (s: TableSource) => sourceUrl({ ...s, chunkId: s.chunkId ?? '' });

export const ResultTableView = ({
  table,
  csv,
}: {
  table: ResultTable;
  csv?: string | undefined;
}) => {
  const t = useT();
  const numbers = new Map<string, number>();
  const listed: TableSource[] = [];
  for (const row of table.rows)
    for (const column of table.columns)
      for (const source of row.cells[column.key]?.sources ?? []) {
        const key = sourceKey(source);
        if (numbers.has(key)) continue;
        listed.push(source);
        numbers.set(key, listed.length);
      }
  return (
    <div className="result-table">
      <div className="result-table-scroll">
        <Table data-size="sm" border zebra>
          <caption>{table.title ?? t('resultTable.result')}</caption>
          <Table.Head>
            <Table.Row>
              {table.columns.map((c) => (
                <Table.HeaderCell key={c.key}>{c.label}</Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {table.rows.map((row, i) => (
              <Table.Row key={i}>
                {table.columns.map((c) => {
                  const cell = row.cells[c.key];
                  return (
                    <Table.Cell key={c.key}>
                      {cellText(cell?.value)}
                      {(cell?.sources ?? []).map((s) => {
                        const n = numbers.get(sourceKey(s)) ?? 0;
                        const label = t('resultTable.sourceN', { n, name: sourceName(s, t) });
                        const url = linkOf(s);
                        return (
                          <sup key={n} className="cell-source">
                            {url ? (
                              <a href={url} aria-label={label}>
                                [{n}]
                              </a>
                            ) : (
                              <span aria-label={label} title={sourceName(s, t)}>
                                [{n}]
                              </span>
                            )}
                          </sup>
                        );
                      })}
                    </Table.Cell>
                  );
                })}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      {listed.length ? (
        <div>
          <span className="playground-strong">{t('resultTable.sources')}</span>
          <ol className="playground-table-sources">
            {listed.map((s, i) => {
              const url = linkOf(s);
              return (
                <li key={i}>
                  {url ? <Link href={url}>{sourceName(s, t)}</Link> : sourceName(s, t)}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      {table.skipped.length ? (
        <p className="result-table-skipped">
          {t('resultTable.skipped', {
            names: table.skipped
              .map((s) =>
                s.document ? sourceName(s.document, t) : t('resultTable.item', { n: s.index + 1 }),
              )
              .join(', '),
          })}
        </p>
      ) : null}
      {csv ? (
        <Link
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`}
          download={`${table.title ?? t('resultTable.fileName')}.csv`}
        >
          {t('resultTable.download')}
        </Link>
      ) : null}
    </div>
  );
};
