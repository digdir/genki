import { useEffect } from 'react';
import { LinkTabs } from '../../components/LinkTabs';
import { useT } from '../../i18n';
import {
  sectionLabels,
  serviceTabs,
  servicePath,
  subSections,
  tabLabels,
  tabOf,
  type ServiceSection,
} from './sections';

export const ServiceNav = ({
  id,
  name,
  sections,
  current,
}: {
  id: string;
  name?: string | undefined;
  sections: ServiceSection[];
  current: ServiceSection;
}) => {
  const t = useT();
  const tab = tabOf(current);
  useEffect(() => {
    document
      .querySelector('.service-nav [aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <LinkTabs
      label={t('service.navLabel', { name: name || id })}
      className="service-nav"
      current={tab}
      tabs={serviceTabs(sections).map(({ tab: each, target }) => ({
        key: each,
        label: t(tabLabels[each]),
        href: `#${servicePath(id, target)}`,
      }))}
    />
  );
};

export const ServiceSubNav = ({
  id,
  sections,
  current,
}: {
  id: string;
  sections: ServiceSection[];
  current: ServiceSection;
}) => {
  const t = useT();
  const tab = tabOf(current);
  const links = subSections(tab, sections);
  if (links.length < 2) return null;
  return (
    <LinkTabs
      label={t(tabLabels[tab])}
      className="service-subnav"
      current={current}
      tabs={links.map((s) => ({
        key: s,
        label: t(sectionLabels[s]),
        href: `#${servicePath(id, s)}`,
      }))}
    />
  );
};
