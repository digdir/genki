import { Card, Details, Link, List, Paragraph } from '@digdir/designsystemet-react';
import { FileTextIcon } from '@navikt/aksel-icons';
import { useT } from '../i18n.js';
import type { SourceDocument, SourceTarget } from '../sources/types.js';

/** One document the answer used: its name, and in excerpt mode the numbers of its excerpts. */
export interface UsedDocument {
  key: string;
  source: SourceDocument;
  name: string;
  own: boolean;
  numbers: readonly number[];
}

/** «Utdrag 1–3» for an unbroken run, «Utdrag 1, 2, 5» otherwise, as the footnotes call them. */
const range = (numbers: readonly number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  const unbroken = sorted.every((n, i) => i === 0 || n === (sorted[i - 1] ?? 0) + 1);
  return sorted.length > 1 && unbroken
    ? `${sorted[0]}–${sorted.at(-1)}`
    : sorted.map(String).join(', ');
};

/**
 * «Kilder brukt i svaret»: one row per document the answer cites, in the order Sources shows
 * them, each a way into that document. Documents are named, never numbered: in excerpt mode the
 * numbers under a title are its excerpts', the same as the footnotes in the text.
 */
export const SourcesUsed = ({
  documents,
  href,
  onOpenDocument,
}: {
  documents: readonly UsedDocument[];
  href?: ((target: SourceTarget) => string | undefined) | undefined;
  onOpenDocument?: ((source: SourceDocument) => void) | undefined;
}) => {
  const t = useT();
  if (documents.length === 0) return null;
  return (
    <Card className="uib-answer-sources-used-card" variant="tinted">
      <Details className="uib-answer-sources-used" defaultOpen>
        <Details.Summary>
          <span className="uib-answer-sources-used-title">
            <FileTextIcon aria-hidden className="uib-answer-sources-used-icon" />
            {t('answer.sourcesUsed')}
          </span>
        </Details.Summary>
        <Details.Content>
          <List.Unordered className="uib-answer-sources-used-list" data-size="sm">
            {documents.map(({ key, source, name, own, numbers }) => {
              // A file name can look exactly like a corpus title, and a list is read out of
              // context, so the name says whose it is.
              const whose = own ? (
                <span className="ds-sr-only">
                  , {t('sources.ownDocument').toLocaleLowerCase(t.locale)}
                </span>
              ) : null;
              const target = { documentId: source.documentId, index: source.index };
              const address = href?.(target);
              return (
                <List.Item key={key}>
                  {onOpenDocument || address ? (
                    <Link
                      className="uib-answer-sources-used-link"
                      href={address ?? '#'}
                      onClick={
                        onOpenDocument
                          ? (event) => {
                              // The app moves to the document, not to its first excerpt.
                              event.preventDefault();
                              onOpenDocument(source);
                            }
                          : undefined
                      }
                    >
                      {name}
                      {whose}
                    </Link>
                  ) : (
                    <>
                      {name}
                      {whose}
                    </>
                  )}
                  {numbers.length ? (
                    <Paragraph data-size="xs" className="uib-answer-sources-used-excerpts">
                      {t('answer.excerpts', { count: numbers.length, numbers: range(numbers) })}
                    </Paragraph>
                  ) : null}
                </List.Item>
              );
            })}
          </List.Unordered>
        </Details.Content>
      </Details>
    </Card>
  );
};
