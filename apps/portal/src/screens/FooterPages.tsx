import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

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
          code: link('#/developer/api'),
          api: link('#/developer/api/reference'),
        })}
      </Paragraph>
      <Heading level={2} data-size="sm">
        {t('app.guideFollowTitle')}
      </Heading>
      <Paragraph>
        {t.rich('app.guideFollow', {
          usage: link('#/statistics'),
          log: link('#/log'),
          access: link('#/access'),
          settings: link('#/settings'),
        })}
      </Paragraph>
      <Paragraph>{t('app.guideRights')}</Paragraph>
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
