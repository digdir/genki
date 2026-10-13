import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { sectionLabels, servicePath, type ServiceSection } from './sections';

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
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  return (
    <nav ref={nav} aria-label={t('service.navLabel')} className="service-nav">
      <ul>
        {sections.map((s) => (
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
