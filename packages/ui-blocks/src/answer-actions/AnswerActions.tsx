import { Dropdown } from '@digdir/designsystemet-react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FilesIcon,
  FileTextIcon,
  LinkIcon,
  ClipboardIcon,
} from '@navikt/aksel-icons';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { classes } from '../dom.js';
import { useFeedback } from './Feedback.js';
import { useT } from './i18n.js';
import type { AnswerCopied, AnswerFeedback, AnswerFeedbackStatus } from './types.js';

export interface AnswerActionsProps {
  /** Shows «Kopier» with «Kun svaret». The app copies the answer's words, without its sources. */
  onCopyAnswer?: (() => void) | undefined;
  /** «Svaret med kildeliste» in «Kopier». The app copies the answer and its sources as markdown. */
  onCopyWithSources?: (() => void) | undefined;
  /** «Lenke til tråden» in «Kopier»; without it the choice is drawn disabled. */
  onCopyLink?: (() => void) | undefined;
  /** The link opens the thread only for this person, in this browser, and the block says so. */
  linkOnlyHere?: boolean | undefined;
  /** What the app's last copy did. Pass a new object for each copy; the receipt clears itself. */
  copied?: AnswerCopied | undefined;
  /**
   * Shows a thumb up and a thumb down first in the row, with `onFeedback`. Off unless asked for:
   * kunnskapsassistenten took the feedback under each answer out on 6 October 2026, because it
   * adds a lot of noise under every answer, and its decision log has it to be rethought.
   */
  feedback?: boolean | undefined;
  /**
   * The app sends the rating, reasons and comment. Raised on the click on a thumb, and again in
   * full when the reasons and comment are sent or the rating changes. Drawn only with `feedback`.
   */
  onFeedback?: ((feedback: AnswerFeedback) => void) | undefined;
  /** How the app's sending went. */
  feedbackStatus?: AnswerFeedbackStatus | undefined;
  /** The app's own actions, after «Kopier». */
  actions?: ReactNode;
  /** At the far end of the row, outside every button. */
  end?: ReactNode;
  /** Designsystemet's `data-color` for the block. Neutral unless given, as kunnskapsassistenten. */
  color?: string | undefined;
  className?: string | undefined;
}

/** How long a copy receipt stays on screen. */
export const RECEIPT_MS = 4000;

/** Shows each new receipt the app passes, and clears it after {@link RECEIPT_MS}. */
const useReceipt = (copied: AnswerCopied | undefined) => {
  const [shown, setShown] = useState(copied);
  useEffect(() => {
    setShown(copied);
    if (!copied) return;
    const timer = setTimeout(() => setShown(undefined), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return shown;
};

/**
 * What a reader can do with a finished answer: say whether it was useful, and copy it, with or
 * without its sources, or the link to its thread, from one «Kopier» menu. The block only raises
 * events; the app copies and sends, and passes back what happened.
 */
export const AnswerActions = ({
  onCopyAnswer,
  onCopyWithSources,
  onCopyLink,
  linkOnlyHere,
  copied,
  feedback = false,
  onFeedback,
  feedbackStatus,
  actions,
  end,
  color = 'neutral',
  className,
}: AnswerActionsProps) => {
  const t = useT();
  const noteId = useId();
  const receiptRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const receipt = useReceipt(copied);
  // Controlled: a choice closes the menu before the app copies, so the receipt is not hidden.
  const [open, setOpen] = useState(false);
  const note = t('answerActions.linkOnlyHere');
  const asks = feedback && onFeedback !== undefined;
  const rating = useFeedback({ status: feedbackStatus, onSend: onFeedback ?? (() => {}) });

  // The receipt grows the column under a reader at the end; `nearest` moves it no further
  // than it must. A drawn focus ring then takes back what it needs; a pointer draws none.
  useEffect(() => {
    if (!receipt) return;
    const focused = document.activeElement;
    receiptRef.current?.scrollIntoView?.({ block: 'nearest' });
    if (focused instanceof HTMLElement && focused.matches(':focus-visible'))
      focused.scrollIntoView?.({ block: 'nearest' });
  }, [receipt]);

  const copies = Boolean(onCopyAnswer || onCopyWithSources || onCopyLink);
  if (!copies && !asks && actions === undefined && end === undefined) return null;

  const receiptText = !receipt
    ? ''
    : receipt.kind === 'failed'
      ? t('answerActions.copyFailed')
      : receipt.kind === 'link'
        ? linkOnlyHere
          ? `${t('answerActions.linkCopied')} ${note}.`
          : t('answerActions.linkCopied')
        : receipt.sources
          ? t('answerActions.copiedWithSources', { count: receipt.sources })
          : t('answerActions.copied');

  // The choice goes with the closed menu, so focus goes back to «Kopier», where it came from.
  const choose = (action: () => void) => {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  };
  const choice = (
    label: string,
    icon: ReactNode,
    action: (() => void) | undefined,
    note?: string,
  ) => (
    <Dropdown.Item>
      <Dropdown.Button
        disabled={!action}
        aria-describedby={note ? noteId : undefined}
        onClick={action ? () => choose(action) : undefined}
      >
        {icon}
        {label}
      </Dropdown.Button>
      {/* Seen under the choice and read as its description, not part of its name. */}
      {note ? (
        <span id={noteId} className="uib-answer-actions-note">
          {note}
        </span>
      ) : null}
    </Dropdown.Item>
  );

  return (
    <div className={classes('uib-answer-actions', className)} data-color={color}>
      <div className="uib-answer-actions-row">
        {asks ? rating.thumbs : null}
        {copies ? (
          <Dropdown.TriggerContext>
            <Dropdown.Trigger ref={triggerRef} variant="tertiary" data-size="sm">
              <FilesIcon aria-hidden />
              {t('answerActions.copy')}
              {open ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
            </Dropdown.Trigger>
            <Dropdown
              open={open}
              onOpen={() => setOpen(true)}
              onClose={() => setOpen(false)}
              placement="bottom-start"
              data-size="sm"
            >
              {/* Buttons, not role="menu", as Designsystemet recommends without the arrow keys. */}
              <Dropdown.List>
                {onCopyAnswer
                  ? choice(
                      t('answerActions.copyAnswer'),
                      <ClipboardIcon aria-hidden />,
                      onCopyAnswer,
                    )
                  : null}
                {onCopyWithSources
                  ? choice(
                      t('answerActions.copyWithSources'),
                      <FileTextIcon aria-hidden />,
                      onCopyWithSources,
                    )
                  : null}
                {choice(
                  t('answerActions.copyLink'),
                  <LinkIcon aria-hidden />,
                  onCopyLink,
                  onCopyLink && linkOnlyHere ? `${note}.` : undefined,
                )}
              </Dropdown.List>
            </Dropdown>
          </Dropdown.TriggerContext>
        ) : null}
        {actions}
        {end !== undefined ? <span className="uib-answer-actions-end">{end}</span> : null}
        {/* Always drawn while there is something to copy, never hidden while empty: a
            live region and its text that arrive in the same frame announce nothing. */}
        {copies ? (
          <p aria-live="polite" className="uib-answer-actions-receipt" ref={receiptRef}>
            {receiptText}
          </p>
        ) : null}
      </div>
      {asks ? rating.panel : null}
    </div>
  );
};
