import { Breadcrumbs, Heading, Tag } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { statusKeys } from '../../data/service-labels';
import { statusColor, type ServiceStatus } from '../../data/services';
import { useT } from '../../i18n';

export const ServiceHeader = ({
  name,
  status,
  meta,
  flash,
  actions,
  trail = [],
}: {
  name: string;
  status: ServiceStatus;
  meta: string;
  flash: string;
  actions: ReactNode;
  /** Pages between Tjenester and this one, for a page inside a service such as publishing. */
  trail?: readonly { label: string; href: string }[];
}) => {
  const t = useT();
  const crumbs = [{ label: t('service.back'), href: '#/services' }, ...trail];
  const parent = crumbs.at(-1) ?? crumbs[0];
  return (
    <header className="service-head">
      <Breadcrumbs aria-label={t('components.breadcrumbs')} data-size="sm">
        {parent ? (
          <Breadcrumbs.Link
            href={parent.href}
            aria-label={t('components.backTo', { label: parent.label })}
          >
            {parent.label}
          </Breadcrumbs.Link>
        ) : null}
        <Breadcrumbs.List>
          {crumbs.map((c) => (
            <Breadcrumbs.Item key={c.href}>
              <Breadcrumbs.Link href={c.href}>{c.label}</Breadcrumbs.Link>
            </Breadcrumbs.Item>
          ))}
        </Breadcrumbs.List>
      </Breadcrumbs>
      <div className="service-head-row">
        <div className="service-title">
          <Heading level={1} data-size="md">
            {name}
          </Heading>
          <Tag data-size="sm" data-color={statusColor[status]}>
            {t(statusKeys[status])}
          </Tag>
          <span className="meta">{meta}</span>
        </div>
        <div className="service-actions">
          <span aria-live="polite" className="service-flash">
            {flash}
          </span>
          {actions}
        </div>
      </div>
    </header>
  );
};
