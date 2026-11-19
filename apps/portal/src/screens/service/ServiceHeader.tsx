import { Heading, Tag } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { statusKeys } from '../../data/service-labels';
import { statusColor, type ServiceStatus } from '../../data/services';
import { useT } from '../../i18n';
import { BackLink } from '../../components/BackLink';

export const ServiceHeader = ({
  name,
  status,
  meta,
  flash,
  actions,
  tag,
}: {
  name: string;
  status: ServiceStatus;
  meta: string;
  tag?: string | undefined;
  flash: string;
  actions: ReactNode;
}) => {
  const t = useT();
  return (
    <header className="service-head">
      <BackLink label={t('service.back')} href="#/services" />
      <div className="service-head-row">
        <div className="service-title">
          <Heading level={1} data-size="md">
            {name}
          </Heading>
          <Tag data-size="sm" data-color={statusColor[status]}>
            {tag ?? t(statusKeys[status])}
          </Tag>
        </div>
        <div className="service-actions">
          <span aria-live="polite" className="service-flash">
            {flash}
          </span>
          {actions}
        </div>
      </div>
      {meta ? <p className="meta service-meta">{meta}</p> : null}
    </header>
  );
};
