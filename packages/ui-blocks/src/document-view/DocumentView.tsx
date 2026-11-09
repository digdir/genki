import {
  Button,
  Card,
  Chip,
  Heading,
  Link,
  Paragraph,
  Textfield,
} from '@digdir/designsystemet-react';
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
import { useT } from './i18n.js';
import { Markdown } from '../markdown/Markdown.js';
import { excerptMarkdown, headingText } from '../sources/excerptMarkdown.js';
import {
  orderedExcerpts,
  pairCitations,
  type Pairing,
  type SourceCitation,
} from '../sources/pairing.js';
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

/**
 * Where the reader opens a document in the host: «Vis i dokumentet» under an excerpt in Sources,
 * or a footnote in the answer, when Sources is not there to take it.
 */
export type DocumentViewOpener = 'sources' | 'answer';

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
   * document lands on its title. Each new target, by identity, is followed once, and wins over an
   * excerpt the reader has jumped to since.
   */
  target?: SourceTarget | undefined;
  /**
   * The answer's footnotes in order, as Sources takes them, so the excerpts are numbered «Utdrag N»
   * and linked back the same way, and «Utdrag i svaret» jumps straight to each cited one. Without
   * them, or when they name only documents, nothing is numbered and there is nothing to jump to.
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
  /**
   * Where the reader opens a document in this host, so the hint before one is open names that
   * control: `sources` for «Vis i dokumentet» under an excerpt in Sources, `answer` for a footnote.
   * Without it, the hint names both.
   */
  opensFrom?: DocumentViewOpener | undefined;
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

/** A cited excerpt that «Utdrag i svaret» jumps to: its number, and the document it is in. */
interface Jump {
  n: number;
  source: SourceDocument;
  excerpt: SourceExcerpt;
}

/**
 * The answer's cited excerpts, by their «Utdrag N» number, in whichever document each stands. Only
 * footnotes that name excerpts number anything, so in document mode there is nothing to jump to.
 */
const jumpsOf = (sources: readonly SourceDocument[], pairing: Pairing | undefined): Jump[] => {
  if (pairing?.mode !== 'excerpt') return [];
  const held = new Map<string, Omit<Jump, 'n'>>();
  for (const source of sources)
    for (const excerpt of source.excerpts)
      if (!held.has(excerpt.chunkId)) held.set(excerpt.chunkId, { source, excerpt });
  return [...pairing.numbers]
    .sort(([, a], [, b]) => a - b)
    .flatMap(([chunkId, n]) => {
      const where = held.get(chunkId);
      return where ? [{ n, ...where }] : [];
    });
};

