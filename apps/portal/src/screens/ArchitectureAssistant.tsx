import { Alert, Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { PlaygroundPanel } from '../components/playground/PlaygroundPanel';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';

/**
 * The service the page chats with. Each organisation publishes its own copy under this id,
 * so the page finds it in whichever organisation the person works in.
 */
export const architectureServiceId = 'arkitekturassistent';

/** The architecture assistant: a chat with the organisation's own architecture service. */
export const ArchitectureAssistant = ({ api, tenant, tenantName }: ScreenProps) => {
  const t = useT();
  const [options, retry] = useAsync(
    (signal) => api.playground.options(tenant, signal),
    [api, tenant],
  );
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="lg">
              {t('architecture.title')}
            </Heading>
            <Tag data-color="warning" data-size="sm">
              {t('architecture.draftTag')}
            </Tag>
          </div>
          <p className="lead">{t('architecture.lead')}</p>
        </div>
      </div>
      {options.status === 'loading' ? (
        <Loading label={t('architecture.loading')} />
      ) : options.status === 'error' ? (
        <ErrorState error={options.error} onRetry={retry} />
      ) : options.data.services.some((s) => s.id === architectureServiceId) ? (
        <>
          <Paragraph data-size="sm">{t('architecture.draft')}</Paragraph>
          <PlaygroundPanel
            layout="full"
            context="service"
            name={architectureServiceId}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            setupPlacement="send"
          />
        </>
      ) : (
        <Alert data-color="info" data-size="sm">
          <Heading level={2} data-size="2xs">
            {t('architecture.missingTitle', { tenant: tenantName })}
          </Heading>
          <Paragraph data-size="sm">
            {t('architecture.missing', { service: architectureServiceId })}
          </Paragraph>
          <Link href="#/services">{t('architecture.toServices')}</Link>
        </Alert>
      )}
    </div>
  );
};
