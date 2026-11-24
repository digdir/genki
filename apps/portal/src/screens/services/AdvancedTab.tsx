import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { LinkTabs } from '../../components/LinkTabs';
import { useT, type PlainKey } from '../../i18n';
import { advancedItems, servicePath, type AdvancedItem } from '../service/sections';
import './advanced-tab.css';

const labels: Record<AdvancedItem, PlainKey> = {
  how: 'setupList.areaHow',
  tools: 'setupList.areaTools',
  variants: 'setupList.areaVariants',
  limits: 'setupList.areaLimits',
  channels: 'service.sectionChannels',
  json: 'service.advancedJson',
  yaml: 'service.advancedYaml',
};

const help: Record<AdvancedItem, PlainKey | undefined> = {
  how: 'setupList.helpHow',
  tools: 'setupList.helpTools',
  variants: 'setupList.helpVariants',
  limits: 'setupList.helpLimits',
  channels: 'setupList.helpChannels',
  json: 'builderBlocks.transferHelp',
  // The YAML field describes itself.
  yaml: undefined,
};

/** The Avansert tab of the new Oppsett: a menu on the left and the chosen part beside it. */
export const AdvancedTab = ({
  id,
  current,
  children,
}: {
  id: string;
  current: AdvancedItem;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <div className="service-sub advanced-tab">
      <LinkTabs
        label={t('service.tabAdvanced')}
        className="service-subnav"
        orientation="vertical"
        current={current}
        tabs={advancedItems.map((item) => ({
          key: item,
          label: t(labels[item]),
          href: `#${servicePath(id, 'advanced', `/${item}`)}`,
        }))}
      />
      <section className="service-sub-body stack advanced-body" aria-labelledby="advanced-h">
        <div className="stack-xs">
          <Heading level={2} data-size="md" id="advanced-h">
            {t(labels[current])}
          </Heading>
          {help[current] ? <Paragraph className="meta">{t(help[current])}</Paragraph> : null}
        </div>
        {children}
      </section>
    </div>
  );
};
