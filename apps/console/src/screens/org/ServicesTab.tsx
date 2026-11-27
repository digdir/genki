import { useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import type { TenantDefinition } from '../../types';
import { Chip, type Tone } from './parts';

type Status = 'live' | 'paused' | 'unpublished';

export type ServiceDefinition = TenantDefinition & {
  liveVersion?: number | null;
  testVersion?: number | null;
};

const liveOf = (d: ServiceDefinition) =>
  d.liveVersion !== undefined ? d.liveVersion : d.publishedAt ? d.latestVersion : null;

const statusOf = (d: ServiceDefinition): Status =>
  d.state === 'paused' ? 'paused' : liveOf(d) === null ? 'unpublished' : 'live';

const statusLabels: Record<Status, [PlainKey, Tone]> = {
  live: ['org.filterLive', 'success'],
  paused: ['org.filterPaused', 'neutral'],
  unpublished: ['org.filterUnpublished', 'info'],
};

const filters: ['all' | Status, PlainKey][] = [
  ['all', 'org.filterAll'],
  ['live', 'org.filterLive'],
  ['paused', 'org.filterPaused'],
  ['unpublished', 'org.filterUnpublished'],
];

const shortList = 10;

export const ServicesTab = ({ api, tenant }: { api: ApiClient; tenant: string; name: string }) => {
  const t = useT();
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [everything, setEverything] = useState(false);
  const [state, retry] = useAsync(
    async (signal) => {
      const [definitions, usage] = await Promise.all([
        api.tenantDefinitions(tenant, signal) as Promise<ServiceDefinition[]>,
        api.tenantUsage(tenant, 7, signal).catch(() => undefined),
      ]);
      return { definitions, usage };
    },
    [api, tenant],
  );
  if (state.status === 'loading') return <Loading label={t('org.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const services = state.data.definitions.filter((d) => d.kind === 'Service' && !d.internal);
  const errors = new Map(
    (state.data.usage?.byService ?? []).map((s) => [s.service, s.usage.failedRequests]),
  );
  const count = (f: 'all' | Status) =>
    f === 'all' ? services.length : services.filter((s) => statusOf(s) === f).length;
  const chosen = services.filter((s) => filter === 'all' || statusOf(s) === filter);
  const rows = everything ? chosen : chosen.slice(0, shortList);
  const testOf = (d: ServiceDefinition) => {
    if (d.testVersion === undefined) return '';
    if (d.testVersion === null) return t('org.none');
    return d.testVersion === liveOf(d)
      ? t('org.sameAsLive')
      : t('org.edition', { version: d.testVersion });
  };
  return (
    <>
      <div role="group" aria-label={t('org.statusFilter')} className="org-pills">
        {filters.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="org-pill"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {t(label)} {count(key)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="org-subtle">{t('org.noServices')}</p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={t('org.servicesTable')}
          className="org-table-wrap"
        >
          <table className="org-table wide">
            <thead>
              <tr>
                <th scope="col">{t('org.colService')}</th>
                <th scope="col">{t('org.colLive')}</th>
                <th scope="col">{t('org.colTest')}</th>
                <th scope="col">{t('org.colStatus')}</th>
                <th scope="col" className="num">
                  {t('org.colErrors')}
                </th>
                <th scope="col" style={{ paddingRight: 0 }}>
                  {t('org.colRuns')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const [label, tone] = statusLabels[statusOf(d)];
                return (
                  <tr key={d.id}>
                    <td className="medium">{d.name}</td>
                    <td>
                      {(() => {
                        const live = liveOf(d);
                        return live === null ? t('org.none') : t('org.edition', { version: live });
                      })()}
                    </td>
                    <td className="subtle">{testOf(d)}</td>
                    <td>
                      <Chip tone={tone}>{t(label)}</Chip>
                    </td>
                    <td className="num">{errors.get(d.id) ?? 0}</td>
                    <td style={{ paddingRight: 0 }}>
                      <a
                        href={`#/diagnostics?${new URLSearchParams({ tenant, kind: 'service' }).toString()}`}
                        aria-label={t('org.seeServiceRunsFor', { service: d.name })}
                      >
                        {t('org.seeServiceRuns')}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!everything && chosen.length > shortList ? (
        <button
          type="button"
          className="org-link-btn org-align-start"
          style={{ padding: 0 }}
          onClick={() => setEverything(true)}
        >
          {t('org.showAll', { count: chosen.length })}
        </button>
      ) : null}
    </>
  );
};
