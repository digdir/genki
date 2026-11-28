import {
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { ApiClient } from '../api';
import { useT, type Format, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type { MetricSummary, QualityHistory, QualityRow } from '../types';
import { TableRegion } from '../ui';
import './platform.css';
import { PageTabs } from '../page-tabs';

const metric = (m: MetricSummary, t: T, f: Format) =>
  t('quality.metric', {
    mean: f.decimal(m.mean, 2),
    low: f.decimal(m.ci[0], 2),
    high: f.decimal(m.ci[1], 2),
    n: m.n,
  });

const Change = ({ delta }: { delta: number }) => {
  const t = useT();
  if (delta === 0) return <>0</>;
  if (delta > 0) return <>{t('quality.up', { delta })}</>;
  return (
    <span className="pf-chip" data-tone={delta <= -5 ? 'danger' : 'warn'}>
      {t('quality.down', { delta: -delta })}
    </span>
  );
};

const Dropped = ({ history }: { history: QualityHistory }) => {
  const t = useT();
  const rows = [...history.series].sort((a, b) => a.now - a.before - (b.now - b.before));
  return (
    <div className="pf-region" tabIndex={0} role="region" aria-label={t('quality.perService')}>
      <table className="pf-table pf-min-720">
        <thead>
          <tr>
            <th scope="col">{t('quality.colServiceShort')}</th>
            <th scope="col">{t('quality.colTenant')}</th>
            <th scope="col" className="num">
              {t('quality.colNow')}
            </th>
            <th scope="col" className="num">
              {t('quality.colTwoWeeksAgo')}
            </th>
            <th scope="col" className="num" aria-sort="ascending">
              {t('quality.colChange')}
              <span aria-hidden="true"> ↑</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={`${s.tenant ?? ''}/${s.name}`}>
              <td>
                {!s.tenant && s.now < s.before ? (
                  <a className="action" href="#/shared-services">
                    {s.name}
                  </a>
                ) : (
                  s.name
                )}
              </td>
              <td>{s.tenant ?? t('quality.shared')}</td>
              <td className="num">{s.now}</td>
              <td className="num">{s.before}</td>
              <td className="num">
                <Change delta={s.now - s.before} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const LatestRuns = ({
  rows,
  tenantName,
}: {
  rows: QualityRow[];
  tenantName: (orgNumber: string) => string;
}) => {
  const t = useT();
  const f = useFormat();
  return rows.length === 0 ? (
    <EmptyState title={t('quality.emptyTitle')}>
      <Paragraph>{t('quality.emptyText')}</Paragraph>
    </EmptyState>
  ) : (
    <TableRegion label={t('quality.latestRuns')}>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col">{t('quality.colServiceShort')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('quality.colTestSet')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('quality.colResult')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('quality.colStatus')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('quality.colRan')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.tenant}|${row.service}|${row.testSet}`}>
              <TableHeaderCell scope="row" className="row-head">
                <span className="two-line">
                  <span>{row.service}</span>
                  <span className="meta">{tenantName(row.tenant)}</span>
                </span>
              </TableHeaderCell>
              <TableCell>{row.testSet}</TableCell>
              <TableCell>
                <ul className="plain">
                  {Object.entries(row.metrics).map(([name, m]) => (
                    <li key={name}>
                      {name}: {metric(m, t, f)}
                    </li>
                  ))}
                </ul>
              </TableCell>
              <TableCell>
                {row.regressions.length > 0 ? (
                  <Tag data-size="sm" data-color="danger">
                    {t('quality.regressionIn', { metrics: row.regressions.join(', ') })}
                  </Tag>
                ) : (
                  <Tag data-size="sm" data-color="success">
                    {t('quality.noRegression')}
                  </Tag>
                )}
              </TableCell>
              <TableCell>{f.dateTime(row.endedAt, 'short')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableRegion>
  );
};

export const Quality = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tenantName = useTenantNames(api);
  const [state, retry] = useAsync((signal) => api.quality(signal), [api]);
  return (
    <>
      <h1 className="pf-title">{t('quality.title')}</h1>
      <PageTabs />
      {state.status === 'loading' ? (
        <Loading label={t('quality.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <>
          <section className="pf-section" aria-labelledby="quality-services">
            <h2 className="pf-h2 small" id="quality-services">
              {state.data.history ? t('quality.dropped') : t('quality.latestRuns')}
            </h2>
            {state.data.history ? (
              <Dropped history={state.data.history} />
            ) : (
              <LatestRuns rows={state.data.services} tenantName={tenantName} />
            )}
          </section>
          {state.data.judges.length ? (
            <section className="pf-section" aria-labelledby="quality-judges">
              <h2 className="pf-h2 small" id="quality-judges">
                {t('quality.judges')}
              </h2>
              <ul className="pf-chips">
                {state.data.judges.map((j) => (
                  <li key={j.judge} className="pf-chip">
                    {j.name ?? j.judge}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  );
};
