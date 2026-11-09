import { Button, Card, Heading, Link, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { ArrowLeftIcon, ExternalLinkIcon } from '@navikt/aksel-icons';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useT } from '../i18n.js';
import { Markdown } from '../markdown/Markdown.js';
import { excerptMarkdown, headingText } from '../sources/excerptMarkdown.js';
import { orderedExcerpts, pairCitations, type SourceCitation } from '../sources/pairing.js';
import {
  DocumentLink,
  ExcerptNumber,
  targetPosition,
  useSourceSubtitle,
  type BackTo,
} from '../sources/Sources.js';
import type {
  SourceDocument,
  SourceExcerpt,
  SourceSelection,
  SourceTarget,
} from '../sources/types.js';

/** Where «Tilbake til …» leads: the footnote the reader followed, or Sources. */
export type DocumentViewReturn = 'answer' | 'sources';

/** A question the reader asked about the document, for the host to ask in the thread. */
export interface DocumentQuestion {
  question: string;
  source: SourceDocument;
  /** The excerpt the reader stood on when asking. */
  excerpt?: SourceExcerpt | undefined;
}

export interface DocumentViewProps {
  /**
   * The answer's sources, the contract's `sources[]`, as Sources takes them. The view shows the one
   * `target` names, and its excerpts are what it can show of the document: genki has no route for
   * a document's whole text. When it has, the text comes as one more prop beside these, and
   * nothing here changes.
   */
  sources?: readonly SourceDocument[] | undefined;
  /**
   * Which document, and where in it: a footnote's target, or the excerpt the reader chose in
   * Sources. An excerpt it names is marked, scrolled to and focused; a target that names only the
   * document lands on its title. Each new target, by identity, is followed once.
   */
  target?: SourceTarget | undefined;
  /**
   * The answer's footnotes in order, as Sources takes them, so the excerpts are numbered «Utdrag N»
   * and linked back the same way. Without them, or when they name only documents, nothing is
   * numbered.
   */
  citations?: readonly SourceCitation[] | undefined;
  /** A link back to the answer was followed: that footnote's index in `citations`. */
  onShowUse?: ((citation: number, selection: SourceSelection) => void) | undefined;
  /** Where a link back to footnote `citation` leads, such as `#` and the answer's `citationId`. */
  citationHref?: ((citation: number) => string | undefined) | undefined;
  /** Which of the thread's answers the sources are for, from 0, so a link back can say which. */
  answerIndex?: number | undefined;
  answerCount?: number | undefined;
  /** Back to where the reader came from, by the button at the top or Escape. */
  onReturn?: (() => void) | undefined;
  /** What the way back says: «Tilbake til svaret» (the default) or «Tilbake til kildene». */
  returnTo?: DocumentViewReturn | undefined;
  /**
   * A question about this document, which the host asks in the thread. Without it, no question
   * field is drawn.
   */
  onAsk?: ((ask: DocumentQuestion) => void) | undefined;
  /** The target names a document or excerpt the sources do not hold. */
  onTargetMissing?: ((target: SourceTarget) => void) | undefined;
  /** What the documents' collection is called, for «Les dokumentet på Kudos». */
  corpus?: string | undefined;
  /** The block's heading, «Dokumentvisning», or `false` for none. */
  title?: ReactNode | false | undefined;
  /** The document title's heading level, 2 to 5, 3 by default. The block's heading is one over. */
  headingLevel?: 2 | 3 | 4 | 5 | undefined;
  /** Says the text is quoted, not generated. On by default. */
  disclaimer?: boolean | undefined;
  /** Designsystemet's `data-color` for the block and for the document's head, set only when given. */
  color?: string | undefined;
  headerColor?: string | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

type Level = 2 | 3 | 4 | 5 | 6;

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

const reachesPage = (url: string, page: number) => url.endsWith(`#page=${page}`);

/** The section an excerpt is from: the last step of its heading path. */
const sectionOf = (path: string | undefined) => path?.split(' › ').at(-1);

const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Whether text the view does not have lies before an excerpt: when the parts' positions say the
 * document goes on between them, or that the first is not the document's start. Without positions
 * nothing is claimed.
 */
const gapBefore = (passages: readonly SourceExcerpt[], i: number) => {
  const here = passages[i]?.position;
  if (here === undefined) return false;
  if (i === 0) return here > 0;
  const before = passages[i - 1]?.position;
  return before !== undefined && here - before > 1;
};

const Empty = ({ level, title, text }: { level: number; title: string; text: string }) => (
  <div className="uib-document-view-empty">
    <Heading level={level as Level} data-size="2xs">
      {title}
    </Heading>
    <Paragraph data-size="sm" variant="long">
      {text}
    </Paragraph>
  </div>
);

/**
 * «Dokumentvisning»: one source document, read in its own order, with the excerpt the reader came
 * for marked and focused, a way to step between its excerpts, the way back, and a question about
 * the document for the host to ask in the thread. Data in, events out: the host passes the
 * answer's sources and a target, as it does to Sources.
 */
export const DocumentView = ({
  sources,
  target,
  citations,
  onShowUse,
  citationHref,
  answerIndex = 0,
  answerCount = 1,
  onReturn,
  returnTo = 'answer',
  onAsk,
  onTargetMissing,
  corpus,
  title,
  headingLevel = 3,
  disclaimer = true,
  color,
  headerColor,
  children,
  className,
}: DocumentViewProps) => {
  const t = useT();
  const titleId = useId();
  const documentTitleId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const passageRefs = useRef(new Map<string, HTMLElement>());
  const applied = useRef(new WeakSet<SourceTarget>());
  const frame = useRef(0);
  // The excerpt marked, as an index into the document's excerpts; -1 before a target names one or
  // the reader steps to one, since a target that names only the document cites no excerpt.
  const [current, setCurrentState] = useState(-1);
  // The same, for presses that come faster than a render: each one steps from the last.
  const currentRef = useRef(-1);
  const setCurrent = (index: number) => {
    currentRef.current = index;
    setCurrentState(index);
  };
  const [landing, setLanding] = useState<{ chunkId: string | undefined }>();
  const [said, setSaid] = useState('');
  const [question, setQuestion] = useState('');
  const [sent, setSent] = useState('');

  const position = sources && target ? targetPosition(sources, target) : -1;
  const source = position >= 0 ? sources?.[position] : undefined;
  const passages = useMemo(() => (source ? orderedExcerpts(source) : []), [source]);
  const pairing = useMemo(
    () => (citations ? pairCitations(sources ?? [], citations) : undefined),
    [sources, citations],
  );
  const subtitle = useSourceSubtitle(source ?? { title: '', excerpts: [] });
  const missing = target !== undefined && sources !== undefined && !source;
  // A footnote that names an excerpt this document does not hold marks nothing.
  const strayChunk =
    source !== undefined &&
    target?.chunkId !== undefined &&
    !passages.some((p) => p.chunkId === target.chunkId);

  useEffect(() => {
    if (target && (missing || strayChunk)) onTargetMissing?.(target);
  }, [target, missing, strayChunk]);

  useEffect(() => {
    // Once per target the app passes, and only once its document is here: new sources with the
    // target still held move no focus.
    if (!target || !source || applied.current.has(target)) return;
    applied.current.add(target);
    const at = target.chunkId ? passages.findIndex((p) => p.chunkId === target.chunkId) : -1;
    setCurrent(at);
    setSaid('');
    setLanding({ chunkId: at >= 0 ? target.chunkId : undefined });
  }, [target, source]);

  useEffect(() => {
    if (!landing) return;
    const id = requestAnimationFrame(() => {
      const passage = landing.chunkId ? passageRefs.current.get(landing.chunkId) : undefined;
      // On the title, the block's top is shown too, so the way back stays in sight.
      (passage ?? rootRef.current)?.scrollIntoView?.({
        behavior: still() ? 'auto' : 'smooth',
        block: 'start',
      });
      (passage ?? headRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [landing]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const level = headingLevel as Level;
  const heading =
    title === false ? null : (
      <Heading
        id={titleId}
        level={Math.max(2, headingLevel - 1) as Level}
        data-size="sm"
        className="uib-document-view-title"
      >
        {title ?? t('documentView.title')}
      </Heading>
    );
  const back = onReturn ? (
    <Button variant="tertiary" data-size="sm" className="uib-document-view-back" onClick={onReturn}>
      <ArrowLeftIcon aria-hidden />
      {returnTo === 'sources' ? t('documentView.backToSources') : t('sources.backToAnswer')}
    </Button>
  ) : null;
  const named = heading
    ? { 'aria-labelledby': titleId }
    : { 'aria-label': t('documentView.title') };

  if (!source)
    return (
      <section className={classes('uib-document-view', className)} data-color={color} {...named}>
        {/* Nothing to go back to before a target. */}
        {target ? back : null}
        {heading}
        <Empty
          level={headingLevel}
          title={missing ? t('documentView.missingTitle') : t('documentView.emptyTitle')}
          text={missing ? t('documentView.missing') : t('documentView.empty')}
        />
        {children}
      </section>
    );

  const documentTitle = source.title.trim() || t('sources.untitled');
  const at = current < passages.length ? current : -1;
  const ordered = passages.every((p) => p.position !== undefined);
  const backTo: BackTo | undefined =
    onShowUse || citationHref
      ? {
          answer: answerCount > 1 ? answerIndex + 1 : undefined,
          href: citationHref,
          onShow: undefined,
        }
      : undefined;
  // Escape anywhere on the document goes back, but in the question field, where it belongs to
  // what the reader is writing.
  const leave = onReturn
    ? (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        if (event.target instanceof Element && event.target.closest('form')) return;
        event.stopPropagation();
        onReturn();
      }
    : undefined;

  const nameOf = (excerpt: SourceExcerpt) => {
    const n = pairing?.mode === 'excerpt' ? pairing.numbers.get(excerpt.chunkId) : undefined;
    const section = sectionOf(headingText(excerpt.heading));
    if (n === undefined) return section ?? t('sources.excerptUnnumbered');
    return section
      ? `${t('sources.excerptNumber', { n })}: ${section}`
      : t('sources.excerptNumber', { n });
  };

  const step = (by: 1 | -1) => {
    const from = currentRef.current < passages.length ? currentRef.current : -1;
    const next = from + by;
    const excerpt = passages[next];
    if (!excerpt) return;
    setCurrent(next);
    setSaid(t('documentView.at', { title: nameOf(excerpt), n: next + 1, total: passages.length }));
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      passageRefs.current
        .get(excerpt.chunkId)
        ?.scrollIntoView?.({ behavior: still() ? 'auto' : 'smooth', block: 'start' });
    });
  };

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || !onAsk) return;
    onAsk({ question: text, source, excerpt: at >= 0 ? passages[at] : undefined });
    setQuestion('');
    setSent(t('documentView.askSent'));
  };

  const atFirst = at <= 0;
  const atLast = at >= passages.length - 1;

  return (
    <section
      ref={rootRef}
      className={classes('uib-document-view', className)}
      data-color={color}
      {...named}
    >
      {/* In the page from the first render: a live region announces only a change to it. */}
      <output className="ds-sr-only">{said}</output>
      {back}
      {heading}
      {/* Designsystemet's card, but not its `Card`: that one makes a click anywhere on the card
          click the first link in a heading, here an excerpt's first link back. Listens for
          Escape only, the way back. */}
      <article
        className="ds-card uib-document-view-document"
        aria-labelledby={documentTitleId}
        onKeyDown={leave}
      >
        <Card.Block className="uib-document-view-head" data-color={headerColor}>
          <Heading
            ref={headRef}
            id={documentTitleId}
            level={level}
            data-size="xs"
            tabIndex={-1}
            className="uib-document-view-document-title ds-focus"
          >
            {documentTitle}
          </Heading>
        </Card.Block>
        <Card.Block className="uib-document-view-body">
          {subtitle ? (
            <Paragraph data-size="xs" className="uib-document-view-subtitle">
              {subtitle}
            </Paragraph>
          ) : null}
          <DocumentLink
            source={source}
            title={documentTitle}
            corpus={corpus}
            linkClassName="uib-document-view-link"
            noLinkClassName="uib-document-view-no-link"
          />
          <Paragraph data-size="xs" className="uib-document-view-scope">
            {ordered
              ? t('documentView.scope', { count: passages.length })
              : t('documentView.scopeUnordered', { count: passages.length })}
          </Paragraph>
          {disclaimer ? (
            <Paragraph data-size="xs" className="uib-document-view-disclaimer">
              {t('documentView.disclaimer')}
            </Paragraph>
          ) : null}
          {passages.length > 1 ? (
            <div
              className="uib-document-view-steps"
              role="group"
              aria-label={t('documentView.steps')}
            >
              {/* For the eye; the live region says it with the excerpt's name. */}
              <Paragraph aria-hidden="true" data-size="xs" className="uib-document-view-position">
                {at >= 0
                  ? t('documentView.position', { n: at + 1, total: passages.length })
                  : t('documentView.count', { count: passages.length })}
              </Paragraph>
              <div className="uib-document-view-step-buttons">
                {/* `aria-disabled` and not `disabled` at the ends, so focus stays on the button. */}
                <Button
                  type="button"
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('documentView.previousExcerpt')}
                  aria-disabled={atFirst || undefined}
                  onClick={() => step(-1)}
                >
                  {t('sources.previous')}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('documentView.nextExcerpt')}
                  aria-disabled={atLast || undefined}
                  onClick={() => step(1)}
                >
                  {t('sources.next')}
                </Button>
              </div>
            </div>
          ) : null}
          <ol className="uib-document-view-passages">
            {passages.map((excerpt, i) => {
              const n =
                pairing?.mode === 'excerpt' ? pairing.numbers.get(excerpt.chunkId) : undefined;
              const uses = n === undefined ? [] : (pairing?.uses.get(excerpt.chunkId) ?? []);
              const uncited = pairing?.mode === 'excerpt' && n === undefined;
              const path = headingText(excerpt.heading);
              const section = sectionOf(path);
              const page = excerpt.page;
              const text = excerpt.textUnavailable ? '' : excerptMarkdown(excerpt.text);
              const fetching = !excerpt.textUnavailable && excerpt.textLoading && !text;
              const pageLink =
                excerpt.url && page !== undefined && reachesPage(excerpt.url, page)
                  ? excerpt.url
                  : undefined;
              const here = i === at;
              return (
                <li key={excerpt.chunkId}>
                  {gapBefore(passages, i) ? (
                    <p className="uib-document-view-gap">
                      <span aria-hidden="true">[…]</span>
                      <span className="ds-sr-only">{t('documentView.gap')}</span>
                    </p>
                  ) : null}
                  <div
                    ref={(el) => {
                      if (el) passageRefs.current.set(excerpt.chunkId, el);
                      else passageRefs.current.delete(excerpt.chunkId);
                    }}
                    className="uib-document-view-passage ds-focus"
                    tabIndex={-1}
                    data-current={here || undefined}
                    data-uncited={uncited || undefined}
                    aria-busy={fetching || undefined}
                  >
                    <Heading
                      level={(headingLevel + 1) as Level}
                      data-size="2xs"
                      className="uib-document-view-passage-title"
                      // Named by what it says, as in Sources: the number stands on a line of its
                      // own, which a browser reads without the colon.
                      aria-label={n === undefined ? undefined : nameOf(excerpt)}
                    >
                      {n === undefined ? null : (
                        <ExcerptNumber
                          n={n}
                          label={t('sources.excerptNumber', { n })}
                          uses={uses}
                          back={
                            backTo && {
                              ...backTo,
                              onShow:
                                onShowUse &&
                                ((citation) => onShowUse(citation, { source, excerpt })),
                            }
                          }
                        />
                      )}
                      {section ? <span>{section}</span> : null}
                      {!section && n === undefined ? t('sources.excerptUnnumbered') : null}
                    </Heading>
                    {uncited ? (
                      <Paragraph data-size="xs" className="uib-document-view-uncited">
                        {t('sources.uncited')}
                      </Paragraph>
                    ) : null}
                    {(path && path !== section) || page !== undefined ? (
                      <Paragraph data-size="xs" className="uib-document-view-section">
                        {path && path !== section ? <strong>{path}</strong> : null}
                        {path && path !== section && page !== undefined ? ' · ' : null}
                        {page === undefined ? null : (
                          <span className="uib-document-view-page">
                            {t('sources.page', { page })}
                          </span>
                        )}
                      </Paragraph>
                    ) : null}
                    {fetching ? (
                      <Paragraph data-size="sm" className="uib-document-view-unavailable">
                        {t('sources.excerptLoading')}
                      </Paragraph>
                    ) : text ? (
                      <Markdown
                        text={text}
                        links={false}
                        className="uib-markdown uib-document-view-quote"
                      />
                    ) : (
                      <Paragraph data-size="sm" className="uib-document-view-unavailable">
                        {t('sources.excerptUnavailable')}
                      </Paragraph>
                    )}
                    {pageLink && page !== undefined ? (
                      <Link
                        href={pageLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-size="sm"
                        className="uib-document-view-link"
                      >
                        {corpus
                          ? t('sources.readPageOn', { page, corpus })
                          : t('sources.readPage', { page })}
                        <span className="ds-sr-only">
                          , {nameOf(excerpt)}, {documentTitle} {t('sources.opensInNewTab')}
                        </span>
                        <ExternalLinkIcon aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {onAsk ? (
            <form className="uib-document-view-ask" onSubmit={ask}>
              <Textfield
                label={t('documentView.askLabel')}
                description={t('documentView.askHint')}
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setSent('');
                }}
                className="uib-document-view-ask-field"
              />
              <Button type="submit" aria-disabled={!question.trim() || undefined}>
                {t('documentView.ask')}
              </Button>
              <output className="ds-sr-only">{sent}</output>
            </form>
          ) : null}
        </Card.Block>
      </article>
      {children}
    </section>
  );
};
