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
import { Icon, icons } from '../../components/Icon';
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

const filters = ['alle', 'Klar', 'Innlesing pågår', 'Delvis lest inn', 'Feilet'] as const;

export const matchesFilter = (filter: (typeof filters)[number], status: DatasetStatus) =>
  filter === 'alle' || status === filter || (filter === 'Klar' && status === 'Utenfor plattformen');

export const sourceOf = (t: T, d: DatasetDetails) =>
  d.source === 'shared' && d.owner
    ? t('datasets.sharedBy', { owner: d.owner })
    : t(sourceKeys[d.source]);

export interface DatasetListItem {
  id: string;
  name: string;
  description: string;
  status: DatasetStatus;
  sourceText: string;
  docsText: string;
  lastText: string;
}

export const listItemFor = (t: T, f: Format, d: DatasetDetails): DatasetListItem => ({
  id: d.id,
  name: d.name,
  description: d.description,
  status: d.status,
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
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number]>('alle');
  const q = query.trim().toLowerCase();
  const rows = datasets.filter(
    (d) =>
      matchesFilter(filter, d.status) &&
      (!q || `${d.name} ${d.description}`.toLowerCase().includes(q)),
  );
  const failing = datasets.filter((d) => d.status === 'Feilet' || d.status === 'Delvis lest inn');

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
            <Icon d={icons.plus} />
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
          <Fieldset.Legend>{t('datasets.statusLegend')}</Fieldset.Legend>
          <div className="tag-row">
            {filters.map((f) => (
              <Chip.Radio
                key={f}
                name="statusfilter"
                checked={filter === f}
                onChange={() => setFilter(f)}
              >
                {f === 'alle' ? t('datasets.filterAll') : t(statusKeys[f])}
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
              setQuery('');
              setFilter('alle');
            }}
          >
            {t('datasets.resetFilters')}
          </Button>
        </div>
      )}
    </div>
  );
};
