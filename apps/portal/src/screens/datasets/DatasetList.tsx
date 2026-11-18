import { PlusIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Chip,
  Fieldset,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { parseRoute } from '../../hooks';
import { Icon } from '../../components/Icon';
import { statusColors, statusKeys, type DatasetStatus } from '../../data/datasets';
import { navigate } from '../../hooks';
import { useT, type T } from '../../i18n';
import { datasetHref } from './model';

const filters = ['all', 'own', 'shared', 'attention'] as const;
type ListFilter = (typeof filters)[number];

const filterKeys = {
  all: 'datasets.filterAll',
  own: 'datasets.filterOwn',
  shared: 'datasets.filterShared',
  attention: 'datasets.filterAttention',
} as const;

export const needsAttention = (d: { status: DatasetStatus; needsSource?: boolean }) =>
  d.status === 'Feilet' || d.status === 'Delvis lest inn' || d.needsSource === true;

export const matchesFilter = (
  filter: ListFilter,
  d: Pick<DatasetListItem, 'status' | 'shared' | 'needsSource'>,
) =>
  filter === 'all' ||
  (filter === 'own' && !d.shared) ||
  (filter === 'shared' && d.shared) ||
  (filter === 'attention' && needsAttention(d));

const filterIn = (value: string | null): ListFilter => filters.find((f) => f === value) ?? 'all';

const fromAddress = () => {
  const query = parseRoute(window.location.hash).query;
  return { query: query.get('q') ?? '', filter: filterIn(query.get('filter')) };
};

const keepInAddress = (query: string, filter: ListFilter) => {
  const route = parseRoute(window.location.hash);
  const params = new URLSearchParams(route.query);
  if (query) params.set('q', query);
  else params.delete('q');
  if (filter === 'all') params.delete('filter');
  else params.set('filter', filter);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `#${route.path}${search ? `?${search}` : ''}`,
  );
};

export interface DatasetListItem {
  id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  shared: boolean;
  sourceText: string;
  docsText: string;
  lastText: string;
  subText?: string;
  note?: string;
  needsSource?: boolean;
  canRetry?: boolean;
  usedByText?: string | undefined;
}

const noMatchText = (t: T, total: number, query: string, filter: ListFilter) => {
  const label = t(filterKeys[filter]);
  if (query && filter !== 'all')
    return t('datasets.noMatchBoth', { count: total, query, filter: label });
  if (query) return t('datasets.noMatchQuery', { count: total, query });
  return t('datasets.noMatchFilter', { count: total, filter: label });
};

