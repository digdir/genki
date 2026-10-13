import { Heading, Link, Paragraph, Table, Tag } from '@digdir/designsystemet-react';
import type { ApiClient } from '../../api';
import { modelFor } from '../../data/services';
import type { ServiceDefinition } from '../../data/service-definition';
import { channelOn, datasetsOf, type ChannelKey } from '../../data/service-form';
import { strategyFor } from '../../data/strategies';
import { notPriced, statusOf } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import type { TaskRow, UsageTotals } from '../../types';
import type { VersionItem } from '../services/VersionsTab';
import { servicePath } from './sections';

const channelLabels: [key: ChannelKey, label: PlainKey][] = [
  ['chatOwn', 'serviceOverview.chat'],
  ['api', 'serviceOverview.api'],
  ['openai', 'serviceOverview.openai'],
  ['mcp', 'serviceOverview.mcp'],
  ['a2a', 'serviceOverview.a2a'],
  ['fileTrigger', 'serviceOverview.fileTrigger'],
  ['queue', 'serviceOverview.queue'],
  ['schedule', 'serviceOverview.schedule'],
  ['batch', 'serviceOverview.batch'],
];

const channelsOf = (t: T, d: ServiceDefinition) =>
  channelLabels.filter(([k]) => channelOn(d.spec, k)).map(([, l]) => t(l));

interface Activity {
  usage: UsageTotals | undefined;
  tasks: TaskRow[];
}

const riskKeys: Record<string, PlainKey> = {
  minimal: 'setup.riskMinimal',
  limited: 'setup.riskLimited',
  high: 'setup.riskHigh',
};

export const OverviewSection = ({
  api,
  tenant,
  id,
  definition: d,
  versions,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  definition: ServiceDefinition;
  versions: VersionItem[];
}) => {
  const t = useT();
  const f = useFormat();
  const kr = (micro: number | null | undefined) =>
    micro === null || micro === undefined
      ? notPriced
      : f.currency(micro / 1_000_000, { digits: 2 });
  const [state] = useAsync(
    async (signal): Promise<Activity> => {
      const [usage, tasks] = await Promise.allSettled([
        api.usage(tenant, 30, signal),
        api.tasks(tenant, { service: id }, signal),
      ]);
      return {
        usage:
          usage.status === 'fulfilled'
            ? usage.value.byService.find((s) => s.service === id)?.usage
            : undefined,
        tasks:
          tasks.status === 'fulfilled'
            ? tasks.value.data.filter((r) => r.service === id).slice(0, 5)
            : [],
      };
    },
    [api, tenant, id],
  );
  const strategy = strategyFor(d.spec.strategy.id, t);
  const model = modelFor(d.spec.model.primary, d.spec.model.residency);
  const riskKey = riskKeys[d.spec.riskClass ?? ''];
  const risk = riskKey ? t(riskKey) : t('serviceOverview.riskUnset');
  const channels = channelsOf(t, d);
  const current = versions.find((v) => v.state === 'I bruk') ?? versions[0];
  const link = (section: Parameters<typeof servicePath>[1], rest = '') =>
    `#${servicePath(id, section, rest)}`;

  return (
    <div className="service-overview stack">
      <section aria-labelledby="ov-what" className="stack-sm">
        <Heading level={2} data-size="xs" id="ov-what">
          {t('serviceOverview.what')}
        </Heading>
        <Paragraph>{d.spec.purpose || t('serviceOverview.noPurpose')}</Paragraph>
        <dl className="kv service-facts">
          <dt>{t('serviceOverview.currentVersion')}</dt>
          <dd>
            {current
              ? t('serviceOverview.versionLine', {
                  n: current.n,
                  when: current.when,
                  who: current.who,
                })
              : t('serviceOverview.notPublished')}
          </dd>
          <dt>{t('serviceOverview.how')}</dt>
          <dd>
            <Link href={link('setup', '/how')}>
              {strategy?.name ?? t('serviceOverview.notChosen')}
            </Link>
          </dd>
          <dt>{t('serviceOverview.model')}</dt>
          <dd>
            {model?.name ?? d.spec.model.primary}
            {model ? t('serviceOverview.modelWhere', { where: model.where }) : ''}
          </dd>
          <dt>{t('serviceOverview.knowledge')}</dt>
          <dd>
            {datasetsOf(d.spec).length
              ? datasetsOf(d.spec)
                  .map((ref) => ref.dataset)
                  .join(', ')
              : t('serviceOverview.noDatasets')}
          </dd>
          <dt>{t('serviceOverview.risk')}</dt>
          <dd>{risk}</dd>
          <dt>{t('serviceOverview.channels')}</dt>
          <dd>
            <Link href={link('channels')}>
              {channels.length ? channels.join(', ') : t('serviceOverview.noChannels')}
            </Link>
          </dd>
        </dl>
      </section>

      <section aria-labelledby="ov-use" className="stack-sm">
        <Heading level={2} data-size="xs" id="ov-use">
          {t('serviceOverview.usage')}
        </Heading>
        {state.status === 'loading' ? (
          <p className="meta">{t('serviceOverview.usageLoading')}</p>
        ) : null}
        {state.status === 'ready' && state.data.usage ? (
          <dl className="facts">
            <div>
              <dt>{t('serviceOverview.runs')}</dt>
              <dd>{f.number(state.data.usage.runs ?? state.data.usage.requests)}</dd>
            </div>
            <div>
              <dt>{t('serviceOverview.tokens')}</dt>
              <dd>{f.number(state.data.usage.inputTokens + state.data.usage.outputTokens)}</dd>
            </div>
            <div>
              <dt>{t('serviceOverview.cost')}</dt>
              <dd>{kr(state.data.usage.costMicroNok)}</dd>
            </div>
          </dl>
        ) : null}
        {state.status !== 'loading' && !(state.status === 'ready' && state.data.usage) ? (
          <p className="body-sm">{t('serviceOverview.noUsage')}</p>
        ) : null}
      </section>

      <section aria-labelledby="ov-runs" className="stack-sm">
        <div className="row-wrap spread">
          <Heading level={2} data-size="xs" id="ov-runs">
            {t('serviceOverview.lastRuns')}
          </Heading>
          <Link href={link('log')}>{t('serviceOverview.seeAll')}</Link>
        </div>
        {state.status === 'ready' && state.data.tasks.length ? (
          <div tabIndex={0} role="region" aria-labelledby="ov-runs" className="scroll-x">
            <Table data-size="sm">
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('serviceLog.colRun')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceLog.colStatus')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('serviceLog.colStarted')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col" className="right">
                    {t('serviceLog.colTokens')}
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {state.data.tasks.map((r) => {
                  const s = statusOf(r.status, t);
                  return (
                    <Table.Row key={r.id}>
                      <Table.Cell>
                        <Link href={link('log', `/${encodeURIComponent(r.id)}`)}>
                          {r.excerpt || r.serviceName || r.id}
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <Tag data-size="sm" data-color={s.color}>
                          {s.text}
                        </Tag>
                      </Table.Cell>
                      <Table.Cell>{f.dateTime(r.createdAt, 'medium')}</Table.Cell>
                      <Table.Cell className="right numeric">
                        {f.number(r.usage.inputTokens + r.usage.outputTokens)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        ) : state.status === 'loading' ? null : (
          <p className="body-sm">{t('serviceOverview.noRuns')}</p>
        )}
      </section>
    </div>
  );
};
