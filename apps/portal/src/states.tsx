import { Alert, Button, Heading, Link, Paragraph, Spinner } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { ApiError } from './api';
import { translator, useT, type T } from './i18n';

const nbT = translator('nb');

export const Loading = ({ label }: { label: string }) => (
  <div className="state loading" role="status">
    <Spinner aria-label={label} data-size="md" />
  </div>
);

const statusOf = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 0;

export const refusalOf = (error: unknown, t: T = nbT): string | undefined => {
  if (statusOf(error) !== 403) return undefined;
  const title =
    error instanceof ApiError
      ? error.problem?.title
      : error instanceof Error
        ? error.message
        : undefined;
  return title && !/^(Forbidden|Request failed)/.test(title) ? title : t('states.fallbackRefusal');
};

export const limitOf = (error: unknown, t: T = nbT) => {
  if (!(error instanceof ApiError) || error.status !== 429) return undefined;
  if (error.problem?.type === 'urn:genai:problem:quota-exhausted')
    return { title: t('states.quotaUsedUp'), quota: true };
  return {
    title: error.retryAfter
      ? t('states.tooManySeconds', { count: error.retryAfter })
      : t('states.tooMany'),
    quota: false,
  };
};

const messageFor = (error: unknown, t: T) => {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('states.signedOut');
    if (error.status === 404) return t('states.notFound');
    if (error.status === 409 && error.problem?.title) return error.problem.title;
  }
  return t('states.fetchFailed');
};

export const Refusal = ({
  error,
  headingLevel = 2,
}: {
  error: unknown;
  headingLevel?: 2 | 3 | 4;
}) => {
  const t = useT();
  return (
    <Alert data-color="info" data-size="sm">
      <Heading level={headingLevel} data-size="2xs">
        {t('states.noAccess')}
      </Heading>
      <Paragraph data-size="sm">{refusalOf(error, t) ?? t('states.fallbackRefusal')}</Paragraph>
    </Alert>
  );
};

export const Limit = ({
  error,
  onRetry,
  headingLevel = 2,
}: {
  error: unknown;
  onRetry?: () => void;
  headingLevel?: 2 | 3 | 4;
}) => {
  const t = useT();
  const limit = limitOf(error, t);
  if (!limit) return null;
  return (
    <Alert data-color="warning" data-size="sm">
      <Heading level={headingLevel} data-size="2xs">
        {limit.title}
      </Heading>
      {limit.quota ? (
        <Link href="#/statistics">{t('states.seeUsage')}</Link>
      ) : onRetry ? (
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('common.tryAgain')}
        </Button>
      ) : null}
    </Alert>
  );
};

export const ErrorState = ({
  error,
  onRetry,
  headingLevel = 2,
}: {
  error: unknown;
  onRetry?: () => void;
  headingLevel?: 2 | 3 | 4;
}) => {
  const t = useT();
  return (
    <div className="state">
      {refusalOf(error, t) ? (
        <Refusal error={error} headingLevel={headingLevel} />
      ) : limitOf(error, t) ? (
        <Limit error={error} headingLevel={headingLevel} {...(onRetry ? { onRetry } : {})} />
      ) : (
        <Alert data-color="danger">
          <Heading level={headingLevel} data-size="xs">
            {t('states.couldNotFetch')}
          </Heading>
          <Paragraph>{messageFor(error, t)}</Paragraph>
          {onRetry ? (
            <Button variant="secondary" data-size="sm" onClick={onRetry}>
              {t('common.tryAgain')}
            </Button>
          ) : null}
        </Alert>
      )}
    </div>
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
