import { Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

export const NotAvailable = ({
  children,
  level = 2,
  title,
}: {
  children: ReactNode;
  level?: 2 | 3;
  title?: string;
}) => {
  const t = useT();
  return (
    <div className="state empty not-available">
      <Heading level={level} data-size="xs">
        {title ?? t('components.notAvailableTitle')}
      </Heading>
      <Paragraph data-size="sm">{children}</Paragraph>
    </div>
  );
};