/** What a document is, across new copies of the same sources. */
const documentKey = (source: SourceDocument) =>
  source.documentId ?? (source.index === undefined ? source.title : `#${source.index}`);

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
 * for marked and focused, «Utdrag i svaret» to jump straight to each excerpt the answer cites, the
 * way back, and a question about the document for the host to ask in the thread. Data in, events
 * out: the host passes the answer's sources and a target, as it does to Sources.
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
  opensFrom,
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
  const jumpsId = useId();
  const passageId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const passageRefs = useRef(new Map<string, HTMLElement>());
  const applied = useRef(new WeakSet<SourceTarget>());
  // An excerpt the reader jumped to from «Utdrag i svaret», kept only while the host's target is
  // the one it was chosen under: a new target from the host wins.
  const [jumped, setJumped] = useState<{ under: SourceTarget | undefined; to: SourceTarget }>();
  const [landing, setLanding] = useState<{ chunkId: string | undefined }>();
  const [said, setSaid] = useState('');
  // The question being written, for the document it was written about.
  const [draft, setDraft] = useState({ document: '', question: '', sent: '' });
  const [jumpsRow, setJumpsRow] = useState<HTMLElement | null>(null);

  const own =
    jumped && jumped.under === target && sources && targetPosition(sources, jumped.to) >= 0
      ? jumped.to
      : undefined;
  const shown = own ?? target;
  const position = sources && shown ? targetPosition(sources, shown) : -1;
  const source = position >= 0 ? sources?.[position] : undefined;
  const passages = useMemo(() => (source ? orderedExcerpts(source) : []), [source]);
  const pairing = useMemo(
    () => (citations ? pairCitations(sources ?? [], citations) : undefined),
    [sources, citations],
  );
  const jumps = useMemo(() => jumpsOf(sources ?? [], pairing), [sources, pairing]);
  const subtitle = useSourceSubtitle(source ?? { title: '', excerpts: [] });
  const missing = target !== undefined && sources !== undefined && !source;
  // A footnote that names an excerpt this document does not hold marks nothing.
  const strayChunk =
    source !== undefined &&
    shown?.chunkId !== undefined &&
    !passages.some((p) => p.chunkId === shown.chunkId);
  // The excerpt marked, by its chunk and read from the target itself, so a new document never
  // shows the last one's mark for a render.
  const marked = source && !strayChunk ? shown?.chunkId : undefined;
  const shownKey = source ? documentKey(source) : '';

  useEffect(() => {
    if (target && !own && (missing || strayChunk)) onTargetMissing?.(target);
  }, [target, missing, strayChunk]);

  useEffect(() => {
    // Once per target, the host's or a jump's, and only once its document is here: new sources
    // with the target still held move no focus.
    if (!shown || !source || applied.current.has(shown)) return;
    applied.current.add(shown);
    if (!own) setSaid('');
    setLanding({ chunkId: marked });
  }, [shown, source]);

  // «Utdrag i svaret» stays at the top while the document scrolls, so an excerpt scrolled to must
  // stop under it, however many lines its chips take: the room is the row's height, set on the
  // block where the stylesheet reads it. Measured before each landing, which can come before the
  // first resize is reported, and on every resize after.
  const fitRoom = (row: HTMLElement | null) => {
    const root = rootRef.current;
    if (!root) return;
    if (!row) root.style.removeProperty('--_scroll-room');
    else
      root.style.setProperty(
        '--_scroll-room',
        `calc(${Math.ceil(row.getBoundingClientRect().height)}px + var(--ds-size-2))`,
      );
  };

  useEffect(() => {
    fitRoom(jumpsRow);
    if (!jumpsRow || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitRoom(jumpsRow));
    observer.observe(jumpsRow);
    return () => observer.disconnect();
  }, [jumpsRow]);

  useEffect(() => {
    if (!landing) return;
    const id = requestAnimationFrame(() => {
      fitRoom(jumpsRow);
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

  const level = headingLevel as Level;
  const rootClass = className ? `uib-document-view ${className}` : 'uib-document-view';
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
      <section className={rootClass} data-color={color} {...named}>
        {/* Nothing to go back to before a target. */}
        {target ? back : null}
        {heading}
        <Empty
          level={headingLevel}
          title={missing ? t('documentView.missingTitle') : t('documentView.emptyTitle')}
          text={
            missing
              ? t('documentView.missing')
              : opensFrom === 'sources'
                ? t('documentView.emptyFromSources')
                : opensFrom === 'answer'
                  ? t('documentView.emptyFromAnswer')
                  : t('documentView.empty')
          }
        />
        {children}
      </section>
    );

  const documentTitle = source.title.trim() || t('sources.untitled');
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

  // Straight to a cited excerpt, in this document or another of the answer's. Focus lands on it
  // and says its name; a document of its own is said in the live region too.
  const jump = ({ source: to, excerpt }: Jump) => {
    setJumped({ under: target, to: { chunkId: excerpt.chunkId, documentId: to.documentId } });
    setSaid(
      to === source
        ? ''
        : t('documentView.opened', { title: to.title.trim() || t('sources.untitled') }),
    );
  };

  const question = draft.document === shownKey ? draft.question : '';
  const sent = draft.document === shownKey ? draft.sent : '';
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || !onAsk) return;
    onAsk({ question: text, source, excerpt: passages.find((p) => p.chunkId === marked) });
    setDraft({ document: shownKey, question: '', sent: t('documentView.askSent') });
  };

  return (
    <section ref={rootRef} className={rootClass} data-color={color} {...named}>
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
          {/* One chip per excerpt the answer cites, by its number, as the canvas's KS-2d draws
              it: each jumps straight to its excerpt. No stepper and no bare count; what nothing
              cites is reached by scrolling, in the document's order. */}
          {jumps.length > 0 ? (
            <div
              ref={setJumpsRow}
              className="uib-document-view-jumps"
              role="group"
              aria-labelledby={jumpsId}
            >
              <span id={jumpsId} className="uib-document-view-jumps-label">
                {t('documentView.jumps')}
              </span>
              <ul className="uib-document-view-jump-list">
                {jumps.map((item) => {
                  const { n, excerpt } = item;
                  const elsewhere = item.source !== source;
                  const page = excerpt.page;
                  // The name starts with what the chip shows, and says the page and, for another
                  // document, which one, as the canvas's title on the chip does.
                  const name = [
                    t('sources.excerptNumber', { n }),
                    page === undefined ? undefined : t('sources.page', { page }),
                    elsewhere
                      ? t('documentView.jumpIn', {
                          title: item.source.title.trim() || t('sources.untitled'),
                        })
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(', ');
                  return (
                    <li key={excerpt.chunkId}>
                      <Chip.Button
                        type="button"
                        className="uib-document-view-jump"
                        aria-label={name}
                        title={elsewhere ? name : undefined}
                        aria-current={!elsewhere && excerpt.chunkId === marked ? 'true' : undefined}
                        onClick={() => jump(item)}
                      >
                        <span className="uib-document-view-jump-number" aria-hidden="true">
                          {n}
                        </span>
                        {page === undefined ? null : (
                          <span className="uib-document-view-jump-page" aria-hidden="true">
                            {t('documentView.jumpPage', { page })}
                          </span>
                        )}
                      </Chip.Button>
                    </li>
                  );
                })}
              </ul>
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
              const readPage =
                page === undefined
                  ? ''
                  : corpus
                    ? t('sources.readPageOn', { page, corpus })
                    : t('sources.readPage', { page });
              const here = excerpt.chunkId === marked;
              const titleOf = `${passageId}-${i}`;
              return (
                <li key={excerpt.chunkId}>
                  {gapBefore(passages, i) ? (
                    <p className="uib-document-view-gap">
                      <span aria-hidden="true">[…]</span>
                      <span className="ds-sr-only">{t('documentView.gap')}</span>
                    </p>
                  ) : null}
                  {/* A group named by its title, so focus that lands here says which excerpt. */}
                  <div
                    ref={(el) => {
                      if (el) passageRefs.current.set(excerpt.chunkId, el);
                      else passageRefs.current.delete(excerpt.chunkId);
                    }}
                    className="uib-document-view-passage ds-focus"
                    role="group"
                    aria-labelledby={titleOf}
                    tabIndex={-1}
                    data-current={here || undefined}
                    data-uncited={uncited || undefined}
                    aria-busy={fetching || undefined}
                  >
                    <Heading
                      id={titleOf}
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
                    {pageLink ? (
                      <Link
                        href={pageLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-size="sm"
                        className="uib-document-view-link"
                        // Named in one piece: a hidden span is a box of its own to a browser,
                        // which then reads a space before the comma, «Kudos , Utdrag 2».
                        aria-label={`${readPage}, ${nameOf(excerpt)}, ${documentTitle} ${t('sources.opensInNewTab')}`}
                      >
                        {readPage}
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
                onChange={(event) =>
                  setDraft({ document: shownKey, question: event.target.value, sent: '' })
                }
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
