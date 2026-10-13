import { Alert, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useT } from '../i18n';
import { PageHeader } from '../ui';

export const PlatformDefaults = () => {
  const t = useT();
  return (
    <>
      <PageHeader title={t('policies.defaultsTitle')} intro={t('policies.defaultsIntro')} />
      <Alert data-color="warning">
        <Heading level={2} data-size="2xs">
          {t('policies.defaultsReplaced')}
        </Heading>
        <Paragraph>{t('policies.defaultsText')}</Paragraph>
        <a className="ds-button" data-variant="primary" data-size="sm" href="#/settings">
          {t('policies.defaultsOpen')}
        </a>
      </Alert>
    </>
  );
};
