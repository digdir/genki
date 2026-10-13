import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Details,
  Dialog,
  Fieldset,
  Heading,
  Pagination,
  Paragraph,
  Radio,
  Select,
  Switch,
  Tag,
  usePagination,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useState } from 'react';
import { useNarrow } from '../hooks';
import { useT } from '../i18n';
import {
  cellText,
  sourceName as nameOf,
  type ResultTable,
  type TableColumn,
  type TableSource,
} from '../ResultTable';
import type { CellEdit, TableReview } from '../types';

const skipReason = (t: ReturnType<typeof useT>, code: string | undefined) =>
  code === 'invalid_json'
    ? t('table.failInvalidJson')
    : code === 'output_truncated'
      ? t('table.failOutputTruncated')
      : code === 'missing_fields'
        ? t('table.failMissingFields')
        : t('table.readFailed');

export interface TableEntry {
  key: string;
  task?: string;
  serviceName: string;
  createdAt?: string;
  serviceRef?: string;
  inputs: { label: string; value: string }[];
  input?: Record<string, unknown>;
  table: ResultTable;
  csv?: string;
}

export interface TableActions {
  load?: (signal: AbortSignal) => Promise<TableReview>;
  save?: (edits: CellEdit[]) => Promise<TableReview>;
  approve?: () => Promise<TableReview>;
}

interface Props {
  entry: TableEntry;
  actions: TableActions;
  userName: string;
  logUrl?: string;
  onFlash: (text: string) => void;
}

type Approval = TableReview['approval'];
type TagColor = 'success' | 'warning' | 'danger' | 'neutral';

const perPage = 50;
const valueColors: TagColor[] = ['success', 'warning', 'danger'];

const colorOf = (column: TableColumn, value: string): TagColor => {
  const index = column.values?.indexOf(value) ?? -1;
  return valueColors[index] ?? 'neutral';
};

const editKey = (row: number, column: string) => `${row}/${column}`;

const csvCell = (value: string) =>
  /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const csvLine = (cells: string[]) => cells.map(csvCell).join(';');

const download = (name: string, text: string) => {
  const link = document.createElement('a');
  link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${text}`)}`;
  link.download = name;
  link.click();
};

interface OpenSource {
  cell: string;
  n: number;
  source: TableSource;
}

