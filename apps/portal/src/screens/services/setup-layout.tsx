import {
  Button,
  Heading,
  Paragraph,
  Tag,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { ChevronRightIcon } from '@navikt/aksel-icons';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT, type PlainKey } from '../../i18n';
import { areaLabelKeys } from './setup-change-text';
import { advancedAreas, basicAreas, setupAreas, type SetupArea } from './setup-diff';
import './setup-layout.css';

export type AreaStatus = 'done' | 'changed' | 'missing' | 'optional';

export interface AreaFact {
  status: AreaStatus;
  summary: string;
  fromAssistant?: boolean;
}

const statusKeys: Record<AreaStatus, PlainKey> = {
  done: 'setupList.statusDone',
  changed: 'setupList.statusChanged',
  missing: 'setupList.statusMissing',
  optional: 'setupList.statusOptional',
};

const helpKeys: Record<SetupArea, PlainKey> = {
  purpose: 'setupList.helpPurpose',
  sources: 'setupList.helpSources',
  input: 'setupList.helpInput',
  result: 'setupList.helpResult',
  model: 'setupList.helpModel',
  tools: 'setupList.helpTools',
  how: 'setupList.helpHow',
  variants: 'setupList.helpVariants',
  guards: 'setupList.helpGuards',
  risk: 'setupList.helpRisk',
  limits: 'setupList.helpLimits',
};

export type SidePane = 'assistant' | 'try';

export const SetupLayout = ({
  current,
  onPick,
  facts,
  children,
  assistant,
  tryPane,
  pane,
  onPane,
}: {
  current: SetupArea;
  onPick: (area: SetupArea) => void;
  facts: Record<SetupArea, AreaFact>;
  children: ReactNode;
  assistant?: ReactNode;
  tryPane: ReactNode;
  pane: SidePane;
  onPane: (pane: SidePane) => void;
}) => {
  const t = useT();
  const [advancedOpen, setAdvancedOpen] = useState(advancedAreas.includes(current));
  const [tried, setTried] = useState(pane === 'try');
  useEffect(() => {
    if (advancedAreas.includes(current)) setAdvancedOpen(true);
  }, [current]);
  const missing = advancedAreas.filter((a) => facts[a].status === 'missing').length;
  const used = advancedAreas.filter((a) => facts[a].status !== 'optional').length;
  const index = setupAreas.indexOf(current);
  const next = setupAreas[(index + 1) % setupAreas.length] ?? 'purpose';
  const pick = (area: SetupArea) => {
    if (advancedAreas.includes(area)) setAdvancedOpen(true);
    onPick(area);
  };
  const item = (area: SetupArea) => {
    const fact = facts[area];
    return (
      <li key={area}>
        <button
          type="button"
          className="setup-nav-item"
          aria-current={area === current ? 'true' : undefined}
          onClick={() => pick(area)}
        >
          <span className="setup-nav-line">
            <span aria-hidden="true" className={`setup-dot ${fact.status}`} />
            <span className="setup-nav-name">{t(areaLabelKeys[area])}</span>
            <span className={`setup-nav-status ${fact.status}`}>{t(statusKeys[fact.status])}</span>
          </span>
          <span className="setup-nav-summary">{fact.summary}</span>
          {fact.fromAssistant ? (
            <Tag data-size="sm" data-color="info" className="setup-nav-tag">
              {t('setup.fromAssistant')}
            </Tag>
          ) : null}
        </button>
      </li>
    );
  };
  return (
    <div className="setup-layout">
      <nav aria-label={t('setupList.navLabel')} className="setup-nav">
        <span className="setup-nav-group">{t('setupList.groupBasic')}</span>
        <ul className="setup-nav-list">{basicAreas.map(item)}</ul>
        <button
          type="button"
          className="setup-nav-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span className={advancedOpen ? 'setup-chevron open' : 'setup-chevron'}>
            <Icon icon={ChevronRightIcon} />
          </span>
          <span className="setup-nav-name">{t('setupList.groupAdvanced')}</span>
          <span className={missing ? 'setup-nav-count missing' : 'setup-nav-count'}>
            {missing
              ? t('setupList.advancedMissing', { count: missing })
              : t('setupList.advancedInUse', { used, count: advancedAreas.length })}
          </span>
        </button>
        {advancedOpen ? <ul className="setup-nav-list">{advancedAreas.map(item)}</ul> : null}
      </nav>

      <section aria-labelledby="setup-area-h" className="setup-area">
        <div className="setup-area-head">
          <span className="meta">
            {t(basicAreas.includes(current) ? 'setupList.groupBasic' : 'setupList.groupAdvanced')}
          </span>
          <Heading level={2} data-size="md" id="setup-area-h">
            {t(areaLabelKeys[current])}
          </Heading>
          <Paragraph className="meta">{t(helpKeys[current])}</Paragraph>
        </div>
        {children}
        <div className="setup-area-foot">
          <span className="meta">{t('setupList.savedNote')}</span>
          <Button variant="primary" data-size="sm" onClick={() => pick(next)}>
            {t('setupList.next', { name: t(areaLabelKeys[next]) })}
          </Button>
        </div>
      </section>

      <div className="setup-side" role="region" aria-label={t('setupList.sideLabel')}>
        <Tabs
          value={pane}
          onChange={(v) => {
            if (v === 'try') setTried(true);
            onPane(v as SidePane);
          }}
          data-size="sm"
        >
          <TabsList aria-label={t('setupList.sideTabs')}>
            <TabsTab value="assistant">{t('setupList.tabAssistant')}</TabsTab>
            <TabsTab value="try">{t('setupList.tabTry')}</TabsTab>
          </TabsList>
          <TabsPanel value="assistant">{assistant}</TabsPanel>
          <TabsPanel value="try">{tried || pane === 'try' ? tryPane : null}</TabsPanel>
        </Tabs>
      </div>
    </div>
  );
};
