import { Paragraph } from '@digdir/designsystemet-react';
import { useT } from '../i18n';

export const Contact = () => {
  const t = useT();
  return (
    <>
      <Paragraph>{t('app.contactOwner')}</Paragraph>
      <Paragraph>{t('app.contactText')}</Paragraph>
    </>
  );
};
