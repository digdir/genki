import { useEffect, useRef, type KeyboardEvent } from 'react';
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

const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) return;
  const to =
    event.key === 'ArrowRight'
      ? (at + 1) % links.length
      : event.key === 'ArrowLeft'
        ? (at - 1 + links.length) % links.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? links.length - 1
            : undefined;
  if (to === undefined) return;
  event.preventDefault();
  links[to]?.focus();
};

export const ServiceNav = ({
  id,
  sections,
  current,
}: {
  id: string;
  sections: ServiceSection[];
  current: ServiceSection;
}) => {
  const t = useT();
  const nav = useRef<HTMLElement>(null);
  const tab = tabOf(current);
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  return (
    <nav ref={nav} aria-label={t('service.navLabel')} className="service-nav" onKeyDown={moveFocus}>
      <ul>
        {serviceTabs(sections).map(({ tab: each, target }) => (
          <li key={each}>
            <a
              href={`#${servicePath(id, target)}`}
              aria-current={each === tab ? 'page' : undefined}
            >
              {t(tabLabels[each])}
            </a>
          </li>
        ))}
      </ul>
    </nav>
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
    <nav aria-label={t(tabLabels[tab])} className="service-subnav" onKeyDown={moveFocus}>
      <ul>
        {links.map((s) => (
          <li key={s}>
            <a href={`#${servicePath(id, s)}`} aria-current={s === current ? 'page' : undefined}>
              {t(sectionLabels[s])}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};
