import { Alert, Button, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n.js';

export interface EmptyStateProps {
  /** What is missing, said plainly. */
  title: string;
  /** What the person can do about it. */
  description?: string | undefined;
  /** 3 under a panel head, 2 when the state is the whole page. Sets the size too. */
  level?: 2 | 3 | 4 | undefined;
  /** A button or link that resolves it. */
  children?: ReactNode;
}

const titleSize = { 2: 'lg', 3: '2xs', 4: '2xs' } as const;

/** Nothing to show yet. A normal state, not an error, so no alert and no announcement. */
export const EmptyState = ({ title, description, level = 3, children }: EmptyStateProps) => (
  <div className="uib-states-empty">
    <Heading level={level} data-size={titleSize[level]}>
      {title}
    </Heading>
    {description ? (
      <Paragraph data-size="sm" variant="long">
        {description}
      </Paragraph>
    ) : null}
    {children}
  </div>
);

export interface ErrorStateProps {
  /** A heading in the alert. */
  title?: string | undefined;
  /** Nothing is shown or announced while this is undefined. */
  message?: string | undefined;
  /** Offers «Prøv igjen». */
  onRetry?: (() => void) | undefined;
  /** Where focus goes when a retry clears the error. The alert region when not given. */
  focusAfterRetry?: RefObject<HTMLElement | null> | undefined;
  /** The retry button, for an app whose own control went away with the error. */
  retryRef?: RefObject<HTMLButtonElement | null> | undefined;
}

/**
 * An error the person needs to see. Keep it drawn and pass `message` when there is one:
 * `role="alert"` announces only what appears in a region that is already there.
 */
export const ErrorState = ({
  title,
  message,
  onRetry,
  focusAfterRetry,
  retryRef,
}: ErrorStateProps) => {
  const t = useT();
  const region = useRef<HTMLDivElement>(null);
  const retryHeldFocus = useRef(false);

  useEffect(() => {
    if (message || !retryHeldFocus.current) return;
    retryHeldFocus.current = false;
    // Only focus that was lost: the app's retry may already have moved it on purpose.
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    (focusAfterRetry?.current ?? region.current)?.focus();
  }, [message, focusAfterRetry]);

  const retry = () => {
    retryHeldFocus.current = region.current?.contains(document.activeElement) ?? false;
    onRetry?.();
  };

  return (
    <div role="alert" className="uib-states-error ds-focus" tabIndex={-1} ref={region}>
      {message ? (
        <Alert data-color="danger">
          {title ? (
            <Heading level={3} data-size="2xs">
              {title}
            </Heading>
          ) : null}
          <Paragraph variant="long">{message}</Paragraph>
          {onRetry ? (
            <Button variant="secondary" data-size="sm" onClick={retry} ref={retryRef}>
              {t('states.retry')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
};

export interface NotFoundStateProps {
  /** The front page's address. */
  homeHref: string;
  /** For an app with its own router: called on a plain click instead of following the link. */
  onGoHome?: (() => void) | undefined;
  /** What was not found. Without it, the page itself, with the package's own description. */
  title?: string | undefined;
  /** Why it may not be there. */
  description?: string | undefined;
}

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** An address or item that does not exist, with the one way out. The page is this, so no alert. */
export const NotFoundState = ({ homeHref, onGoHome, title, description }: NotFoundStateProps) => {
  const t = useT();
  return (
    <EmptyState
      level={2}
      title={title ?? t('states.notFoundTitle')}
      description={
        description ?? (title === undefined ? t('states.notFoundDescription') : undefined)
      }
    >
      <Link
        href={homeHref}
        onClick={(event) => {
          if (!onGoHome || !plainClick(event)) return;
          event.preventDefault();
          onGoHome();
        }}
      >
        {t('states.goHome')}
      </Link>
    </EmptyState>
  );
};
