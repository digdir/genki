import { Button, Label, Search } from '@digdir/designsystemet-react';
import { XMarkIcon } from '@navikt/aksel-icons';
import { useId, type RefObject } from 'react';
import { useT } from '../i18n.js';
import { MIN_QUERY_LENGTH } from '../markdown/textSearch.js';

export interface AnswerSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  hitCount: number;
  /** Zero-based; the reader reads it one-based. */
  currentHitIndex: number;
  onStep: (step: 1 | -1) => void;
  /** Escape, and the close button. */
  onClose: () => void;
  fieldRef: RefObject<HTMLInputElement | null>;
  /** Which answer it searches: the strip is pinned over the conversation, not in the answer. */
  label: string;
}

/**
 * Search in one answer, the same control as Sources' search. It leaves the browser's own find
 * alone, and the counter is a live region, because a `<mark>` is not announced and the count is
 * the only sign anything happened.
 */
export const AnswerSearch = ({
  query,
  onQueryChange,
  hitCount,
  currentHitIndex,
  onStep,
  onClose,
  fieldRef,
  label,
}: AnswerSearchProps) => {
  const t = useT();
  const fieldId = useId();
  const atFirst = currentHitIndex === 0;
  const atLast = currentHitIndex >= hitCount - 1;

  const typed = query.trim().length;
  const status =
    typed === 0
      ? ''
      : typed < MIN_QUERY_LENGTH
        ? t('sources.searchMin', { n: MIN_QUERY_LENGTH })
        : hitCount === 0
          ? t('sources.searchNone')
          : t('sources.searchCount', { n: currentHitIndex + 1, total: hitCount });

  return (
    <search className="uib-conversation-search">
      {/* Search.Clear is a reset button, which needs a form. Escape is heard on the form, so it
          also closes from the step buttons. */}
      <form
        className="uib-conversation-search-form"
        onSubmit={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}
      >
        {/* Visible, since the strip is not in the answer it searches: the field's name and the
            strip's title in one. */}
        <Label htmlFor={fieldId} data-size="sm" className="uib-conversation-search-label">
          {label}
        </Label>
        <Search data-size="sm" className="uib-conversation-search-field">
          <Search.Input
            id={fieldId}
            name="uib-conversation-search"
            placeholder={t('conversation.searchPlaceholder')}
            ref={fieldRef}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {/* The reset clears the field; the state behind it is cleared too, or React puts the
              old value straight back. */}
          <Search.Clear aria-label={t('sources.clearSearch')} onClick={() => onQueryChange('')} />
        </Search>
        <p aria-live="polite" className="uib-conversation-search-count">
          {status}
        </p>
        {/* No previous or next before there is something to step through: a control the reader
            has never been able to use only adds a tab stop. */}
        {hitCount > 0 ? (
          <div className="uib-conversation-search-steps">
            {/* aria-disabled, not disabled, so focus stays on the button at the last hit. */}
            <Button
              type="button"
              variant="tertiary"
              data-size="sm"
              aria-label={t('conversation.previousHit')}
              aria-disabled={atFirst || undefined}
              onClick={() => !atFirst && onStep(-1)}
            >
              {t('sources.previous')}
            </Button>
            <Button
              type="button"
              variant="tertiary"
              data-size="sm"
              aria-label={t('conversation.nextHit')}
              aria-disabled={atLast || undefined}
              onClick={() => !atLast && onStep(1)}
            >
              {t('sources.next')}
            </Button>
          </div>
        ) : null}
        <Button
          type="button"
          variant="tertiary"
          data-size="sm"
          aria-label={t('conversation.closeSearch')}
          onClick={onClose}
        >
          <XMarkIcon aria-hidden />
        </Button>
      </form>
    </search>
  );
};
