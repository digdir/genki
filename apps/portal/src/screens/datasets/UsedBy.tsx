import {
  Alert,
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
import type { ApiClient } from '../../api';
import type { DatasetReader } from '../../api/datasets';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ServiceSummaryView, TaskRow } from '../../types';

interface ServiceFacts {
  summary?: ServiceSummaryView;
  last?: TaskRow;
}

const lifecycleText: Record<ServiceSummaryView['lifecycle'], PlainKey> = {
  active: 'serviceList.statusLive',
  paused: 'serviceList.statusPaused',
  archived: 'serviceList.statusArchived',
};

const lifecycleColor = { active: 'success', paused: 'warning', archived: 'neutral' } as const;

const logHref = (service: string) => `#/log?service=${encodeURIComponent(service)}`;

export const UsedBy = ({
  api,
  tenant,
  readers,
  documents,
}: {
  api: ApiClient;
  tenant: string;
  readers: DatasetReader[];
  documents: string;
}) => {
  const t = useT();
  const f = useFormat();
  const services = readers.filter((r) => r.kind === 'service' && r.tenant === tenant);
  const others = readers.filter((r) => !(r.kind === 'service' && r.tenant === tenant));
  const ids = services.map((s) => s.id);
  const [facts, retry] = useAsync(
    async (signal): Promise<Map<string, ServiceFacts>> => {
      if (ids.length === 0) return new Map();
      const [listed, lasts] = await Promise.all([
        api.services(tenant, signal),
        Promise.all(ids.map((id) => api.tasks(tenant, { service: id, limit: 1 }, signal))),
      ]);
      return new Map(
        ids.map((id, i): [string, ServiceFacts] => {
          const summary = listed.data.find((s) => s.id === id);
          const last = lasts[i]?.data[0];
          return [id, { ...(summary ? { summary } : {}), ...(last ? { last } : {}) }];
        }),
      );
    },
    [api, tenant, ids.join(',')],
  );

  if (readers.length === 0)
    return (
      <section className="stack-sm" aria-labelledby="used-by-h">
        <Heading level={2} data-size="xs" id="used-by-h">
          {t('datasets.usedByNoneTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('datasets.usedByNoneText', { documents })}</Paragraph>
        <a href="#/services">{t('datasets.useInService')}</a>
      </section>
    );

  const known = facts.status === 'ready' ? facts.data : undefined;
  return (
    <section className="stack-sm" aria-labelledby="used-by-h">
      <div className="row-wrap used-by-head">
        <Heading level={2} data-size="xs" id="used-by-h">
          {t('datasets.usedByCount', { count: readers.length })}
        </Heading>
        <a href="#/services">{t('datasets.useInAnotherService')}</a>
      </div>
      <Paragraph data-size="sm">{t('datasets.usedByIntro')}</Paragraph>
      {facts.status === 'error' ? (
        <Alert data-color="warning" data-size="sm" role="alert">
          <Heading level={3} data-size="2xs">
            {t('datasets.usedByFactsFailed')}
          </Heading>
          <Paragraph data-size="sm">{t('datasets.usedByFactsFailedText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}
      <div className="table-scroll" role="region" aria-label={t('datasets.tabUsedBy')} tabIndex={0}>
        <Table aria-label={t('datasets.tabUsedBy')}>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('datasets.columnService')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('datasets.columnStatus')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('datasets.columnLastRun')}</TableHeaderCell>
              <TableHeaderCell scope="col" className="numeric right">
                {t('datasets.columnRunsWeek')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {services.map((s) => {
              const fact = known?.get(s.id);
              const empty = facts.status === 'loading' ? '…' : t('datasets.notAvailable');
              return (
                <TableRow key={s.id}>
                  <TableCell>
                    <a href={`#/services/${encodeURIComponent(s.id)}`}>{s.name}</a>
                  </TableCell>
                  <TableCell>
                    {fact?.summary ? (
                      <Tag data-size="sm" data-color={lifecycleColor[fact.summary.lifecycle]}>
                        {t(lifecycleText[fact.summary.lifecycle])}
                      </Tag>
                    ) : (
                      empty
                    )}
                  </TableCell>
                  <TableCell>
                    {fact?.last
                      ? f.dateTime(fact.last.createdAt)
                      : known
                        ? t('datasets.noRunsYet')
                        : empty}
                  </TableCell>
                  <TableCell className="numeric right">
                    {fact?.summary ? f.number(fact.summary.runsThisWeek) : empty}
                  </TableCell>
                </TableRow>
              );
            })}
            {others.map((r) => (
              <TableRow key={`${r.kind}:${r.tenant}/${r.id}`}>
                <TableCell>
                  {r.kind === 'service'
                    ? r.name
                    : t('datasets.readerAdoption', { tenant: r.tenant })}
                </TableCell>
                <TableCell>{t('datasets.notAvailable')}</TableCell>
                <TableCell>{t('datasets.notAvailable')}</TableCell>
                <TableCell className="numeric right">{t('datasets.notAvailable')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {services.length > 0 ? (
        <Paragraph data-size="sm">
          {t('datasets.seeRunsAsk')}{' '}
          {services.length === 1 ? (
            <a href={logHref(services[0]?.id ?? '')}>{t('datasets.seeRunsInLog')}</a>
          ) : (
            services.map((s, i) => (
              <span key={s.id}>
                {i > 0 ? ', ' : ''}
                <a href={logHref(s.id)}>{t('datasets.seeRunsFor', { name: s.name })}</a>
              </span>
            ))
          )}
        </Paragraph>
      ) : null}
    </section>
  );
};
