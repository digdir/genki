import { XMarkIcon } from '@navikt/aksel-icons';
import { Button, Heading } from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useEscape, useNarrow } from '../hooks';
import { Icon } from './Icon';

export const SidePanel = ({
  title,
  eyebrow,
  onClose,
  children,
  footer,
  width = 460,
}: {
  title: string;
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) => {
  const t = useT();
  const narrow = useNarrow();
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  useEscape(true, onClose);
  useEffect(() => {
    returnTo.current = document.activeElement;
    ref.current?.focus();
    return () => {
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
  }, []);
  // In the body, so a sticky or scrolling column it opens from cannot paint over it.
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal={narrow ? 'true' : 'false'}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="side-panel"
      style={{ width: narrow ? '100%' : `min(${width}px, 100vw)` }}
    >
      <div className="side-panel-head">
        <div className="side-panel-title">
          {eyebrow ? <span className="meta">{eyebrow}</span> : null}
          <Heading level={2} data-size="xs" id={headingId}>
            {title}
          </Heading>
        </div>
        <Button
          variant="tertiary"
          data-size="sm"
          icon
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon icon={XMarkIcon} />
        </Button>
      </div>
      <div className="side-panel-body">{children}</div>
      {footer ? <div className="side-panel-foot">{footer}</div> : null}
    </div>,
    document.body,
  );
};
