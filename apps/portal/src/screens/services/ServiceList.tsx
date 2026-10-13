import {
  Button,
  Chip,
  Heading,
  Link,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { Icon, icons } from '../../components/Icon';
import { statusColor, type JobId, type ServiceRow, type ServiceStatus } from '../../data/services';
import { useT, type PlainKey } from '../../i18n';
import { navigate } from '../../hooks';
import { needsRight, useRights } from '../../Shell';
import { EmptyState } from '../../states';

const statusKey = {
  Utkast: 'serviceList.statusDraft',
  'I test': 'serviceList.statusTest',
  'I bruk': 'serviceList.statusLive',
  'Satt på pause': 'serviceList.statusPaused',
  Arkivert: 'serviceList.statusArchived',
} as const satisfies Record<ServiceStatus, PlainKey>;

const jobKey = {
  answers: 'serviceList.jobAnswers',
  drafts: 'serviceList.jobDrafts',
  rewrites: 'serviceList.jobRewrites',
  summarises: 'serviceList.jobSummarises',
  extracts: 'serviceList.jobExtracts',
  sorts: 'serviceList.jobSorts',
  prepares: 'serviceList.jobPrepares',
  transcribes: 'serviceList.jobTranscribes',
} as const satisfies Record<JobId, PlainKey>;

const filters: ('alle' | ServiceStatus)[] = [
  'alle',
  'Utkast',
  'I test',
  'I bruk',
  'Satt på pause',
  'Arkivert',
];

export const ServiceList = ({ rows, tenantName }: { rows: ServiceRow[]; tenantName: string }) => {
  const t = useT();
  const canCreate = useRights().has('manage-services');
  return (
    <div className="services-page">
      <div className="services-head">
        <div className="services-intro">
          <Heading level={1} data-size="lg">
            {t('serviceList.title')}
          </Heading>
          <p className="lead">{t('serviceList.lead', { tenant: tenantName })}</p>
        </div>
        {canCreate ? (
          <Button variant="primary" onClick={() => navigate('/services/new')}>
            <Icon d={icons.plus} />
            {t('serviceList.create')}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t('serviceList.emptyTitle')}>
          <Paragraph>{t('serviceList.emptyBody', { tenant: tenantName })}</Paragraph>
          {canCreate ? (
            <Button variant="primary" data-size="sm" onClick={() => navigate('/services/new')}>
              {t('serviceList.createFirst')}
            </Button>
          ) : (
            <Paragraph data-size="sm">{needsRight('manage-services', t)}</Paragraph>
          )}
        </EmptyState>
      ) : (
        <ServiceRows rows={rows} />
      )}
    </div>
  );
};

const ServiceRows = ({ rows }: { rows: ServiceRow[] }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number]>('alle');
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'alle' ? r.status !== 'Arkivert' : r.status === filter) &&
      (!q || `${r.name} ${r.purpose}`.toLowerCase().includes(q)),
  );
  return (
    <>
      <div className="services-filters">
        <Textfield
          className="services-search"
          label={t('serviceList.searchLabel')}
          type="search"
          placeholder={t('serviceList.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <fieldset className="chip-fieldset">
          <legend className="ds-label">{t('serviceList.statusLegend')}</legend>
          <div className="tag-row">
            {filters.map((f) => (
              <Chip.Radio
                key={f}
                name="statusfilter"
                checked={filter === f}
                onChange={() => setFilter(f)}
              >
                {f === 'alle' ? t('serviceList.filterAll') : t(statusKey[f])}
              </Chip.Radio>
            ))}
          </div>
        </fieldset>
      </div>
      <p aria-live="polite" className="meta services-count">
        {t('serviceList.showing', { shown: shown.length, total: rows.length })}
      </p>
      {shown.length > 0 ? (
        <ul className="plain-list services-rows">
          {shown.map((r) => (
            <li key={r.id}>
              <div className="services-row-main">
                <div className="tag-row">
                  <Link href={`#/services/${encodeURIComponent(r.id)}`} className="services-name">
                    {r.name}
                  </Link>
                  <Tag data-size="sm" data-color={statusColor[r.status]}>
                    {t(statusKey[r.status])}
                  </Tag>
                </div>
                <span className="services-purpose">{r.purpose}</span>
              </div>
              <dl className="kv services-row-kv">
                <dt>{t('serviceList.job')}</dt>
                <dd>
                  <Tag data-size="sm" data-color="accent">
                    {t(jobKey[r.job])}
                  </Tag>
                </dd>
                <dt>{t('serviceList.start')}</dt>
                <dd className="tag-row">
                  {r.start.map((s) => (
                    <Tag key={s} data-size="sm" data-color="neutral">
                      {s}
                    </Tag>
                  ))}
                </dd>
              </dl>
              <div className="services-row-usage">
                <span className="services-usage numeric">{r.usage}</span>
                <span className="meta">{t('serviceList.perWeek', { unit: r.unit })}</span>
                <span className="meta">{t('serviceList.changed', { when: r.when, by: r.by })}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="state empty">
          <Paragraph>
            <strong>{t('serviceList.noMatch')}</strong>
          </Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              setQuery('');
              setFilter('alle');
            }}
          >
            {t('serviceList.reset')}
          </Button>
        </div>
      )}
    </>
  );
};
