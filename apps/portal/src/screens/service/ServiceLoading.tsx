import { Button, Heading } from '@digdir/designsystemet-react';
import { BackLink } from '../../components/BackLink';
import { HeadingSkeleton } from '../../components/Skeleton';
import { useT } from '../../i18n';
import { knownServiceName } from '../../listed-services';
import { Loading } from '../../states';
import { ServiceNav } from './ServiceNav';
import { availableSections, servicePath, type ServiceSection } from './sections';

export const ServiceLoading = ({
  tenant,
  id,
  section,
  label,
  onRetry,
}: {
  tenant: string;
  id: string;
  section: ServiceSection;
  label: string;
  onRetry?: () => void;
}) => {
  const t = useT();
  const name = knownServiceName(tenant, id);
  return (
    <div className="service-page">
      <header className="service-head">
        <BackLink label={t('service.back')} href="#/services" />
        <div className="service-head-row">
          <div className="service-title">
            {name ? (
              <Heading level={1} data-size="md">
                {name}
              </Heading>
            ) : (
              <HeadingSkeleton label={label} />
            )}
          </div>
          <div className="service-actions">
            <Button asChild variant="secondary" data-size="sm">
              <a href={`#${servicePath(id, 'test')}`}>{t('edition.tryIt')}</a>
            </Button>
            <Button variant="primary" data-size="sm" aria-disabled>
              {t('edition.publish')}
            </Button>
          </div>
        </div>
      </header>
      <ServiceNav
        id={id}
        name={name}
        sections={availableSections({ isNew: false })}
        current={section}
      />
      <Loading label={label} shape="service" {...(onRetry ? { onRetry } : {})} />
    </div>
  );
};
