import { Heading, Tag } from '@digdir/designsystemet-react';
import { PadlockLockedIcon } from '@navikt/aksel-icons';
import type { ReactNode } from 'react';
import { statusKeys } from '../../data/service-labels';
import { statusColor, type ServiceStatus } from '../../data/services';
import { useT } from '../../i18n';
import { BackLink } from '../../components/BackLink';
import { Icon } from '../../components/Icon';
import type { EditionView } from './sections';

export const ServiceHeader = ({
  name,
  view,
  switchHrefs,
  status,
  lifecycle,
  flash,
  actions,
}: {
  name: string;
  view: EditionView;
  switchHrefs?: { test: string; inUse: string } | undefined;
  status: ReactNode;
  lifecycle?: ServiceStatus | undefined;
  flash: string;
  actions: ReactNode;
}) => {
  const t = useT();
  const showSwitch = switchHrefs && (view === 'test' || view === 'inUse');
  return (
    <header className="service-head">
      <BackLink label={t('service.back')} href="#/services" />
      <div className="service-head-row">
        <div className="service-title">
          <Heading level={1} data-size="md">
            {name}
          </Heading>
          {showSwitch ? (
            <nav aria-label={t('edition.switchLabel')} className="edition-switch">
              <a
                href={`#${switchHrefs.test}`}
                aria-current={view === 'test' ? 'page' : undefined}
                data-edition="test"
              >
                {t('edition.test')}
              </a>
              <a
                href={`#${switchHrefs.inUse}`}
                aria-current={view === 'inUse' ? 'page' : undefined}
                data-edition="in-use"
              >
                <Icon icon={PadlockLockedIcon} size={16} />
                {t('edition.inUse')}
              </a>
            </nav>
          ) : null}
          {lifecycle ? (
            <Tag data-size="sm" data-color={statusColor[lifecycle]}>
              {t(statusKeys[lifecycle])}
            </Tag>
          ) : null}
        </div>
        <div className="service-actions">
          <span aria-live="polite" className="service-flash">
            {flash}
          </span>
          {actions}
        </div>
      </div>
      {status ? <p className="service-status">{status}</p> : null}
    </header>
  );
};
