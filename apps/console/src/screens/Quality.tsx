import {
  Alert,
  Chip,
  Fieldset,
  FieldsetLegend,
  Heading,
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
import { useState } from 'react';
import type { ApiClient } from '../api';
import { useT, type Format, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type { MetricSummary, QualityHistory, QualityRow } from '../types';
import { PageHeader, TableRegion } from '../ui';

const colors = [
  'var(--ds-color-accent-base-default)',
  'var(--ds-color-danger-base-default)',
  'var(--ds-color-success-base-default)',
  'var(--ds-color-brand3-base-default)',
  'var(--ds-color-warning-base-default)',
  'var(--ds-color-neutral-base-default)',
];
const dashes = ['', '8 5', '2 4', '12 4 2 4', '4 3', '1 0'];

const metric = (m: MetricSummary, t: T, f: Format) =>
  t('quality.metric', {
    mean: f.decimal(m.mean, 2),
    low: f.decimal(m.ci[0], 2),
    high: f.decimal(m.ci[1], 2),
    n: m.n,
  });

const Trend = ({ history }: { history: QualityHistory }) => {
  const t = useT();
  const [on, setOn] = useState<Record<number, boolean>>({ 0: true, 1: true, 3: true, 4: true });
  const last = history.weeks.length - 1;
  const prev = last - 1;
  const base = last - 2;
  const steps = Math.max(1, last);
  const x = (i: number) => 60 + i * (820 / steps);
  const y = (v: number) => 250 - ((v - 70) / 30) * 230;
  const regressions = history.series.filter(
    (s) => (s.scores[prev] ?? 0) - (s.scores[base] ?? 0) <= -4,
  );
  const event = history.events[0];
  return (
    <div className="stack">
      {regressions.length ? (
        <Alert data-color="danger">
          <Heading level={2} data-size="2xs">
            {t('quality.regressions', { count: regressions.length })}
            {event
              ? t('quality.regressionsAfter', {
                  event: `${event.text.charAt(0).toLowerCase()}${event.text.slice(1)}`,
                })
              : ''}
          </Heading>
          <ul>
            {regressions.map((s) => (
              <li key={s.name}>
                {t('quality.regressionLine', {
                  name: s.name,
                  from: s.scores[base] ?? 0,
                  to: s.scores[prev] ?? 0,
                  now: s.scores[last] ?? 0,
                })}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Fieldset>
        <FieldsetLegend>{t('quality.showInChart')}</FieldsetLegend>
        <div className="chips">
          {history.series.map((s, i) => (
            <Chip.Checkbox
              key={s.name}
              checked={Boolean(on[i])}
              onChange={() => setOn((o) => ({ ...o, [i]: !o[i] }))}
            >
              {s.name}
            </Chip.Checkbox>
          ))}
        </div>
      </Fieldset>
      <figure className="chart">
        <div className="chart-scroll">
          <svg
            viewBox="0 0 900 280"
            role="img"
            aria-label={t('quality.chartLabel', {
              from: history.weeks[0] ?? '',
              to: history.weeks[last] ?? '',
            })}
          >
            {[70, 80, 90, 100].map((v) => (
              <g key={v}>
                <line
                  x1="40"
                  x2="890"
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--ds-color-neutral-border-subtle)"
                />
                <text
                  x="32"
                  y={y(v) + 4}
                  textAnchor="end"
                  fontSize="12"
                  fill="var(--ds-color-neutral-text-subtle)"
                >
                  {v}
                </text>
              </g>
            ))}
            {history.events.map((e, i) => (
              <g key={e.text}>
                <line
                  x1={x(e.week) - 820 / steps / 2}
                  x2={x(e.week) - 820 / steps / 2}
                  y1="10"
                  y2="250"
                  stroke="var(--ds-color-danger-border-default)"
                  strokeDasharray="4 4"
                />
                <text
                  x={x(e.week) - 820 / steps / 2 + 4}
                  y="22"
                  fontSize="12"
                  fill="var(--ds-color-danger-text-default)"
                >
                  {i + 1}
                </text>
              </g>
            ))}
            {history.series.map((s, i) =>
              on[i] ? (
                <g key={s.name}>
                  <polyline
                    points={s.scores.map((v, j) => `${x(j)},${y(v)}`).join(' ')}
                    fill="none"
                    stroke={colors[i % colors.length]}
                    strokeWidth="2.5"
                    strokeDasharray={dashes[i % dashes.length]}
                  />
                  <circle
                    cx={x(last)}
                    cy={y(s.scores[last] ?? 70)}
                    r="4"
                    fill={colors[i % colors.length]}
                  />
                </g>
              ) : null,
            )}
            {history.weeks.map((w, i) => (
              <text
                key={w}
                x={x(i)}
                y="272"
                textAnchor="middle"
                fontSize="12"
                fill="var(--ds-color-neutral-text-subtle)"
              >
                {w}
              </text>
            ))}
          </svg>
        </div>
        <figcaption className="stack-sm">
          <ul className="plain legend">
            {history.series.map((s, i) =>
              on[i] ? (
                <li key={s.name}>
                  <svg width="26" height="10" aria-hidden="true">
                    <line
                      x1="0"
                      x2="26"
                      y1="5"
                      y2="5"
                      stroke={colors[i % colors.length]}
                      strokeWidth="2.5"
                      strokeDasharray={dashes[i % dashes.length]}
                    />
                  </svg>
                  {s.name}
                </li>
              ) : null,
            )}
          </ul>
          <ol className="meta">
            {history.events.map((e) => (
              <li key={e.text}>{e.text}</li>
            ))}
          </ol>
        </figcaption>
      </figure>
      <TableRegion label={t('quality.perService')}>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('quality.colService')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('quality.colNow')}
              </TableHeaderCell>
              <TableHeaderCell scope="col" className="num">
                {t('quality.colTwoWeeksAgo')}
              </TableHeaderCell>
              <TableHeaderCell scope="col">{t('quality.colChange')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {history.series.map((s) => {
              const now = s.scores[last] ?? 0;
              const before = s.scores[base] ?? 0;
              const d = now - before;
              const reg = (s.scores[prev] ?? 0) - before <= -4;
              return (
                <TableRow key={s.name} className={reg ? 'regression' : undefined}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>{s.name}</span>
                      <span className="meta">{s.kind}</span>
                    </span>
                  </TableHeaderCell>
                  <TableCell className="num strong">{now}</TableCell>
                  <TableCell className="num">{before}</TableCell>
                  <TableCell>
                    <Tag data-size="sm" data-color={reg ? 'danger' : d > 0 ? 'success' : 'neutral'}>
                      {reg
                        ? t('quality.regression', { delta: String(d) })
                        : `${d > 0 ? '+' : ''}${d}`}
                    </Tag>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableRegion>
      <Paragraph data-size="sm" className="meta">
        {t('quality.note')}
      </Paragraph>
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
      <PageHeader title={t('quality.title')} intro={t('quality.intro')} />
      <a
        className="ds-button align-start"
        data-variant="secondary"
        data-size="sm"
        href="#/quality-matrix"
      >
        {t('quality.openMatrix')}
      </a>
      {state.status === 'loading' ? (
        <Loading label={t('quality.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.history ? (
        <Trend history={state.data.history} />
      ) : (
        <LatestRuns rows={state.data.services} tenantName={tenantName} />
      )}
    </>
  );
};
