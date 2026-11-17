import { Button, Card, Details, Divider, Link } from '@digdir/designsystemet-react';
import { CheckmarkIcon, FilesIcon } from '@navikt/aksel-icons';
import { useEffect, useState } from 'react';
import { useT } from './i18n.js';
import { referenceParts, referencesMarkdown, type Reference } from './referenceList.js';

/** How long «Kopiert» stands on the button after a copy. */
export const REFERENCES_COPIED_MS = 2500;

/**
 * The Kildeliste under an answer (dev-kildeliste): closed until the reader opens it, one row per
 * document with the footnotes that cite it in a column in front, and its reference: the document
 * type, the year, the title, the publisher, the pages and the address, each where the source has it.
 * Its one job is to be copied: «Kopier kildeliste» hands the app the list as Markdown, and says
 * «Kopiert» once the app has put it on the clipboard. It leads nowhere in Sources; the footnotes
 * in the text do.
 */
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
      // A new number for each copy, so a second click starts the time again.
      setCopied((n) => n + 1);
    } catch {
      // The clipboard refused: the button keeps saying what it does.
    }
  };
  return (
    <Card className="uib-answer-references-card" variant="default">
      <Details className="uib-answer-references">
        <Details.Summary>{t('answer.references')}</Details.Summary>
        <Details.Content>
          <ul className="uib-answer-references-list" aria-label={t('answer.references')}>
            {list.map((reference) => {
              const { lead, title, publisher, pages } = referenceParts(reference, t.locale);
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
                    {lead.map((part) => `${part}, `).join('')}
                    <em>{title}</em>.{publisher ? ` ${publisher}.` : ''}
                    {pages ? ` ${pages}.` : ''}
                    {reference.url ? (
                      <>
                        {' '}
                        <Link href={reference.url} target="_blank" rel="noopener noreferrer">
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
