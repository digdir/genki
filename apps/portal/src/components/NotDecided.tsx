import { Tag } from '@digdir/designsystemet-react';
import { useT } from '../i18n';

export const NotDecided = () => {
  const t = useT();
  return (
    <Tag data-color="warning" data-size="sm">
      {t('components.notDecided')}
    </Tag>
  );
};
