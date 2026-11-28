import { Alert, Button, Heading, Paragraph, Skeleton } from '@digdir/designsystemet-react';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { ShapeSkeleton, type SkeletonShape } from './components/Skeleton';
import { useT, type T } from './i18n';

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
            {t('common.tooSlowTitle')}
          </Heading>
          <Paragraph>{t('common.tooSlowText')}</Paragraph>
          {onRetry ? (
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => {
                onGiveUpRetry();
                onRetry();
              }}
            >
              {t('common.retry')}
            </Button>
          ) : null}
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
          <p className="loading-label">
            {/(\.\.\.|…)$/.test(label) ? label : t('common.loadingLine', { label })}
          </p>
          {stage === 'slow' ? <p className="loading-slow">{t('common.slow')}</p> : null}
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

interface BoundaryProps {
  path: string;
  children: ReactNode;
  onRetry: () => void;
}

interface BoundaryState {
  path: string;
  failed: boolean;
  error?: unknown;
}

export class ScreenBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { path: this.props.path, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.path === state.path ? null : { path: props.path, failed: false };
  }

  override render() {
    return this.state.failed ? (
      <ErrorState error={this.state.error} onRetry={this.props.onRetry} />
    ) : (
      this.props.children
    );
  }
}
