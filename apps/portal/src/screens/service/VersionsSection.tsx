import { Tabs } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';

export type VersionsView = 'history' | 'yaml';

export const VersionsSection = ({
  view,
  onView,
  history,
  yaml,
  showHistory,
}: {
  view: VersionsView;
  onView: (view: VersionsView) => void;
  history: ReactNode;
  yaml: ReactNode;
  showHistory: boolean;
}) => {
  const t = useT();
  return showHistory ? (
    <Tabs value={view} onChange={(v) => onView(v === 'yaml' ? 'yaml' : 'history')}>
      <Tabs.List aria-label={t('serviceVersions.listLabel')}>
        <Tabs.Tab value="history">{t('serviceVersions.history')}</Tabs.Tab>
        <Tabs.Tab value="yaml">YAML</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="history">{view === 'history' ? history : null}</Tabs.Panel>
      <Tabs.Panel value="yaml">{view === 'yaml' ? yaml : null}</Tabs.Panel>
    </Tabs>
  ) : (
    <>{yaml}</>
  );
};
