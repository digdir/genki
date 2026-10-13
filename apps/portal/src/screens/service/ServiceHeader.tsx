import { Heading, Tag } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { statusKeys } from '../../data/service-labels';
import { statusColor, type ServiceStatus } from '../../data/services';
import { useT } from '../../i18n';

export const ServiceHeader = ({
  name,
  status,
  meta,
  flash,
  actions,
}: {
  name: string;
  status: ServiceStatus;
  meta: string;
  flash: string;
  actions: ReactNode;
}) => {
  const t = useT();
  return (
    <header className="service-head">
      <a href="#/services" className="back-link">
        <Icon d="M15 6l-6 6 6 6" size={18} />
        {t('service.back')}
      </a>
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
