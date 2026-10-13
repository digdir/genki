import {
  Button,
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
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { TenantDefinition } from '../types';
import { formatWhen, PageHeader, TableRegion } from '../ui';
import { toYaml } from '../yaml';
import { formatOrgNumber } from './Tenants';

const kindLabel: Record<TenantDefinition['kind'], PlainKey> = {
  Service: 'tenantServices.kindService',
  StepFlow: 'tenantServices.kindStepFlow',
};

const actor = (who: string, name: string | undefined, t: T) =>
  name ??
  (who.startsWith('platform:')
    ? t('tenantServices.byConfigFile')
    : /^(operator|employee):/.test(who) && !who.includes('http')
      ? who.replace(/^(operator|employee):(entra:|ansattporten:)?/, '')
      : t('tenantServices.byUnknown'));

const withoutVersion = (definition: Record<string, unknown>) => {
  const metadata = { ...(definition.metadata as Record<string, unknown> | undefined) };
  delete metadata.version;
  return { ...definition, metadata };
};

const VersionYaml = ({
  api,
  tenant,
  kind,
  id,
  version,
}: {
  api: ApiClient;
  tenant: string;
  kind: TenantDefinition['kind'];
  id: string;
  version: number;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    (signal) => api.tenantDefinitionVersion(tenant, kind, id, version, signal),
    [api, tenant, kind, id, version],
  );
  if (state.status === 'loading')
    return <Loading label={t('tenantServices.loadingVersion', { version })} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return (
    <pre
      tabIndex={0}
      className="definition-yaml"
      aria-label={t('tenantServices.versionYaml', { version })}
    >
      <code>{toYaml(withoutVersion(state.data.definition))}</code>
    </pre>
  );
};

const Detail = ({
  api,
  tenant,
  kind,
  id,
}: {
  api: ApiClient;
  tenant: string;
  kind: TenantDefinition['kind'];
  id: string;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => api.tenantDefinition(tenant, kind, id, signal),
    [api, tenant, kind, id],
  );
  const [open, setOpen] = useState<number>();
  if (state.status === 'loading') return <Loading label={t('tenantServices.loadingVersions')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const current = state.data.latest.version;
  const shown = open ?? current;
  return (
    <section className="stack" aria-labelledby="definisjon-h">
      <Heading level={2} data-size="xs" id="definisjon-h">
        {t(kindLabel[kind])} {id}
      </Heading>
      <TableRegion label={t('tenantServices.versionsOf', { id })}>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('tenantServices.colVersion')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('tenantServices.colPublished')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('tenantServices.colBy')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('tenantServices.colReason')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('tenantServices.colDefinition')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {[...state.data.versions].reverse().map((v) => (
              <TableRow key={v.version}>
                <TableHeaderCell scope="row" className="row-head">
                  <span className="two-line">
                    <span>{t('tenantServices.versionN', { version: v.version })}</span>
                    {v.version === current ? (
                      <Tag data-size="sm" data-color="success">
                        {t('tenantServices.inUse')}
                      </Tag>
                    ) : null}
                  </span>
                </TableHeaderCell>
                <TableCell className="sm nowrap">{formatWhen(v.publishedAt, f, t)}</TableCell>
                <TableCell className="sm">{actor(v.publishedBy, v.publishedByName, t)}</TableCell>
                <TableCell className="sm">{v.reason || '–'}</TableCell>
                <TableCell>
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-pressed={shown === v.version}
                    onClick={() => setOpen(v.version)}
                  >
                    {t('tenantServices.showYaml')}
                    <span className="visually-hidden">
                      {t('tenantServices.showYamlHidden', { version: v.version })}
                    </span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableRegion>
      <VersionYaml api={api} tenant={tenant} kind={kind} id={id} version={shown} />
    </section>
  );
};

export const TenantServices = ({
  api,
  tenant,
  kind,
  id,
}: {
  api: ApiClient;
  tenant: string | undefined;
  kind: TenantDefinition['kind'];
  id: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const [tenants] = useAsync((signal) => api.listTenants(signal), [api]);
  const [state, retry] = useAsync(
    (signal) => (tenant ? api.tenantDefinitions(tenant, signal) : Promise.resolve([])),
    [api, tenant],
  );
  const name =
    tenants.status === 'ready'
      ? (tenants.data.find((x) => x.orgNumber === tenant)?.name ?? tenant)
      : tenant;
  if (!tenant)
    return (
      <>
        <PageHeader title={t('tenantServices.title')} />
        <EmptyState title={t('tenantServices.pickTitle')}>
          <Paragraph>
            {t.rich('tenantServices.pickText', { link: (c) => <a href="#/tenants">{c}</a> })}
          </Paragraph>
        </EmptyState>
      </>
    );
  return (
    <>
      <PageHeader
        eyebrow={`${name ?? ''} · ${formatOrgNumber(tenant)}`}
        title={t('tenantServices.headerTitle')}
        intro={t('tenantServices.intro')}
      />
      <p>
        <a href="#/tenants">{t('tenantServices.back')}</a>
      </p>
      {state.status === 'loading' ? (
        <Loading label={t('tenantServices.loadingDefinitions')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <EmptyState title={t('tenantServices.emptyTitle')}>
          <Paragraph>{t('tenantServices.emptyText')}</Paragraph>
        </EmptyState>
      ) : (
        <TableRegion label={t('tenantServices.definitions')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('tenantServices.colName')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenantServices.colType')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('tenantServices.colVersion')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  {t('tenantServices.colLastPublished')}
                </TableHeaderCell>
                <TableHeaderCell scope="col">
                  <span className="visually-hidden">{t('tenantServices.colActions')}</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.data.map((d) => (
                <TableRow key={`${d.kind}/${d.id}`}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>
                        {d.name}
                        {d.state && d.state !== 'active' ? (
                          <>
                            {' '}
                            <Tag
                              data-size="sm"
                              data-color={d.state === 'archived' ? 'neutral' : 'warning'}
                            >
                              {t(
                                d.state === 'archived'
                                  ? 'tenantServices.archived'
                                  : 'tenantServices.paused',
                              )}
                            </Tag>
                          </>
                        ) : null}
                      </span>
                      <span className="meta">{d.id}</span>
                    </span>
                  </TableHeaderCell>
                  <TableCell>{t(kindLabel[d.kind])}</TableCell>
                  <TableCell>{d.latestVersion}</TableCell>
                  <TableCell className="sm">
                    {d.publishedAt ? formatWhen(d.publishedAt, f, t) : '–'}
                    {d.publishedBy ? ` · ${actor(d.publishedBy, d.publishedByName, t)}` : ''}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-current={id === d.id && kind === d.kind ? 'true' : undefined}
                      onClick={() =>
                        navigate('/tenants/services', {
                          tenant,
                          kind: d.kind === 'Service' ? 'service' : 'step-flow',
                          id: d.id,
                        })
                      }
                    >
                      {t('tenantServices.versions')}
                      <span className="visually-hidden">
                        {t('tenantServices.versionsFor', { name: d.name })}
                      </span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {id ? <Detail key={`${kind}/${id}`} api={api} tenant={tenant} kind={kind} id={id} /> : null}
    </>
  );
};