export const DatasetList = ({
  datasets,
  canCreate = true,
  onRetry,
  pending = false,
}: {
  datasets: DatasetListItem[];
  canCreate?: boolean;
  onRetry?: (id: string) => Promise<void>;
  pending?: boolean;
}) => {
  const t = useT();
  const [{ query, filter }, setView] = useState(fromAddress);
  const [retrying, setRetrying] = useState<string[]>([]);
  const [retryFailure, setRetryFailure] = useState('');
  useEffect(() => {
    const follow = () => {
      if (parseRoute(window.location.hash).path === '/datasets') setView(fromAddress());
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const show = (next: { query: string; filter: ListFilter }) => {
    setView(next);
    keepInAddress(next.query, next.filter);
  };
  const q = query.trim().toLowerCase();
  const rows = datasets.filter(
    (d) =>
      matchesFilter(filter, d) &&
      (!q || `${d.name} ${d.description} ${d.sourceText}`.toLowerCase().includes(q)),
  );
  const attention = datasets.filter(needsAttention).length;
  const showUse = datasets.some((d) => d.usedByText !== undefined);
  const filtered = q !== '' || filter !== 'all';

  const retry = async (d: DatasetListItem) => {
    if (!onRetry || retrying.includes(d.id)) return;
    setRetryFailure('');
    setRetrying((ids) => [...ids, d.id]);
    try {
      await onRetry(d.id);
    } catch (error) {
      setRetryFailure(
        t('datasets.retryFailed', {
          name: d.name,
          problem: error instanceof Error && error.message ? error.message : '',
        }).trim(),
      );
    } finally {
      setRetrying((ids) => ids.filter((id) => id !== d.id));
    }
  };

  return (
    <div className="stack dataset-page">
      <div className="page-head">
        <div className="page-head-text">
          <Heading level={1} data-size="lg">
            {t('datasets.title')}
          </Heading>
          <p className="lead">{t('datasets.lead')}</p>
        </div>
        {canCreate ? (
          <Button variant="primary" onClick={() => navigate('/datasets/new')}>
            <Icon icon={PlusIcon} />
            {t('datasets.new')}
          </Button>
        ) : null}
      </div>
      <form role="search" className="dataset-filters" onSubmit={(e) => e.preventDefault()}>
        <Textfield
          className="dataset-search"
          label={t('datasets.search')}
          type="search"
          value={query}
          onChange={(e) => show({ query: e.target.value, filter })}
        />
        <Fieldset>
          <Fieldset.Legend>{t('datasets.showLegend')}</Fieldset.Legend>
          <div className="tag-row">
            {filters.map((f) => (
              <Chip.Radio
                key={f}
                name="datasetfilter"
                checked={filter === f}
                onChange={() => show({ query, filter: f })}
              >
                {f === 'attention'
                  ? t('datasets.filterAttentionCount', { count: attention })
                  : t(filterKeys[f])}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
      </form>
      <p role="status" className="meta count">
        {filtered
          ? t('datasets.showing', { shown: rows.length, total: datasets.length })
          : t('datasets.countAll', { count: datasets.length })}
      </p>
      {retryFailure ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {retryFailure}
        </Alert>
      ) : null}
      {rows.length > 0 ? (
        <div className="table-scroll" role="region" aria-label={t('datasets.title')} tabIndex={0}>
          <Table
            className="dataset-table"
            aria-label={t('datasets.title')}
            aria-busy={pending || undefined}
          >
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('datasets.columnDataset')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('datasets.columnStatus')}</TableHeaderCell>
                <TableHeaderCell scope="col" className="numeric right">
                  {t('datasets.factDocuments')}
                </TableHeaderCell>
                <TableHeaderCell scope="col">{t('datasets.columnLastStarted')}</TableHeaderCell>
                {showUse ? (
                  <TableHeaderCell scope="col">{t('datasetUse.label')}</TableHeaderCell>
                ) : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((d) => {
                const busy = retrying.includes(d.id);
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="dataset-cell-name">
                        <a className="dataset-row-name" href={datasetHref(d.id)}>
                          {d.name}
                        </a>
                        <span className="meta">{d.subText ?? d.sourceText}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="dataset-cell-status">
                        <span className="row-wrap">
                          <Tag data-size="sm" data-color={statusColors[d.status]}>
                            {t(statusKeys[d.status])}
                          </Tag>
                          {d.canRetry && onRetry ? (
                            <Button
                              variant="secondary"
                              data-size="sm"
                              aria-label={t('datasets.retryNamed', { name: d.name })}
                              aria-disabled={busy || undefined}
                              onClick={() => void retry(d)}
                            >
                              {busy ? t('datasets.starting') : t('common.tryAgain')}
                            </Button>
                          ) : null}
                        </span>
                        {d.note ? <span className="meta">{d.note}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell className="numeric right">{d.docsText}</TableCell>
                    <TableCell>{d.lastText}</TableCell>
                    {showUse ? (
                      <TableCell
                        className={d.usedByText === t('datasetUse.none') ? 'meta' : undefined}
                      >
                        {d.usedByText}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="dataset-no-rows">
          <Heading level={2} data-size="xs">
            {t('datasets.noMatch')}
          </Heading>
          <Paragraph data-size="sm">
            {noMatchText(t, datasets.length, query.trim(), filter)}
          </Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => show({ query: '', filter: 'all' })}
          >
            {t('datasets.resetFilters')}
          </Button>
        </div>
      )}
    </div>
  );
};
