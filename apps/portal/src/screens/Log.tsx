import { Heading } from '@digdir/designsystemet-react';
import { useState, type KeyboardEvent } from 'react';
import { exampleChanges, type ChangeEntry } from '../data/log';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { useRights } from '../Shell';
import { ChangesTab } from './log/ChangesTab';
import { parseRunFilters, runFiltersQuery } from './log/filters';
import { RunPage } from './log/RunPage';
import { RunsTab } from './log/RunsTab';
import { LiveChanges } from './changes/LiveChanges';
import './log.css';

const tabKeys: Record<string, (at: number, count: number) => number> = {
  ArrowRight: (at, count) => (at + 1) % count,
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
};

const moveBetweenTabs = (event: KeyboardEvent<HTMLElement>) => {
  const move = tabKeys[event.key];
  const links = [...event.currentTarget.querySelectorAll('a')];
  const at = links.findIndex((link) => link === document.activeElement);
  if (!move || at < 0) return;
  event.preventDefault();
  links[move(at, links.length)]?.focus();
};

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
      <nav aria-label={t('log.title')} className="log-tabs" onKeyDown={moveBetweenTabs}>
        <ul>
          {(
            [
              ['runs', `#/log${runQuery ? `?${runQuery}` : ''}`, t('log.tabRuns')],
              ['changes', `#/log/changes${runQuery ? `?${runQuery}` : ''}`, t('log.tabChanges')],
            ] as const
          ).map(([id, href, label]) => (
            <li key={id}>
              <a href={href} aria-current={tab === id ? 'page' : undefined}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {tab === 'runs' ? (
        <RunsTab api={api} tenant={tenant} live={live} query={route.query} />
      ) : null}
      {tab === 'changes' && live ? (
        <LiveChanges api={api} tenant={tenant} filters paged />
      ) : tab === 'changes' ? (
        <ChangesTab changes={changes} />
      ) : null}
    </div>
  );
};
