import { Button, Card, Details, Divider, Link } from '@digdir/designsystemet-react';
import { CheckmarkIcon, FilesIcon, NumberListIcon } from '@navikt/aksel-icons';
import { useEffect, useState } from 'react';
import { useT } from './i18n.js';
import { referenceParts, referencesMarkdown, type Reference } from './referenceList.js';

export const REFERENCES_COPIED_MS = 2500;

export const References = ({
  list,
  onCopy,
}: {
  list: readonly Reference[];
  /** Puts the list on the clipboard. Without it, no button. */
  onCopy?: ((markdown: string) => Promise<void> | void) | undefined;
}) => {
  const t = useT();
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), REFERENCES_COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (list.length === 0) return null;
  const copy = async () => {
    try {
      await onCopy?.(referencesMarkdown(list, t.locale));
      setCopied((n) => n + 1);
    } catch {
      // The clipboard refused; the button stays as it was.
    }
  };
  return (
    <Card className="uib-answer-references-card" variant="default">
      <Details className="uib-answer-references" data-size="sm">
        <Details.Summary>
          <span className="uib-answer-references-summary">
            <NumberListIcon aria-hidden />
            {t('answer.references')}
          </span>
        </Details.Summary>
        {/* The summary is small; the list keeps its own size, as dev-kildeliste. */}
        <Details.Content data-size="md">
          <ul className="uib-answer-references-list" aria-label={t('answer.references')}>
            {list.map((reference) => {
              const { author, year, title, titleEnd, pages } = referenceParts(reference, t.locale);
              const named = (
                <>
                  <em>{title}</em>
                  {titleEnd}
                </>
              );
              return (
                <li key={reference.key} className="uib-answer-references-row">
                  <span className="uib-answer-references-footnotes">
                    {reference.footnotes.length ? (
                      <span className="ds-sr-only">
                        {t('answer.referenceFootnotes', { count: reference.footnotes.length })}{' '}
                      </span>
                    ) : null}
                    {reference.footnotes.join(', ')}
                  </span>
                  <span className="uib-answer-references-reference">
                    {author ? (
                      <>
                        {author} {year ? `${year} ` : ''}
                        {named}
                      </>
                    ) : (
                      <>
                        {named}
                        {year ? ` ${year}` : ''}
                      </>
                    )}
                    {pages ? ` ${pages}.` : ''}
                    {reference.url ? (
                      <>
                        {' '}
                        <Link
                          href={reference.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-color="accent"
                        >
                          {reference.url}
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {onCopy ? (
            <>
              <Divider className="uib-answer-references-divider" />
              <Button
                variant="secondary"
                data-size="sm"
                data-color="accent"
                className="uib-answer-references-copy"
                onClick={() => void copy()}
                aria-live="polite"
              >
                {copied ? <CheckmarkIcon aria-hidden /> : <FilesIcon aria-hidden />}
                {copied ? t('answer.referencesCopied') : t('answer.copyReferences')}
              </Button>
            </>
          ) : null}
        </Details.Content>
      </Details>
    </Card>
  );
};
