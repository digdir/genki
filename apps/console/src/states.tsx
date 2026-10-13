import { Alert, Button, Heading, Paragraph, Spinner } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { useT, type T } from './i18n';

export const Loading = ({ label }: { label: string }) => (
  <div className="state" role="status">
    <Spinner aria-label={label} data-size="md" />
  </div>
);

const messageFor = (error: unknown, t: T) => {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('common.loadUnauthenticated');
    if (error.status === 403) return t('common.loadForbidden');
    if (error.status === 404) return t('common.loadNotFound');
  }
  return t('common.loadFailed');
};

const endpointMissing = (error: unknown) =>
  error instanceof ApiError && [404, 405, 501].includes(error.status) && !error.problem;

export const ErrorState = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => {
  const t = useT();
  return endpointMissing(error) ? (
    <div className="state empty">
      <Heading level={2} data-size="xs">
        {t('common.unavailableTitle')}
      </Heading>
      <Paragraph>{t('common.unavailableText')}</Paragraph>
    </div>
  ) : (
    <Alert data-color="danger" className="state">
      <Heading level={2} data-size="xs">
        {t('common.loadFailedTitle')}
      </Heading>
      <Paragraph>{messageFor(error, t)}</Paragraph>
      {onRetry ? (
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </Alert>
  );
};

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="state empty">
    <Heading level={2} data-size="sm">
      {title}
    </Heading>
    {children}
  </div>
);
