import { Button, Label, Paragraph, Search } from '@digdir/designsystemet-react';
import { useId } from 'react';
import { useT } from '../i18n.js';
import { MIN_QUERY_LENGTH } from '../markdown/textSearch.js';

export interface SourcesSearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  hitCount: number;
  /** Zero-based; the reader reads it one-based. */
  currentHitIndex: number;
  onStep: (step: 1 | -1) => void;
  describedBy?: string | undefined;
}

/** A filter over the excerpts already drawn. The counter is a live region, as `<mark>` is silent. */
export const SourcesSearch = ({
  query,
  onQueryChange,
  hitCount,
  currentHitIndex,
  onStep,
  describedBy,
}: SourcesSearchProps) => {
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
    <search className="uib-sources-search">
      {/* Search.Clear is a reset button, which needs a form. */}
      <form className="uib-sources-search-form" onSubmit={(event) => event.preventDefault()}>
        <Label htmlFor={fieldId}>{t('sources.search')}</Label>
        <Search data-sr-clear={t('sources.clearSearch')}>
          <Search.Input
            id={fieldId}
            name="uib-sources-search"
            aria-describedby={describedBy}
            placeholder={t('sources.searchPlaceholder')}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          <Search.Clear aria-label={t('sources.clearSearch')} onClick={() => onQueryChange('')} />
        </Search>
        <div className="uib-sources-search-results">
          <Paragraph data-size="xs" aria-live="polite" className="uib-sources-search-status">
            {status}
          </Paragraph>
          {hitCount > 0 ? (
            <div className="uib-sources-search-steps">
              {/* aria-disabled, not disabled, so focus stays at the last hit. */}
              <Button
                type="button"
                variant="tertiary"
                data-size="sm"
                aria-label={t('sources.previousHit')}
                aria-disabled={atFirst || undefined}
                onClick={() => !atFirst && onStep(-1)}
              >
                {t('sources.previous')}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                data-size="sm"
                aria-label={t('sources.nextHit')}
                aria-disabled={atLast || undefined}
                onClick={() => !atLast && onStep(1)}
              >
                {t('sources.next')}
              </Button>
            </div>
          ) : null}
        </div>
      </form>
    </search>
  );
};
