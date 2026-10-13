import { Heading, Link, Table, Tag } from '@digdir/designsystemet-react';
import type { ApiClient } from '../../api';
import { profileFor } from '../../data/organisations';
import { notPriced, statusOf } from '../../format';
import { useT } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import { useAsync } from '../../hooks';
import { EmptyState, ErrorState, Loading } from '../../states';
import { RunDetail } from '../log/RunDetail';
import { actorText } from '../log/format';
import { servicePath } from './sections';
import '../log.css';

export const LogSection = ({
  api,
  tenant,
  tenantName,
  id,
  runId,
  live,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  id: string;
  runId: string | undefined;
  live: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const kr = (micro: number | null | undefined) =>
    micro === null || micro === undefined
      ? notPriced
      : f.currency(micro / 1_000_000, { digits: 2 });
  const [state, retry] = useAsync(
    async (signal) =>
      (await api.tasks(tenant, { service: id }, signal)).data.filter((r) => r.service === id),
    [api, tenant, id],
  );
  const canReveal = profileFor(tenant, tenantName).rights.includes('Administrere tjenester');
  const href = (run: string) => `#${servicePath(id, 'log', `/${encodeURIComponent(run)}`)}`;

  if (runId)
    return (
      <div className="stack log">
        <Link href={`#${servicePath(id, 'log')}`} className="back-link">
          {t('serviceLog.all')}
        </Link>
        <RunDetail
          key={runId}
          api={api}
          tenant={tenant}
          runId={runId}
          itemIndex={undefined}
          canReveal={canReveal}
          live={live}
          onStatus={() => undefined}
          onChange={() => undefined}
        />
      </div>
    );

  return (
    <section aria-labelledby="svc-log-h" className="stack-sm">
      <Heading level={2} data-size="xs" id="svc-log-h">
        {t('serviceLog.heading')}
      </Heading>
      <p className="meta">{t('serviceLog.intro')}</p>
      {state.status === 'loading' ? <Loading label={t('serviceLog.loading')} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <EmptyState title={t('serviceLog.emptyTitle')}>
          <p className="body-sm">{t('serviceLog.emptyBody')}</p>
        </EmptyState>
      ) : null}
      {state.status === 'ready' && state.data.length ? (
        <div tabIndex={0} role="region" aria-labelledby="svc-log-h" className="scroll-x">
          <Table data-size="sm">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('serviceLog.colRun')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('serviceLog.colBy')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('serviceLog.colStatus')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('serviceLog.colStarted')}</Table.HeaderCell>
                <Table.HeaderCell scope="col" className="right">
                  {t('serviceLog.colTokens')}
                </Table.HeaderCell>
                <Table.HeaderCell scope="col" className="right">
                  {t('serviceLog.colCost')}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {state.data.map((r) => {
                const s = statusOf(r.status, t);
                return (
                  <Table.Row key={r.id}>
                    <Table.Cell>
                      <Link href={href(r.id)}>{r.excerpt || r.serviceName || r.id}</Link>
                    </Table.Cell>
                    <Table.Cell>{actorText(r.actor, t)}</Table.Cell>
                    <Table.Cell>
                      <Tag data-size="sm" data-color={s.color}>
                        {s.text}
                      </Tag>
                    </Table.Cell>
                    <Table.Cell>{f.dateTime(r.createdAt, 'medium')}</Table.Cell>
                    <Table.Cell className="right numeric">
                      {f.number(r.usage.inputTokens + r.usage.outputTokens)}
                    </Table.Cell>
                    <Table.Cell className="right numeric">{kr(r.usage.costMicroNok)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      ) : null}
    </section>
  );
};
