import {
  Button,
  Chip,
  Fieldset,
  FieldsetLegend,
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
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../api';
import { navigate, useAsync } from '../hooks';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { Tenant, TenantStatus } from '../types';
import { Kpis, Meter, PageHeader, TableRegion, VisuallyHidden } from '../ui';

const statusLabel: Record<TenantStatus, { text: PlainKey; color: 'success' | 'info' | 'warning' }> =
  {
    active: { text: 'tenants.statusActive', color: 'success' },
    onboarding: { text: 'tenants.statusOnboarding', color: 'info' },
    paused: { text: 'tenants.statusPaused', color: 'warning' },
  };

export const formatOrgNumber = (n: string) => n.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');

type Filter = 'all' | TenantStatus;

const filters: { value: Filter; label: PlainKey }[] = [
  { value: 'all', label: 'tenants.filterAll' },
  { value: 'active', label: 'tenants.statusActive' },
  { value: 'onboarding', label: 'tenants.statusOnboarding' },
  { value: 'paused', label: 'tenants.statusPaused' },
];

const costText = (cost: number | null | undefined, t: T, f: Format) =>
  cost === undefined
    ? t('tenants.notAvailable')
    : cost === null
      ? t('tenants.notPriced')
      : t('tenants.cost', { amount: f.decimal(cost, 2) });

const tokens = (tenant: Tenant, t: T, f: Format) => {
  if (tenant.tokensMillions === undefined) return undefined;
  const amount = f.decimal(tenant.tokensMillions, 1);
  if (tenant.quotaMillions === undefined)
    return { text: t('tenants.tokensMillions', { amount }), percent: undefined };
  const percent = Math.round((tenant.tokensMillions / tenant.quotaMillions) * 100);
  return {
    text: t('tenants.tokensOfQuota', { amount, quota: tenant.quotaMillions, percent }),
    percent,
  };
};

const services = (tenant: Tenant, t: T) =>
  tenant.services === 0
    ? t('tenants.servicesNone')
    : tenant.servicesActive === undefined
      ? t('tenants.servicesCount', { count: tenant.services })
      : t('tenants.servicesInUse', { active: tenant.servicesActive, total: tenant.services });

export const Tenants = ({ api, now = () => new Date() }: { api: ApiClient; now?: () => Date }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.listTenants(signal, { usage: true }), [api]);
  const month = f.month(now());
  const notAvailable = t('tenants.notAvailable');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const header = <PageHeader title={t('tenants.title')} intro={t('tenants.intro', { month })} />;
  if (state.status === 'loading')
    return (
      <>
        {header}
        <Loading label={t('tenants.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const all = state.data;
  if (all.length === 0)
    return (
      <>
        {header}
        <EmptyState title={t('tenants.emptyTitle')}>
          <Paragraph>{t('tenants.emptyText')}</Paragraph>
        </EmptyState>
      </>
    );

  const needle = query.trim().toLowerCase();
  const rows = all.filter(
    (x) =>
      (filter === 'all' || x.status === filter) &&
      (!needle ||
        `${x.name} ${x.orgNumber} ${formatOrgNumber(x.orgNumber)}`.toLowerCase().includes(needle)),
  );
  const sum = (pick: (x: Tenant) => number | null | undefined) =>
    all.reduce((acc, x) => acc + (pick(x) ?? 0), 0);
  const known = (pick: (x: Tenant) => number | null | undefined) =>
    all.every((x) => pick(x) !== undefined);
  const priced = all.every((x) => x.costNok !== null);

  return (
    <>
      {header}
      <Kpis
        items={[
          { label: t('tenants.kpiTenants'), value: String(all.length) },
          {
            label: t('tenants.kpiServices'),
            value: String(sum((x) => x.servicesActive ?? x.services)),
          },
          {
            label: t('tenants.kpiTokens', { month }),
            value: known((x) => x.tokensMillions)
              ? t('tenants.tokensMillions', {
                  amount: f.decimal(
                    sum((x) => x.tokensMillions),
                    1,
                  ),
                })
              : notAvailable,
          },
          {
            label: t('tenants.kpiCost', { month }),
            value: !known((x) => x.costNok)
              ? notAvailable
              : priced
                ? t('tenants.cost', {
                    amount: f.decimal(
                      sum((x) => x.costNok),
                      2,
                    ),
                  })
                : t('tenants.notPriced'),
          },
        ]}
      />
      <div className="filters">
        <Textfield
          className="search-field"
          label={t('tenants.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Fieldset>
          <FieldsetLegend>{t('tenants.status')}</FieldsetLegend>
          <div className="chips">
            {filters.map((option) => (
              <Chip.Radio
                key={option.value}
                name="tenant-status"
                checked={filter === option.value}
                onChange={() => setFilter(option.value)}
              >
                {t(option.label)}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
      </div>
      {rows.length === 0 ? (
        <Paragraph>
          {t('tenants.noMatch')}{' '}
          <Button
            variant="tertiary"
            data-size="sm"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            {t('tenants.reset')}
          </Button>
        </Paragraph>
      ) : (
        <TableRegion label={t('tenants.title')}>
          <Table className="wide-900">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('tenants.colTenant')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenants.status')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenants.colOnboarding')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenants.colServices')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenants.colTokens', { month })}</TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {t('tenants.colCost')}
                </TableHeaderCell>
                <TableHeaderCell scope="col">
                  <VisuallyHidden>{t('tenants.colActions')}</VisuallyHidden>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((x) => {
                const use = tokens(x, t, f);
                const warn = (use?.percent ?? 0) >= 85;
                const onboarding = x.status === 'onboarding';
                return (
                  <TableRow key={x.orgNumber}>
                    <TableHeaderCell scope="row" className="row-head">
                      <span className="two-line">
                        <span>{x.name}</span>
                        <span className="meta">
                          {formatOrgNumber(x.orgNumber)}
                          {x.admin ? ` · ${x.admin}` : ''}
                        </span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      <Tag data-size="sm" data-color={statusLabel[x.status].color}>
                        {t(statusLabel[x.status].text)}
                      </Tag>
                    </TableCell>
                    <TableCell className="sm">{x.note ?? x.stage ?? '–'}</TableCell>
                    <TableCell className="sm">{services(x, t)}</TableCell>
                    <TableCell>
                      {use ? (
                        <span className="usage">
                          <span className="usage-text">
                            {use.text}
                            {warn ? (
                              <Tag data-size="sm" data-color="warning">
                                {t('tenants.nearQuota')}
                              </Tag>
                            ) : null}
                          </span>
                          {use.percent === undefined ? null : (
                            <Meter percent={use.percent} warn={warn} />
                          )}
                        </span>
                      ) : (
                        notAvailable
                      )}
                    </TableCell>
                    <TableCell className="num">{costText(x.costNok, t, f)}</TableCell>
                    <TableCell>
                      <span className="row-actions">
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('tenants.servicesFor', { name: x.name })}
                          onClick={() => navigate('/tenants/services', { tenant: x.orgNumber })}
                        >
                          {t('tenants.actionServices')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('tenants.diagnosticsFor', { name: x.name })}
                          onClick={() =>
                            navigate('/diagnostics', { tenant: x.orgNumber, kind: 'service' })
                          }
                        >
                          {t('tenants.actionDiagnostics')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('tenants.supportFor', { name: x.name })}
                          aria-disabled={onboarding || undefined}
                          onClick={() => {
                            if (!onboarding) navigate('/support-access', { tenant: x.orgNumber });
                          }}
                        >
                          {t('tenants.actionSupport')}
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
    </>
  );
};
