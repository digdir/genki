import { Alert, Button, Heading, Link, Paragraph, Skeleton } from '@digdir/designsystemet-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { ShapeSkeleton, type SkeletonShape } from './components/Skeleton';
import { translator, useT, type T } from './i18n';

const nbT = translator('nb');

export const SKELETON_DELAY_MS = 300;
export const SLOW_AFTER_MS = 10_000;
export const GIVE_UP_AFTER_MS = 30_000;

type Stage = 'quiet' | 'skeleton' | 'slow' | 'failed';

const useLoadingStage = () => {
  const [stage, setStage] = useState<Stage>('quiet');
  useEffect(() => {
    const timers = [
      setTimeout(() => setStage('skeleton'), SKELETON_DELAY_MS),
      setTimeout(() => setStage('slow'), SLOW_AFTER_MS),
      setTimeout(() => setStage('failed'), GIVE_UP_AFTER_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);
  return stage;
};

export interface LoadingProps {
  label: string;
  shape?: SkeletonShape;
  rows?: number;
  columns?: number | string[];
  onRetry?: () => void;
}

const LoadingState = ({
  label,
  shape,
  rows,
  columns,
  onRetry,
  page,
  onGiveUpRetry,
}: LoadingProps & { shape: SkeletonShape; page: boolean; onGiveUpRetry: () => void }) => {
  const t = useT();
  const stage = useLoadingStage();
  if (stage === 'failed')
    return (
      <div className="state">
        <Alert data-color="danger">
          <Heading level={2} data-size="xs">
            {t('states.tooSlowTitle')}
          </Heading>
          <Paragraph>{t('states.tooSlowText')}</Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              onGiveUpRetry();
              if (onRetry) onRetry();
              else window.location.reload();
            }}
          >
            {t('common.tryAgain')}
          </Button>
        </Alert>
      </div>
    );
  return (
    <div
      className={page ? 'state loading page-loading' : 'state loading'}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {stage === 'quiet' ? null : (
        <>
          <span className="visually-hidden">{label}</span>
          {stage === 'slow' ? <p className="loading-slow">{t('states.slow')}</p> : null}
          {page ? (
            <Skeleton variant="rectangle" width="40%" height={32} aria-hidden="true" />
          ) : null}
          <ShapeSkeleton
            shape={shape}
            {...(rows === undefined ? {} : { rows })}
            {...(columns === undefined ? {} : { columns })}
          />
        </>
      )}
    </div>
  );
};

const Restartable = (props: LoadingProps & { shape: SkeletonShape; page: boolean }) => {
  const [round, setRound] = useState(0);
  return <LoadingState key={round} {...props} onGiveUpRetry={() => setRound((n) => n + 1)} />;
};

export const Loading = ({ shape = 'list', ...props }: LoadingProps) => (
  <Restartable {...props} shape={shape} page={false} />
);

export const PageLoading = ({ shape = 'detail', ...props }: LoadingProps) => (
  <Restartable {...props} shape={shape} page />
);

export const NavigationProgress = ({ label }: { label: string }) => (
  <div className="navigation-progress" role="progressbar" aria-label={label} />
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
