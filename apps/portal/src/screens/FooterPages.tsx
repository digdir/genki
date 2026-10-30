import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { Loading } from '../states';

const link = (href: string) => (chunks: ReactNode) => <a href={href}>{chunks}</a>;

export const Guide = () => {
  const t = useT();
  return (
    <>
      <Paragraph>{t('app.guideIntro')}</Paragraph>
      <Heading level={2} data-size="sm">
        {t('app.guideStartTitle')}
      </Heading>
      <Paragraph>{t.rich('app.guideStart', { overview: link('#/overview') })}</Paragraph>
      <Heading level={2} data-size="sm">
        {t('app.guideBuildTitle')}
      </Heading>
      <Paragraph>
        {t.rich('app.guideBuild', {
          services: link('#/services'),
          datasets: link('#/datasets'),
          blocks: link('#/building-blocks'),
          shared: link('#/shared-services'),
        })}
      </Paragraph>
      <Heading level={2} data-size="sm">
        {t('app.guideTryTitle')}
      </Heading>
      <Paragraph>
        {t.rich('app.guideTry', {
          playground: link('#/playground'),
          code: link('#/developer/api/code'),
          api: link('#/api-reference'),
        })}
      </Paragraph>
      <Heading level={2} data-size="sm">
        {t('app.guideFollowTitle')}
      </Heading>
      <Paragraph>
        {t.rich('app.guideFollow', {
          usage: link('#/usage'),
          log: link('#/log'),
          access: link('#/access'),
          settings: link('#/settings'),
        })}
      </Paragraph>
      <Paragraph>{t('app.guideRights')}</Paragraph>
    </>
  );
};

export const Status = ({ api }: { api: Pick<ApiClient, 'getHealth'> }) => {
  const t = useT();
  const [health, retry] = useAsync((signal) => api.getHealth(signal), [api]);
  return (
    <>
      <Paragraph>{t('app.statusIntro')}</Paragraph>
      {health.status === 'loading' ? (
        <Loading label={t('app.statusChecking')} />
      ) : health.status === 'error' ? (
        <Alert data-color="danger">
          <Paragraph>{t('app.statusDown')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('app.statusCheckAgain')}
          </Button>
        </Alert>
      ) : (
        <dl>
          <dt>{t('app.statusApi')}</dt>
          <dd>{t('app.statusUp')}</dd>
          <dt>{t('app.statusVersion')}</dt>
          <dd>{health.data.version}</dd>
        </dl>
      )}
      <Paragraph>
        {t.rich('app.statusScope', { services: link('#/services'), log: link('#/log') })}
      </Paragraph>
    </>
  );
};

export const Contact = () => {
  const t = useT();
  return (
    <>
      <Paragraph>{t('app.contactOwner')}</Paragraph>
      <Paragraph>{t('app.contactText')}</Paragraph>
    </>
  );
};
