import { Heading } from '@digdir/designsystemet-react';
import { LinkTabs } from '../components/LinkTabs';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { parseRunFilters, runFiltersQuery } from './log/filters';
import { RunPage } from './log/RunPage';
import { RunsTab } from './log/RunsTab';
import { LiveChanges } from './changes/LiveChanges';
import './log.css';

export const Log = ({ api, tenant, route, live }: ScreenProps) => {
  const t = useT();
  const [, first, second] = route.segments;
  const tab = first === 'changes' || route.query.get('tab') === 'changes' ? 'changes' : 'runs';
  const path = first === 'runs' ? second : first;
  const runId = tab === 'changes' ? undefined : (path ?? route.query.get('oppgave') ?? undefined);
  const filters = parseRunFilters(route.query);
  const runQuery = runFiltersQuery(filters);

  if (runId)
    return (
      <div className="log">
        <RunPage
          key={runId}
          api={api}
          tenant={tenant}
          runId={runId}
          filters={filters}
          live={live}
        />
      </div>
    );

  return (
    <div className="stack log">
      <div className="log-intro">
        <Heading level={1} data-size="lg">
          {t('log.title')}
        </Heading>
        <p className="lead">{t('log.lead')}</p>
      </div>
      <LinkTabs
        label={t('log.title')}
        current={tab}
        tabs={[
          { key: 'runs', label: t('log.tabRuns'), href: `#/log${runQuery ? `?${runQuery}` : ''}` },
          {
            key: 'changes',
            label: t('log.tabChanges'),
            href: `#/log/changes${runQuery ? `?${runQuery}` : ''}`,
          },
        ]}
      />
      {tab === 'runs' ? (
        <RunsTab api={api} tenant={tenant} live={live} query={route.query} />
      ) : null}
      {tab === 'changes' ? <LiveChanges api={api} tenant={tenant} filters paged /> : null}
    </div>
  );
};
