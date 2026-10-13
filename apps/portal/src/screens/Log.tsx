import { Heading, Tabs } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { exampleChanges, type ChangeEntry } from '../data/log';
import { profileFor } from '../data/organisations';
import { navigate } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { ChangesTab } from './log/ChangesTab';
import { RunsTab } from './log/RunsTab';
import { LiveChanges } from './changes/LiveChanges';
import './log.css';

export const Log = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const [, path, item] = route.segments;
  const runId = path ?? route.query.get('oppgave') ?? undefined;
  const tab = route.query.get('tab') === 'changes' ? 'changes' : 'runs';
  const [changes, setChanges] = useState<ChangeEntry[]>(live ? [] : exampleChanges);
  const canReveal = profileFor(tenant, tenantName).rights.includes('Administrere tjenester');
  const itemIndex = item && /^\d+$/.test(item) ? Number(item) : undefined;

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
          navigate(value === 'changes' ? '/log?tab=changes' : runId ? `/log/${runId}` : '/log')
        }
      >
        <Tabs.List aria-label={t('log.title')}>
          <Tabs.Tab value="runs">{t('log.tabRuns')}</Tabs.Tab>
          <Tabs.Tab value="changes">{t('log.tabChanges')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="runs">
          {tab === 'runs' ? (
            <RunsTab
              api={api}
              tenant={tenant}
              runId={runId}
              itemIndex={itemIndex}
              canReveal={canReveal}
              live={live}
              onChange={(entry) => setChanges((c) => [entry, ...c])}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="changes">
          {tab === 'changes' && live ? (
            <div className="card">
              <LiveChanges api={api} tenant={tenant} limit={200} />
            </div>
          ) : tab === 'changes' ? (
            <ChangesTab changes={changes} />
          ) : null}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};
