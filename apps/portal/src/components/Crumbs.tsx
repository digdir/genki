import { Fragment } from 'react';
import { useT } from '../i18n';
import { useInServicePage } from '../screens/service/context';

export const Crumbs = ({ items }: { items: { label: string; href?: string }[] }) => {
  const t = useT();
  if (useInServicePage()) return null;
  return (
    <nav aria-label={t('components.breadcrumbs')} className="crumbs">
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {i > 0 ? <span aria-hidden="true">/</span> : null}
          {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
};
