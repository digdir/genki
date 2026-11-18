import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { ErrorState, refusalOf } from '../../states';

export const PageError = ({
  error,
  title,
  text,
  onRetry,
  children,
}: {
  error: unknown;
  title: string;
  text: string;
  onRetry: () => void;
  children?: ReactNode;
}) => {
  const t = useT();
  if (refusalOf(error, t)) return <ErrorState error={error} onRetry={onRetry} headingLevel={3} />;
  return (
    <Alert data-color="danger" className="dev-page-error">
      <Heading level={3} data-size="xs">
        {title}
      </Heading>
      <Paragraph>{text}</Paragraph>
      <div className="actions">
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('common.tryAgain')}
        </Button>
        {children}
      </div>
    </Alert>
  );
};

export const PageEmpty = ({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) => (
  <div className="dev-page-empty">
    <Heading level={3} data-size="xs">
      {title}
    </Heading>
    <Paragraph>{text}</Paragraph>
    {children}
  </div>
);

export const PageLead = ({ text, children }: { text: string; children?: ReactNode }) => (
  <div className="int-intro">
    <Paragraph className="meta int-intro-text">{text}</Paragraph>
    {children}
  </div>
);
