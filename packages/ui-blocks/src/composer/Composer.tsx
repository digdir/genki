import { Button, Chip, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { ArrowDownIcon, PaperclipIcon, PaperplaneIcon, StopIcon } from '@navikt/aksel-icons';
import {
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { useT } from '../i18n.js';
import { AttachmentList, useAttachmentText, useUploadAnnouncement } from './Attachments.js';
import { shortcutModifier, useComposerShortcut } from './shortcut.js';
import type { ComposerAttachments } from './types.js';

export type * from './types.js';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Sends a question, the field's or a follow-up's: trimmed, and never empty. */
  onSubmit: (question: string) => void;
  /** True while the assistant answers. Nothing is sent meanwhile. */
  working?: boolean | undefined;
  /** Makes the send button «Avbryt» while the assistant answers. */
  onCancel?: (() => void) | undefined;
  placeholder?: string | undefined;
  /** What the assistant is called, in the field's name and the disclaimer. */
  assistantName?: string | undefined;
  showDisclaimer?: boolean | undefined;
  /** Questions under the field that are sent as they are. */
  followUps?: readonly string[] | undefined;
  attachments?: ComposerAttachments | undefined;
  /** Draws «Bla til bunnen» over the field. Leave it out when the conversation is at its end. */
  onScrollToBottom?: (() => void) | undefined;
  /** The host's controls beside the send button, such as the variant picker. */
  actions?: ReactNode;
  /** Ctrl+/ or Cmd+/ anywhere on the page puts the caret in the field. On unless switched off. */
  shortcut?: boolean | undefined;
  /** Stays at the foot of a scrolling conversation, with a fade over it. */
  sticky?: boolean | undefined;
  /** Designsystemet's `data-color` for the block, set only when given. */
  color?: string | undefined;
  /** The same for the send button and the follow-ups, which can stand out from the block. */
  actionColor?: string | undefined;
  fieldRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  sendRef?: RefObject<HTMLButtonElement | null> | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
  className?: string | undefined;
}

type Refusal = 'wait' | 'unavailable';

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');

/** The disclaimer under the field, for a host that draws it elsewhere, such as at the foot of a start page. */
export const ComposerDisclaimer = ({
  assistantName,
  color,
  className,
}: {
  assistantName?: string | undefined;
  color?: string | undefined;
  className?: string | undefined;
}) => {
  const t = useT();
  return (
    <Paragraph
      className={classes('uib-composer-disclaimer', className)}
      data-color={color}
      data-size="sm"
    >
      {assistantName
        ? t('composer.disclaimer', { name: assistantName })
        : t('composer.disclaimerUnnamed')}
    </Paragraph>
  );
};

/**
 * The question field, its buttons and what stands around it. The field and the buttons are one
 * control to a reader, so the frame carries the border and the focus ring.
 */
export const Composer = ({
  value,
  onChange,
  onSubmit,
  working = false,
  onCancel,
  placeholder,
  assistantName,
  showDisclaimer = true,
  followUps,
  attachments,
  onScrollToBottom,
  actions,
  shortcut = true,
  sticky = false,
  color,
  actionColor,
  fieldRef,
  sendRef,
  ref,
  className,
}: ComposerProps) => {
  const t = useT();
  const ownField = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? ownField;
  const picker = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  const [dragDepth, setDragDepth] = useState(0);
  const [refusal, setRefusal] = useState<Refusal>();
  const text = useAttachmentText(attachments);
  const items = attachments?.items ?? [];
  const announcement = useUploadAnnouncement(items, text.error);
  const uploading = items.some((item) => item.status === 'uploading');
  const unavailable = attachments !== undefined && attachments.onAdd === undefined;
  useComposerShortcut(field, shortcut);

  const focusField = () => field.current?.focus();

  const trySubmit = (question: string) => {
    if (working) return;
    if (uploading) {
      setRefusal('wait');
      focusField();
      return;
    }
    setRefusal(undefined);
    const trimmed = question.trim();
    if (trimmed) onSubmit(trimmed);
  };

  const shownRefusal =
    refusal === 'unavailable'
      ? text.error('unavailable')
      : refusal === 'wait' && uploading
        ? t('composer.waitForUploads')
        : '';

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    trySubmit(value);
  };

  const drop = attachments
    ? {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          if (hasFiles(event)) setDragDepth((depth) => depth + 1);
        },
        onDragLeave: () => setDragDepth((depth) => Math.max(0, depth - 1)),
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (hasFiles(event)) event.preventDefault();
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          setDragDepth(0);
          if (!hasFiles(event)) return;
          event.preventDefault();
          if (!attachments.onAdd) {
            setRefusal('unavailable');
            return;
          }
          setRefusal(undefined);
          attachments.onAdd([...event.dataTransfer.files]);
        },
      }
    : {};

  return (
    <div
      className={classes('uib-composer', className)}
      data-sticky={sticky || undefined}
      data-color={color}
      ref={ref}
    >
      {onScrollToBottom ? (
        <Button
          className="uib-composer-scroll"
          data-color="neutral"
          data-size="sm"
          variant="secondary"
          onClick={(event) => {
            onScrollToBottom();
            if (event.detail === 0) field.current?.focus({ preventScroll: true });
          }}
        >
          <ArrowDownIcon aria-hidden />
          {t('composer.scrollToBottom')}
        </Button>
      ) : null}

      {attachments ? (
        <AttachmentList
          items={items}
          error={text.error}
          onRemove={(id) => {
            attachments.onRemove(id);
            focusField();
          }}
          onRetry={
            attachments.onRetry
              ? (id) => {
                  attachments.onRetry?.(id);
                  focusField();
                }
              : undefined
          }
        />
      ) : null}

      <div className="uib-composer-frame" data-dragging={dragDepth > 0 || undefined} {...drop}>
        <Textfield
          aria-describedby={shortcut ? descriptionId : undefined}
          aria-label={
            assistantName
              ? t('composer.field', { name: assistantName })
              : t('composer.fieldUnnamed')
          }
          className="uib-composer-field"
          multiline
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t('composer.placeholder')}
          ref={field}
          rows={1}
          title={shortcut ? t('composer.shortcutHint', { key: shortcutModifier() }) : undefined}
          value={value}
        />
        <div className="uib-composer-controls">
          {unavailable ? (
            <Button
              aria-disabled="true"
              aria-label={t('composer.attachSoonLabel')}
              className="uib-composer-attach"
              data-color="neutral"
              variant="tertiary"
            >
              <PaperclipIcon aria-hidden />
              <span className="uib-composer-attach-text">{t('composer.attachSoon')}</span>
            </Button>
          ) : attachments?.onAdd ? (
            <>
              <input
                accept={attachments.accept}
                className="uib-composer-file-input"
                multiple
                onChange={(event) => {
                  const picked = event.currentTarget.files;
                  if (picked?.length) {
                    setRefusal(undefined);
                    attachments.onAdd?.([...picked]);
                  }
                  event.currentTarget.value = '';
                }}
                ref={picker}
                tabIndex={-1}
                type="file"
              />
              <Button
                aria-label={text.attach}
                className="uib-composer-attach"
                data-color="neutral"
                icon
                onClick={() => picker.current?.click()}
                variant="tertiary"
              >
                <PaperclipIcon aria-hidden />
              </Button>
            </>
          ) : null}
          {actions ? <div className="uib-composer-actions">{actions}</div> : null}
          {working && onCancel ? (
            <Button
              aria-busy="true"
              aria-label={t('composer.cancelLabel')}
              className="uib-composer-send"
              data-color={actionColor}
              onClick={() => {
                onCancel();
                focusField();
              }}
              ref={sendRef}
              variant="secondary"
            >
              <StopIcon aria-hidden />
              {t('composer.cancel')}
            </Button>
          ) : (
            <Button
              aria-label={t('composer.send')}
              className="uib-composer-send"
              data-color={actionColor}
              disabled={value.trim().length === 0 || working}
              icon
              onClick={() => trySubmit(value)}
              ref={sendRef}
            >
              <PaperplaneIcon aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {dragDepth > 0 && !unavailable ? (
        <p aria-hidden="true" className="uib-composer-drop-hint">
          {t('composer.dropHint')}
        </p>
      ) : null}

      {shownRefusal ? <output className="uib-composer-refusal">{shownRefusal}</output> : null}

      {followUps?.length ? (
        <ul className="uib-composer-follow-ups">
          {followUps.map((question) => (
            <li key={question}>
              <Chip.Button
                data-color={actionColor}
                data-wrap="wrap"
                onClick={() => trySubmit(question)}
              >
                {question}
              </Chip.Button>
            </li>
          ))}
        </ul>
      ) : null}

      {showDisclaimer ? <ComposerDisclaimer assistantName={assistantName} /> : null}

      {shortcut ? (
        <p className="uib-visually-hidden" id={descriptionId}>
          {t('composer.shortcutDescription')}
        </p>
      ) : null}
      {attachments ? (
        <p aria-live="polite" className="uib-visually-hidden">
          {announcement}
        </p>
      ) : null}
    </div>
  );
};
