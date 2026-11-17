import { Heading, Tabs } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { exampleChanges, type ChangeEntry } from '../data/log';
import { navigate } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { useRights } from '../Shell';
import { ChangesTab } from './log/ChangesTab';
import { parseRunFilters, runFiltersQuery } from './log/filters';
import { RunPage } from './log/RunPage';
import { RunsTab } from './log/RunsTab';
import { LiveChanges } from './changes/LiveChanges';
import './log.css';

export const Log = ({ api, tenant, route, live }: ScreenProps) => {
  const t = useT();
  const [, first, second, third] = route.segments;
  const tab = first === 'changes' || route.query.get('tab') === 'changes' ? 'changes' : 'runs';
  const [path, item] = first === 'runs' ? [second, third] : [first, second];
  const runId = tab === 'changes' ? undefined : (path ?? route.query.get('oppgave') ?? undefined);
  const [changes] = useState<ChangeEntry[]>(live ? [] : exampleChanges);
  const canReveal = useRights().has('manage-services');
  const itemIndex = item && /^\d+$/.test(item) ? Number(item) : undefined;
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
          itemIndex={itemIndex}
          filters={filters}
          canReveal={canReveal}
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
      <Tabs
        value={tab}
        onChange={(value) =>
          navigate(
            value === 'changes'
              ? `/log/changes${runQuery ? `?${runQuery}` : ''}`
              : `/log${runQuery ? `?${runQuery}` : ''}`,
          )
        }
      >
        <Tabs.List aria-label={t('log.title')}>
          <Tabs.Tab value="runs">{t('log.tabRuns')}</Tabs.Tab>
          <Tabs.Tab value="changes">{t('log.tabChanges')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="runs">
          {tab === 'runs' ? (
            <RunsTab api={api} tenant={tenant} live={live} query={route.query} />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="changes">
          {tab === 'changes' && live ? (
            <LiveChanges api={api} tenant={tenant} limit={200} filters />
          ) : tab === 'changes' ? (
            <ChangesTab changes={changes} />
          ) : null}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};