export const TableResult = ({ entry, actions, userName, logUrl, onFlash }: Props) => {
  const t = useT();
  const f = useFormat();
  const when = (at: string) => f.dateTime(at);
  const sourceName = (s: TableSource) => nameOf(s, t('table.csvSource'));
  const { table } = entry;
  const narrow = useNarrow();
  const [edits, setEdits] = useState<Map<string, TableReview['edits'][number]>>(new Map());
  const [approval, setApproval] = useState<Approval>({ status: 'draft' });
  const [editing, setEditing] = useState<string>();
  const [shownOriginal, setShownOriginal] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<{ column: number; dir: 1 | -1 }>({ column: -1, dir: 1 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<OpenSource>();
  const [exporting, setExporting] = useState(false);
  const [withSources, setWithSources] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!actions.load) return;
    const controller = new AbortController();
    actions.load(controller.signal).then(
      (review) => {
        if (controller.signal.aborted) return;
        setEdits(new Map(review.edits.map((e) => [editKey(e.row, e.column), e])));
        setApproval(review.approval);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [actions.load]);

  const approved = approval.status === 'approved';
  const first = table.columns[0];
  const rated = table.columns.find((c) => c.values?.length);
  const shownColumns = table.columns.filter((c, i) => i === 0 || !hidden.has(c.key));
  const valueAt = (row: number, column: string) =>
    edits.get(editKey(row, column))?.value ??
    cellText(table.rows[row]?.cells[column]?.value).trim();

  const counts = new Map<string, number>();
  if (rated)
    table.rows.forEach((_, i) => {
      const v = valueAt(i, rated.key);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    });

  const sources = (row: number, column: string) => table.rows[row]?.cells[column]?.sources ?? [];
  const needsSource = (row: number, column: TableColumn, index: number) =>
    index > 0 &&
    (column.values?.length
      ? true
      : column.kind === 'assessment'
        ? false
        : Boolean(valueAt(row, column.key)));
  let missing = 0;
  table.rows.forEach((_, i) =>
    table.columns.forEach((c, j) => {
      if (needsSource(i, c, j) && sources(i, c.key).length === 0) missing += 1;
    }),
  );

  const order = table.rows
    .map((_, i) => i)
    .filter((i) => !rated || filter === 'all' || valueAt(i, rated.key) === filter);
  const sortColumn = table.columns[sort.column];
  if (sortColumn)
    order.sort(
      (a, b) =>
        valueAt(a, sortColumn.key).localeCompare(valueAt(b, sortColumn.key), f.locale, {
          numeric: true,
        }) * sort.dir,
    );
  const pages = Math.max(1, Math.ceil(order.length / perPage));
  const current = Math.min(page, pages);
  const visible = order.slice((current - 1) * perPage, current * perPage);
  const pagination = usePagination({
    currentPage: current,
    totalPages: pages,
    showPages: 7,
    setCurrentPage: setPage,
  });

  const rowLabel = (row: number) =>
    first ? valueAt(row, first.key) : t('table.row', { n: row + 1 });
  const countText = (value: string, n: number) =>
    t('table.countValue', { count: n, value: (value || t('table.noValue')).toLowerCase() });
  const summary = rated
    ? t('table.rowsSummary', {
        count: table.rows.length,
        breakdown: [...counts].map(([value, n]) => countText(value, n)).join(', '),
      })
    : t('table.rows', { count: table.rows.length });

  const persist = async (next: Map<string, TableReview['edits'][number]>) => {
    setEdits(next);
    if (!actions.save) return;
    try {
      const review = await actions.save(
        [...next.values()].map(({ row, column, value }) => ({ row, column, value })),
      );
      setEdits(new Map(review.edits.map((e) => [editKey(e.row, e.column), e])));
    } catch {
      setError(t('table.notSaved'));
    }
  };

  const edit = (row: number, column: string, value: string) => {
    const next = new Map(edits);
    const original = cellText(table.rows[row]?.cells[column]?.value).trim();
    if (value === original) next.delete(editKey(row, column));
    else next.set(editKey(row, column), { row, column, value, original });
    void persist(next);
  };

  const approve = async () => {
    if (busy || approved) return;
    setBusy(true);
    setError('');
    try {
      const review = actions.approve
        ? await actions.approve()
        : { approval: { status: 'approved' as const, at: new Date().toISOString() } };
      setApproval(review.approval);
      onFlash(t('table.approvedFlash'));
    } catch {
      setError(t('table.notApproved'));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    const title = table.title ?? t('table.fileName');
    const mark = approved ? '' : t('table.draftMark');
    download(
      `${title}${mark}.csv`,
      [
        csvLine(shownColumns.map((c) => c.label)),
        ...order.map((row) => csvLine(shownColumns.map((c) => valueAt(row, c.key)))),
      ].join('\r\n'),
    );
    if (withSources)
      download(
        t('table.sourcesFile', { title, mark }),
        [
          csvLine([
            t('table.csvRow'),
            t('table.csvColumn'),
            t('table.csvSource'),
            t('table.csvDocument'),
            t('table.csvExcerpt'),
            t('table.csvPage'),
            t('table.csvVersion'),
            t('table.csvLink'),
          ]),
          ...order.flatMap((row, position) =>
            shownColumns.flatMap((c) =>
              sources(row, c.key).map((s, n) =>
                csvLine([
                  String(position + 1),
                  c.label,
                  String(n + 1),
                  sourceName(s),
                  s.excerpt ?? '',
                  s.page === undefined ? '' : String(s.page),
                  s.version ?? '',
                  s.url ?? '',
                ]),
              ),
            ),
          ),
        ].join('\r\n'),
      );
    setExporting(false);
    onFlash(withSources ? t('table.downloadedWithSources') : t('table.downloaded'));
  };

  const cell = (row: number, column: TableColumn, index: number) => {
    const key = editKey(row, column.key);
    const value = valueAt(row, column.key);
    const changed = edits.get(key);
    const list = sources(row, column.key);
    const label = rowLabel(row);
    return (
      <>
        {column.values?.length && value ? (
          <Tag data-size="sm" data-color={colorOf(column, value)}>
            {value}
          </Tag>
        ) : column.kind === 'document' && value ? (
          <span className="cell-quote">{value}</span>
        ) : column.kind === 'document' ? (
          <span>{t('table.noMention')}</span>
        ) : (
          <span>{value}</span>
        )}
        <span className="cell-meta">
          {list.map((s, n) => (
            <button
              key={n}
              type="button"
              className="source-pill"
              aria-label={t('table.sourceFor', { n: n + 1, row: label, source: sourceName(s) })}
              onClick={() =>
                setOpen({ cell: `${label}, ${column.label.toLowerCase()}`, n: n + 1, source: s })
              }
            >
              {n + 1}
            </button>
          ))}
          {needsSource(row, column, index) && list.length === 0 ? (
            <Tag data-size="sm" data-color="warning">
              {t('table.noSource')}
            </Tag>
          ) : null}
          {changed ? (
            <>
              <Tag data-size="sm" data-color="info">
                {changed.byName && changed.byName !== userName
                  ? t('table.changedBy', { name: changed.byName })
                  : t('table.changedByYou')}
              </Tag>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  setShownOriginal((s) => {
                    const next = new Set(s);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {shownOriginal.has(key) ? t('table.hideOriginal') : t('table.showOriginal')}
              </button>
            </>
          ) : null}
          {column.values?.length && !approved && editing !== key ? (
            <button
              type="button"
              className="link-button"
              aria-label={t('table.changeFor', { column: column.label.toLowerCase(), row: label })}
              onClick={() => setEditing(key)}
            >
              {t('table.change')}
            </button>
          ) : null}
        </span>
        {changed && shownOriginal.has(key) ? (
          <span className="cell-original">
            {t('table.original', { value: cellText(table.rows[row]?.cells[column.key]?.value) })}
          </span>
        ) : null}
        {editing === key ? (
          <span className="cell-edit">
            <Select
              data-size="sm"
              aria-label={t('table.changeFor', { column: column.label.toLowerCase(), row: label })}
              value={value}
              onChange={(e) => edit(row, column.key, e.target.value)}
            >
              {(column.values ?? []).map((v) => (
                <Select.Option key={v} value={v}>
                  {v}
                </Select.Option>
              ))}
            </Select>
            <Button variant="tertiary" data-size="sm" onClick={() => setEditing(undefined)}>
              {t('table.done')}
            </Button>
          </span>
        ) : null}
      </>
    );
  };

  const kindTag = (column: TableColumn) =>
    column.kind === 'assessment' ? (
      <Tag data-size="sm" data-color="warning">
        {t('table.aiAssessment')}
      </Tag>
    ) : column.kind === 'document' ? (
      <Tag data-size="sm" data-color="neutral">
        {t('table.fromDocument')}
      </Tag>
    ) : null;

  const failed = table.skipped.map((s) => ({
    label: s.document ? sourceName(s.document) : t('table.element', { n: s.index + 1 }),
    error: skipReason(t, s.code),
  }));

  return (
    <div className="table-page">
      <div className="page-head">
        <Heading level={1} data-size="md">
          {table.title ?? t('table.result')}
        </Heading>
        <Paragraph className="subtle">
          {[entry.serviceName, ...(entry.createdAt ? [when(entry.createdAt)] : [])].join(' · ')}
        </Paragraph>
      </div>
      {approval.status === 'approved' ? (
        <Alert data-color="success" data-size="sm">
          {t('table.approvedBy', { name: approval.byName ?? userName, when: when(approval.at) })}
        </Alert>
      ) : (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t.rich('table.draftNotice', { strong: (c) => <strong>{c}</strong> })}
            {table.columns.some((c) => c.kind) ? t('table.draftNoticeKinds') : ''}
          </Paragraph>
        </Alert>
      )}
      {entry.inputs.length ? (
        <dl className="inline-facts">
          {entry.inputs.map((x) => (
            <div key={x.label}>
              <dt>{x.label}:</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p aria-live="polite" className="table-summary">
        {summary}
      </p>
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="table-tools">
        {rated ? (
          <fieldset className="chip-filter">
            <legend className="visually-hidden">
              {t('table.filterOn', { column: rated.label.toLowerCase() })}
            </legend>
            <Chip.Radio
              name="table-filter"
              checked={filter === 'all'}
              onChange={() => {
                setFilter('all');
                setPage(1);
              }}
            >
              {t('table.all')}
            </Chip.Radio>
            {[...counts].map(([value, n]) => (
              <Chip.Radio
                key={value}
                name="table-filter"
                checked={filter === value}
                onChange={() => {
                  setFilter(value);
                  setPage(1);
                }}
              >
                {countText(value, n)}
              </Chip.Radio>
            ))}
          </fieldset>
        ) : (
          <span />
        )}
        <div className="actions">
          {missing ? (
            <Tag data-size="sm" data-color="warning">
              {t('table.missingSources', { count: missing })}
            </Tag>
          ) : null}
          <div className="popover-anchor">
            <Button
              variant="secondary"
              data-size="sm"
              aria-expanded={columnsOpen}
              onClick={() => setColumnsOpen((o) => !o)}
            >
              {t('table.showColumns')}
            </Button>
            {columnsOpen ? (
              <Fieldset data-size="sm" className="columns-menu">
                <Fieldset.Legend>{t('table.columns')}</Fieldset.Legend>
                {table.columns.map((c, i) => (
                  <Checkbox
                    key={c.key}
                    label={c.label}
                    checked={i === 0 || !hidden.has(c.key)}
                    disabled={i === 0}
                    onChange={() =>
                      setHidden((h) => {
                        const next = new Set(h);
                        if (next.has(c.key)) next.delete(c.key);
                        else next.add(c.key);
                        return next;
                      })
                    }
                  />
                ))}
              </Fieldset>
            ) : null}
          </div>
          <Button variant="secondary" data-size="sm" onClick={() => setExporting(true)}>
            {t('table.download')}
          </Button>
          {approved ? null : (
            <Button data-size="sm" aria-disabled={busy || undefined} onClick={() => void approve()}>
              {t('table.approve')}
            </Button>
          )}
        </div>
      </div>
      {narrow ? (
        <ul className="table-cards">
          {visible.map((row) => (
            <li key={row}>
              <dl>
                {shownColumns.map((c, j) => (
                  <div key={c.key}>
                    <dt>
                      {c.label} {c.kind === 'assessment' ? kindTag(c) : null}
                    </dt>
                    <dd>{cell(row, c, j)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
          {failed.map((f) => (
            <li key={f.label}>
              <p className="strong">{f.label}</p>
              <p>{f.error}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={table.title ?? t('table.result')}
          className="table-scroll"
        >
          <table className="ds-table result-grid" data-size="sm">
            <thead>
              <tr>
                {shownColumns.map((c) => {
                  const index = table.columns.indexOf(c);
                  const sorted = sort.column === index;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={sorted ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                    >
                      <span className="th-stack">
                        {kindTag(c)}
                        <button
                          type="button"
                          className="sort-button"
                          onClick={() =>
                            setSort((s) => ({
                              column: index,
                              dir: s.column === index ? (s.dir === 1 ? -1 : 1) : 1,
                            }))
                          }
                        >
                          {c.label}
                          <span aria-hidden="true">
                            {sorted ? (sort.dir === 1 ? '↑' : '↓') : ''}
                          </span>
                        </button>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row}>
                  {shownColumns.map((c, j) => (
                    <td key={c.key} className={j === 0 ? 'row-head' : undefined}>
                      {cell(row, c, j)}
                    </td>
                  ))}
                </tr>
              ))}
              {failed.map((f) => (
                <tr key={f.label}>
                  <td className="row-head">{f.label}</td>
                  <td colSpan={Math.max(1, shownColumns.length - 1)}>
                    <span className="cell-meta">
                      <Tag data-size="sm" data-color="danger">
                        {t('table.failed')}
                      </Tag>
                      <span>{f.error}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <>
          <Pagination aria-label={t('table.pages')}>
            <Pagination.List>
              <Pagination.Item>
                <Pagination.Button
                  aria-label={t('table.previousPage')}
                  {...pagination.prevButtonProps}
                >
                  {t('table.previous')}
                </Pagination.Button>
              </Pagination.Item>
              {pagination.pages.map(({ page: p, itemKey, buttonProps }) => (
                <Pagination.Item key={itemKey}>
                  {typeof p === 'number' ? (
                    <Pagination.Button aria-label={t('table.page', { n: p })} {...buttonProps}>
                      {p}
                    </Pagination.Button>
                  ) : (
                    p
                  )}
                </Pagination.Item>
              ))}
              <Pagination.Item>
                <Pagination.Button aria-label={t('table.nextPage')} {...pagination.nextButtonProps}>
                  {t('table.next')}
                </Pagination.Button>
              </Pagination.Item>
            </Pagination.List>
          </Pagination>
          <Paragraph data-size="sm" className="subtle-sm">
            {t('table.showing', {
              from: (current - 1) * perPage + 1,
              to: Math.min(order.length, current * perPage),
              total: order.length,
            })}
          </Paragraph>
        </>
      ) : null}
      {entry.task ? (
        <Details data-size="sm" aria-label={t('table.showApiCall')}>
          <Details.Summary>{t('table.showApiCall')}</Details.Summary>
          <Details.Content>
            <code className="api-line">
              GET /tenants/&#123;tenant&#125;/tasks/{entry.task}/review
            </code>
            <pre className="api-body">
              {`PUT  …/review/edits   { "edits": [{ "row": 0, "column": "${rated?.key ?? t('table.apiColumn')}", "value": "…" }] }\nPOST …/review/approve`}
            </pre>
          </Details.Content>
        </Details>
      ) : null}
      <Dialog
        open={open !== undefined}
        onClose={() => setOpen(undefined)}
        placement="right"
        closedby="any"
        closeButton={t('table.close')}
        aria-labelledby={open ? 'source-panel-h' : undefined}
        className="source-panel"
      >
        {open ? (
          <div className="stack-sm">
            <span className="subtle-sm">{open.cell}</span>
            <Heading level={2} data-size="xs" id="source-panel-h">
              {t('table.source', { n: open.n })}
            </Heading>
            {open.source.excerpt ? (
              <blockquote className="source-quote">{open.source.excerpt}</blockquote>
            ) : null}
            <dl className="facts">
              <dt>{t('table.document')}</dt>
              <dd>{sourceName(open.source)}</dd>
              {open.source.headers?.length ? (
                <>
                  <dt>{t('table.location')}</dt>
                  <dd>{open.source.headers.join(' › ')}</dd>
                </>
              ) : null}
              {open.source.page !== undefined ? (
                <>
                  <dt>{t('table.pageLabel')}</dt>
                  <dd>{open.source.page}</dd>
                </>
              ) : null}
              {open.source.publishedAt ? (
                <>
                  <dt>{t('table.published')}</dt>
                  <dd>{f.date(open.source.publishedAt)}</dd>
                </>
              ) : null}
              {open.source.version ? (
                <>
                  <dt>{t('table.version')}</dt>
                  <dd>{open.source.version}</dd>
                </>
              ) : null}
            </dl>
            {open.source.url ? (
              <a href={open.source.url} target="_blank" rel="noopener noreferrer">
                {t('table.openDocument')}
              </a>
            ) : null}
            {logUrl ? <a href={logUrl}>{t('table.seeRun')}</a> : null}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={exporting}
        onClose={() => setExporting(false)}
        closeButton={t('table.close')}
        aria-labelledby="export-h"
      >
        <div className="stack-sm">
          <Heading level={2} data-size="xs" id="export-h">
            {t('table.downloadHeading')}
          </Heading>
          <Fieldset data-size="sm">
            <Fieldset.Legend>{t('table.format')}</Fieldset.Legend>
            <Radio
              name="export-format"
              label="CSV"
              description={t('table.csvDescription')}
              checked
              readOnly
            />
          </Fieldset>
          <Switch
            label={t('table.includeSources')}
            checked={withSources}
            onChange={(e) => setWithSources(e.target.checked)}
          />
          {approved ? null : <Paragraph data-size="sm">{t('table.notApprovedExport')}</Paragraph>}
          <div className="actions">
            <Button onClick={exportCsv}>{t('table.download')}</Button>
            <Button variant="secondary" onClick={() => setExporting(false)}>
              {t('table.cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};
