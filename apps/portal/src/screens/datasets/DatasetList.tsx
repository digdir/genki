import { PlusIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Chip,
  Fieldset,
  Heading,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { parseRoute } from '../../hooks';
import { Icon } from '../../components/Icon';
import {
  sourceKeys,
  statusColors,
  statusKeys,
  type DatasetDetails,
  type DatasetStatus,
} from '../../data/datasets';
import { navigate } from '../../hooks';
import { useT, type Format, type T } from '../../i18n';
import { count, datasetHref } from './model';

const filters = ['all', 'own', 'shared', 'attention'] as const;
type ListFilter = (typeof filters)[number];

const filterKeys = {
  all: 'datasets.filterAll',
  own: 'datasets.filterOwn',
  shared: 'datasets.filterShared',
  attention: 'datasets.filterAttention',
} as const;

const needsAttention = (status: DatasetStatus) =>
  status === 'Feilet' || status === 'Delvis lest inn';

export const matchesFilter = (filter: ListFilter, d: Pick<DatasetListItem, 'status' | 'shared'>) =>
  filter === 'all' ||
  (filter === 'own' && !d.shared) ||
  (filter === 'shared' && d.shared) ||
  (filter === 'attention' && needsAttention(d.status));

const filterIn = (value: string | null): ListFilter => filters.find((f) => f === value) ?? 'all';

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

export const sourceOf = (t: T, d: DatasetDetails) =>
  d.source === 'shared' && d.owner
    ? t('datasets.sharedBy', { owner: d.owner })
    : t(sourceKeys[d.source]);

export interface DatasetListItem {
  id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  shared: boolean;
  sourceText: string;
  docsText: string;
  lastText: string;
}

export const listItemFor = (t: T, f: Format, d: DatasetDetails): DatasetListItem => ({
  id: d.id,
  name: d.name,
  description: d.description,
  status: d.status,
  shared: d.source === 'shared',
  sourceText: sourceOf(t, d),
  docsText: count(f, d.docs),
  lastText:
    d.status === 'Feilet'
      ? t('datasets.lastFailed', { last: d.last, lastOk: d.lastOk.toLowerCase() })
      : d.last,
});

export const DatasetList = ({
  datasets,
  canCreate = true,
}: {
  datasets: DatasetListItem[];
  canCreate?: boolean;
}) => {
  const t = useT();
  const [query, setQueryState] = useState(
    () => parseRoute(window.location.hash).query.get('q') ?? '',
  );
  const [filter, setFilterState] = useState<ListFilter>(() =>
    filterIn(parseRoute(window.location.hash).query.get('filter')),
  );
  const setQuery = (next: string) => {
    setQueryState(next);
    keepInAddress(next, filter);
  };
  const setFilter = (next: ListFilter) => {
    setFilterState(next);
    keepInAddress(query, next);
  };
  const q = query.trim().toLowerCase();
  const rows = datasets.filter(
    (d) =>
      matchesFilter(filter, d) &&
      (!q || `${d.name} ${d.description} ${d.sourceText}`.toLowerCase().includes(q)),
  );
  const failing = datasets.filter((d) => needsAttention(d.status));

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
      {failing.length > 0 ? (
        <Alert data-color="warning">
          {t('datasets.needFollowUp', {
            count: failing.length,
            names: failing.map((d) => d.name).join(t('datasets.nameJoin')),
          })}
        </Alert>
      ) : null}
      <div className="dataset-filters">
        <Textfield
          className="dataset-search"
          label={t('datasets.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Fieldset>
          <Fieldset.Legend>{t('datasets.showLegend')}</Fieldset.Legend>
          <div className="tag-row">
            {filters.map((f) => (
              <Chip.Radio
                key={f}
                name="datasetfilter"
                checked={filter === f}
                onChange={() => setFilter(f)}
              >
                {t(filterKeys[f])}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
      </div>
      <p aria-live="polite" className="meta count">
        {t('datasets.showing', { shown: rows.length, total: datasets.length })}
      </p>
      {rows.length > 0 ? (
        <ul className="dataset-rows" aria-label={t('datasets.title')}>
          {rows.map((d) => (
            <li key={d.id}>
              <div className="dataset-row-main">
                <div className="tag-row">
                  <a className="dataset-row-name" href={datasetHref(d.id)}>
                    {d.name}
                  </a>
                  <Tag data-size="sm" data-color={statusColors[d.status]}>
                    {t(statusKeys[d.status])}
                  </Tag>
                </div>
                <span className="meta dataset-row-desc">{d.description}</span>
              </div>
              <dl className="dataset-row-facts">
                <div>
                  <dt>{t('datasets.factSource')}</dt>
                  <dd>{d.sourceText}</dd>
                </div>
                <div>
                  <dt>{t('datasets.factDocuments')}</dt>
                  <dd className="numeric">{d.docsText}</dd>
                </div>
                <div>
                  <dt>{t('datasets.factLastIngestion')}</dt>
                  <dd>{d.lastText}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dataset-no-rows">
          <span className="dataset-no-rows-title">{t('datasets.noMatch')}</span>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              setQueryState('');
              setFilterState('all');
              keepInAddress('', 'all');
            }}
          >
            {t('datasets.resetFilters')}
          </Button>
        </div>
      )}
    </div>
  );
};
