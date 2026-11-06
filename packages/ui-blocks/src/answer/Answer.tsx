import { Button, Card, Link, Paragraph, Skeleton, Spinner } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { ArrowsCirclepathIcon, FileTextIcon, InformationSquareIcon } from '@navikt/aksel-icons';
import { useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react';
import { useT } from '../i18n.js';
import { Markdown, type CiteRenderer, type TableFacts } from '../markdown/Markdown.js';
import { documentKeys, type CitationMode } from '../sources/pairing.js';
import { distinctNames, isOwn } from '../sources/Sources.js';
import type { SourceDocument, SourceTarget } from '../sources/types.js';
import { readFootnotes, type AnswerMarker } from './citations.js';
import { SourcesUsed, type UsedDocument } from './SourcesUsed.js';

export type AnswerStatus = 'streaming' | 'complete' | 'aborted' | 'failed';

/** A footnote in the answer to show, by its index in the answer's footnotes. */
export interface AnswerTarget {
  citation: number;
}

export interface AnswerProps {
  /** The answer as the service wrote it: Markdown, with `[N]` footnotes. */
  text: string;
  status?: AnswerStatus | undefined;
  /** The contract's `sources[]`. Without them, `[N]` stays text: they come with the answer's end. */
  sources?: readonly SourceDocument[] | undefined;
  /** The contract's top-level `markers`, when the service cites excerpts. */
  markers?: readonly AnswerMarker[] | undefined;
  /** The service's choice, or the reader's. Excerpt mode needs markers that name excerpts. */
  citationMode?: CitationMode | undefined;
  /** The text is the service's notice that it found nothing (`no_answer`), not an answer. */
  noAnswer?: boolean | undefined;
  /** A footnote was followed: its index in the answer's footnotes, and the item it cites. */
  onOpenCitation?: ((citation: number, target: SourceTarget) => void) | undefined;
  /** A document in «Kilder brukt i svaret» was chosen. */
  onOpenDocument?: ((source: SourceDocument) => void) | undefined;
  /** Where a footnote or a document leads, for a new tab and for copying. */
  href?: ((target: SourceTarget) => string | undefined) | undefined;
  /** An id for each footnote, so the app can find it. */
  citationId?: ((citation: number) => string) | undefined;
  /** The footnote to scroll to and focus: where Sources' `onShowUse` and `onReturn` lead. */
  target?: AnswerTarget | undefined;
  /** «Kilder brukt i svaret» under a finished answer. */
  sourcesUsed?: boolean | undefined;
  /** «Er det noe mer jeg kan hjelpe deg med?» under a finished answer. */
  closingQuestion?: boolean | undefined;
  /** Asks the same question again, offered under a stopped or failed answer. */
  onRegenerate?: (() => void) | undefined;
  /** The row under a finished answer, such as copying and feedback. */
  actions?: ReactNode;
  /** Who answered, for a screen reader. Without it, the AI assistant. */
  assistantName?: string | undefined;
  /** The level of the answer's own top heading; deeper ones follow. */
  headingLevel?: 2 | 3 | 4 | undefined;
  /** Designsystemet's `data-color` for the card, set only when given. */
  color?: string | undefined;
  className?: string | undefined;
}

/** Characters per skeleton line, not a length: Skeleton repeats that many dashes. */
const skeletonLines = [78, 86, 82, 48];

/** How many columns a table's name lists before it counts the rest. */
const namedColumns = 4;

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

const stillMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface FootnoteProps {
  citation: number;
  number: number | undefined;
  name: string;
  label: string;
  href: string;
  id: string | undefined;
  onOpen: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  footnotes: Map<number, HTMLElement>;
}

// A link named by its excerpt and the document it is in: a bare «[3]» tells a screen reader user
// nothing. The brackets stay in the text, out of sight, so a copied answer still reads «[1]».
const Footnote = ({
  citation,
  number,
  name,
  label,
  href,
  id,
  onOpen,
  footnotes,
}: FootnoteProps) => (
  <sup className="uib-answer-footnote">
    <Link
      ref={(element: HTMLAnchorElement | null) => {
        if (element) footnotes.set(citation, element);
        else footnotes.delete(citation);
      }}
      id={id}
      className="uib-answer-mark"
      href={href}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <span className="uib-answer-copy">[</span>
      {number ?? (
        <>
          <FileTextIcon aria-hidden className="uib-answer-mark-icon" />
          <span className="uib-answer-copy">{name}</span>
        </>
      )}
      <span className="uib-answer-copy">]</span>
    </Link>
  </sup>
);

const Lost = ({ n }: { n: number }) => {
  const t = useT();
  return (
    <sup className="uib-answer-lost" title={t('answer.sourceLost')}>
      [{n}]<span className="ds-sr-only"> {t('answer.sourceLostNote')}</span>
    </sup>
  );
};

export const AnswerSkeleton = () => (
  <div aria-hidden="true" className="uib-answer-skeleton">
    {skeletonLines.map((characters) => (
      <p key={characters} className="uib-answer-skeleton-line">
        <Skeleton variant="text" width={characters} />
      </p>
    ))}
  </div>
);

/**
 * One answer: its text with footnotes, and what a reader can do with it. Each footnote leads to
 * the one item it cites, and Sources leads back to it, from the same pairing. Only excerpts are
 * numbered, in the order the answer first cites them; a document is named by its title.
 */
export const Answer = ({
  text,
  status = 'complete',
  sources,
  markers,
  citationMode = 'excerpt',
  noAnswer = false,
  onOpenCitation,
  onOpenDocument,
  href,
  citationId,
  target,
  sourcesUsed = true,
  closingQuestion = false,
  onRegenerate,
  actions,
  assistantName,
  headingLevel = 3,
  color,
  className,
}: AnswerProps) => {
  const t = useT();
  const f = useFormat();
  const footnotes = useRef(new Map<number, HTMLElement>());
  const empty = text.trim() === '';
  const streaming = status === 'streaming';
  const complete = status === 'complete';
  const aborted = status === 'aborted';
  const failed = status === 'failed';

  const read = useMemo(
    () => readFootnotes(text, sources, markers, citationMode),
    [text, sources, markers, citationMode],
  );
  const { pairing } = read;
  const byExcerpt = pairing.mode === 'excerpt';
  const keys = useMemo(() => documentKeys(sources ?? []), [sources]);
  const names = useMemo(
    () =>
      distinctNames(sources ?? [], (title, id) => t('sources.sameTitle', { title, id })).map(
        (name) => name || t('sources.untitled'),
      ),
    [sources, t],
  );

  // The document each shown item is in: an excerpt's chunk id, or a document's key.
  const documentOf = (key: string) => {
    const at = byExcerpt
      ? (sources ?? []).findIndex((s) => s.excerpts.some((e) => e.chunkId === key))
      : keys.indexOf(key);
    return at < 0 ? undefined : at;
  };

  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const footnote = footnotes.current.get(target.citation);
      // Centred, so the sentence the footnote ends is in view above it.
      footnote?.scrollIntoView?.({ behavior: stillMotion() ? 'auto' : 'smooth', block: 'center' });
      footnote?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const cite: CiteRenderer = (n, key) => {
    const mark = read.marks.get(key);
    if (mark?.kind === 'dropped') return false;
    if (mark?.kind === 'footnote') {
      const item = pairing.targets[mark.citation];
      const at = item === undefined ? undefined : documentOf(item);
      const source = at === undefined ? undefined : sources?.[at];
      if (item === undefined || at === undefined || !source) return false;
      const name = names[at] ?? source.title;
      const number = byExcerpt ? pairing.numbers.get(item) : undefined;
      const goal: SourceTarget = byExcerpt
        ? { chunkId: item, documentId: source.documentId, index: source.index }
        : { documentId: source.documentId, index: source.index };
      return (
        <Footnote
          key={key}
          citation={mark.citation}
          number={number}
          name={name}
          label={
            number === undefined
              ? t('answer.footnoteDocument', { title: name })
              : t('answer.footnote', { n: number, title: name })
          }
          href={href?.(goal) ?? '#'}
          id={citationId?.(mark.citation)}
          onOpen={
            onOpenCitation
              ? (event) => {
                  // The app moves to the item; following the address could reload its route.
                  event.preventDefault();
                  onOpenCitation(mark.citation, goal);
                }
              : undefined
          }
          footnotes={footnotes.current}
        />
      );
    }
    // A stopped answer wrote its footnotes before the sources came: each says why it leads nowhere.
    return aborted && n < 1000 ? <Lost key={key} n={n} /> : undefined;
  };

  const tableName = ({ number, count, columns }: TableFacts) => {
    const table = count > 1 ? t('answer.tableNumber', { n: number }) : t('answer.table');
    if (columns.length === 0) return table;
    const named = columns.slice(0, namedColumns);
    const more = columns.length - named.length;
    return t('answer.tableColumns', {
      count: columns.length,
      table,
      columns: f.list(more > 0 ? [...named, t('answer.moreColumns', { more })] : named),
    });
  };

  const used: UsedDocument[] = (sources ?? []).flatMap((source, i) => {
    const key = keys[i] ?? `@${i}`;
    const numbers = byExcerpt
      ? source.excerpts.flatMap((e) => {
          const n = pairing.numbers.get(e.chunkId);
          return n === undefined ? [] : [n];
        })
      : [];
    const cited = byExcerpt ? numbers.length > 0 : (pairing.uses.get(key)?.length ?? 0) > 0;
    return cited
      ? [{ key, source, name: names[i] ?? source.title, own: isOwn(source), numbers }]
      : [];
  });

  const finished = complete && !empty && !noAnswer;
  // Exactly the answers with nothing behind them. Unknown sources say nothing, and footnotes
  // with no sources are sources lost, not an answer without any.
  const unsourced = finished && sources !== undefined && sources.length === 0 && read.written === 0;
  // A failed turn with nothing in it gets no card; a stopped one does, since it says so.
  if (empty && !streaming && !aborted && !failed) return null;

  return (
    <Card className={classes('uib-answer', className)} data-color={color}>
      <Card.Block className="uib-answer-body">
        <span className="ds-sr-only">
          {assistantName ? t('answer.said', { name: assistantName }) : t('answer.saidUnnamed')}
        </span>
        {empty && streaming ? <AnswerSkeleton /> : null}
        {unsourced ? (
          <Paragraph data-size="sm" className="uib-answer-note">
            <InformationSquareIcon aria-hidden className="uib-answer-note-icon" />
            {t('answer.noSources')}
          </Paragraph>
        ) : null}
        {empty ? null : (
          <Markdown
            text={text}
            cite={cite}
            className="uib-markdown uib-answer-text"
            headingLevel={headingLevel}
            tableName={tableName}
          />
        )}
        {/* The app's live region says it in words, so this line is for the eye. */}
        {streaming && !empty ? (
          <p aria-hidden="true" className="uib-answer-writing">
            <Spinner aria-hidden="true" data-size="xs" />
            {t('answer.writing')}
          </p>
        ) : null}
        {aborted ? (
          <Paragraph data-size="sm" variant="long" className="uib-answer-stopped">
            {empty ? t('answer.abortedBeforeAnswer') : t('answer.aborted')}
          </Paragraph>
        ) : null}
        {failed ? (
          <Paragraph data-size="sm" variant="long" className="uib-answer-stopped">
            {t('answer.failed')}
          </Paragraph>
        ) : null}
        {finished && sourcesUsed ? (
          <SourcesUsed documents={used} href={href} onOpenDocument={onOpenDocument} />
        ) : null}
        {finished && closingQuestion ? (
          <Paragraph variant="long">{t('answer.closingQuestion')}</Paragraph>
        ) : null}
      </Card.Block>
      {(complete && !empty && actions) || ((aborted || failed) && (onRegenerate || actions)) ? (
        <Card.Block>
          <div className="uib-answer-actions">
            {(aborted || failed) && onRegenerate ? (
              <Button variant="tertiary" data-size="sm" onClick={onRegenerate}>
                <ArrowsCirclepathIcon aria-hidden />
                {t('answer.regenerate')}
              </Button>
            ) : null}
            {actions}
          </div>
        </Card.Block>
      ) : null}
    </Card>
  );
};
