import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { PlaygroundPanel } from '../components/playground/PlaygroundPanel';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';

export const Playground = ({ api, tenant, tenantName }: ScreenProps) => {
  const t = useT();
  return (
    <div className="stack">
      <div className="playground-intro">
        <Heading level={1} data-size="lg">
          {t('playground.pageTitle')}
        </Heading>
        <Paragraph className="lead">{t('playground.pageLead')}</Paragraph>
      </div>
      <PlaygroundPanel layout="full" api={api} tenant={tenant} tenantName={tenantName} />
    </div>
  );
};
