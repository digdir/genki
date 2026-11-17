import { Button, Card, Details, Divider, Link } from '@digdir/designsystemet-react';
import { CheckmarkIcon, FilesIcon } from '@navikt/aksel-icons';
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
      <Details className="uib-answer-references">
        <Details.Summary>{t('answer.references')}</Details.Summary>
        <Details.Content>
          <ul className="uib-answer-references-list" aria-label={t('answer.references')}>
            {list.map((reference) => {
              const { lead, title, titleEnd, publisher, pages } = referenceParts(
                reference,
                t.locale,
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
                    {lead.map((part) => `${part}, `).join('')}
                    <em>{title}</em>
                    {titleEnd}
                    {publisher ? ` ${publisher}` : ''}
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
