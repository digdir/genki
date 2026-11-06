import { Button, Card, Paragraph } from '@digdir/designsystemet-react';
import { MagnifyingGlassIcon } from '@navikt/aksel-icons';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Answer, type AnswerTarget } from '../answer/Answer.js';
import { useT } from '../i18n.js';
import type { MarkdownHighlight } from '../markdown/Markdown.js';
import { findHits, stepHit } from '../markdown/textSearch.js';
import type { CitationMode } from '../sources/pairing.js';
import type { SourceDocument, SourceTarget } from '../sources/types.js';
import { AnswerSearch } from './AnswerSearch.js';
import { AnswerTime } from './AnswerTime.js';
import { Clarification } from './Clarification.js';
import { useFollowAnswer } from './follow.js';
import { answerVisibleText } from './search.js';
import { ThreadLoading } from './ThreadLoading.js';
import type {
  ConversationActionParts,
  ConversationAnswer,
  ConversationClarification,
  ConversationQuestion,
  ConversationScope,
  ConversationTarget,
  ConversationTurn,
} from './types.js';

/** Without progress this long, an answer on its way says it takes longer than usual. */
export const SLOW_ANSWER_MS = 30_000;
/** Without progress this long, the app is told the answer has stalled, to stop it. */
export const STALLED_ANSWER_MS = 300_000;

export interface ConversationProps {
  /** The turns in the order they were said: the order is the meaning. */
  turns: readonly ConversationTurn[];
  /** The thread is being read. With no turn yet, a question and an answer in outline stand in. */
  loading?: boolean | undefined;
  /** A footnote was followed: in which answer, its index there, and the item it cites. */
  onOpenCitation?:
    ((turn: ConversationAnswer, citation: number, target: SourceTarget) => void) | undefined;
  /** A document in «Kilder brukt i svaret» was chosen, in which answer. */
  onOpenDocument?: ((turn: ConversationAnswer, source: SourceDocument) => void) | undefined;
  /** Asks a stopped or failed question again, offered under that answer. */
  onRegenerate?: ((turn: ConversationAnswer) => void) | undefined;
  /** One of the answers a question back offers was chosen. */
  onReply?: ((turn: ConversationClarification, option: string) => void) | undefined;
  /** Where a footnote or a document leads, for a new tab and for copying. */
  href?: ((turn: ConversationAnswer, target: SourceTarget) => string | undefined) | undefined;
  /** An id for each footnote, unique in the page: each answer counts its footnotes from 0. */
  citationId?: ((turn: ConversationAnswer, citation: number) => string) | undefined;
  /** The footnote to scroll to and focus, where Sources' `onShowUse` and `onReturn` lead. */
  target?: ConversationTarget | undefined;
  /** Over an answer or a question back: «Fremgangsmåte», for example. */
  header?:
    | ((
        turn: ConversationAnswer | ConversationClarification,
        question: ConversationQuestion | undefined,
      ) => ReactNode)
    | undefined;
  /**
   * The row under a finished answer, such as `AnswerActions`. Put `end` at the far end of it and
   * `search` among its actions. Without it, the row holds those two alone.
   */
  actions?: ((turn: ConversationAnswer, parts: ConversationActionParts) => ReactNode) | undefined;
  /**
   * «Søk i svaret» under each finished answer, and the search strip over the conversation. Off
   * unless asked for: kunnskapsassistenten took it out (digdir/kunnskapsassistenten#209).
   */
  search?: boolean | undefined;
  /** Keeps the column at its end while an answer comes, if the reader was there. On by default. */
  follow?: boolean | undefined;
  /** The column the conversation scrolls in. Without it, the nearest ancestor that scrolls. */
  scrollContainer?: RefObject<HTMLElement | null> | undefined;
  /** The reader came to or left the end of the column: for the composer's «Bla til bunnen». */
  onAtEndChange?: ((atEnd: boolean) => void) | undefined;
  /**
   * How long an answer on its way may go without progress, a new turn object, before a line says
   * it takes longer than usual. `false` draws no line.
   */
  slowAfter?: number | false | undefined;
  /** How long without progress before `onStalled`. */
  stalledAfter?: number | undefined;
  /** An answer on its way has stalled: the app stops it, as with «Avbryt». */
  onStalled?: ((turn: ConversationAnswer) => void) | undefined;
  /** The service's choice, or the reader's, for every answer. */
  citationMode?: CitationMode | undefined;
  /** «Kilder brukt i svaret» under a finished answer. */
  sourcesUsed?: boolean | undefined;
  /** «Er det noe mer jeg kan hjelpe deg med?» under a finished answer. */
  closingQuestion?: boolean | undefined;
  /** Who answers, for a screen reader. Without it, the AI assistant. */
  assistantName?: string | undefined;
  /** The level of an answer's own top heading. */
  headingLevel?: 2 | 3 | 4 | undefined;
  /** Designsystemet's `data-color` for the reader's questions, set only when given. */
  questionColor?: string | undefined;
  /** Designsystemet's `data-color` for each answer, question back and stand-in, when given. */
  answerColor?: string | undefined;
  /** Designsystemet's `data-color` for the block, set only when given. */
  color?: string | undefined;
  /** The moment an answer's «i dag» and «i går» are counted from. */
  now?: Date | undefined;
  className?: string | undefined;
}

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

const stillMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The reader's question an answer answers: backwards, since a question back can sit between. */
const questionBefore = (turns: readonly ConversationTurn[], index: number) => {
  for (let i = index - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.kind === 'question') return turn;
  }
  return undefined;
};

/**
 * The conversation: the reader's questions, the answers and the questions back, as an ordered
 * list, because the order is the meaning. Who said what is said in words to a screen reader, not
 * only by side and colour. Each answer is the `Answer` block. The block only draws and raises
 * events: the app holds the thread, sends, and fills the slots.
 */
export const Conversation = ({
  turns,
  loading = false,
  onOpenCitation,
  onOpenDocument,
  onRegenerate,
  onReply,
  href,
  citationId,
  target,
  header,
  actions,
  search = false,
  follow = true,
  scrollContainer,
  onAtEndChange,
  slowAfter = SLOW_ANSWER_MS,
  stalledAfter = STALLED_ANSWER_MS,
  onStalled,
  citationMode = 'excerpt',
  sourcesUsed,
  closingQuestion,
  assistantName,
  headingLevel = 3,
  questionColor,
  answerColor,
  color,
  now,
  className,
}: ConversationProps) => {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());

  // An answer is on its way from the moment the question stands last, so the question's own
  // growth is followed too.
  const last = turns.at(-1);
  const waiting = last?.kind === 'answer' && last.status === 'streaming' ? last : undefined;
  const answering = waiting !== undefined || (last?.kind === 'question' && !loading);
  const atEnd = useFollowAnswer(rootRef, answering, follow, scrollContainer);
  const atEndChange = useRef(onAtEndChange);
  atEndChange.current = onAtEndChange;
  useEffect(() => {
    atEndChange.current?.(atEnd);
  }, [atEnd]);

  // Progress is a new turn object for the answer on its way: a word, a step, a source.
  const [slowFor, setSlowFor] = useState<ConversationAnswer>();
  const [slowSaidFor, setSlowSaidFor] = useState<string>();
  const stalled = useRef(onStalled);
  stalled.current = onStalled;
  useEffect(() => {
    if (!waiting) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (slowAfter !== false)
      timers.push(
        setTimeout(() => {
          setSlowFor(waiting);
          setSlowSaidFor(waiting.id);
        }, slowAfter),
      );
    timers.push(setTimeout(() => stalled.current?.(waiting), stalledAfter));
    return () => timers.forEach(clearTimeout);
  }, [waiting, slowAfter, stalledAfter]);
  const slow = waiting !== undefined && slowFor === waiting;

  // The thread is read through a region that is already in the page: one that arrives with its
  // words was inserted, not changed, and says nothing. The timer makes the words a change.
  const reading = loading && turns.length === 0;
  const [noticeSaid, setNoticeSaid] = useState(false);
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => setNoticeSaid(true));
    return () => clearTimeout(timer);
  }, [reading]);

  // One strip and one query: another answer starts a fresh search, not the last one's words.
  const [searching, setSearching] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const answers = turns.filter((turn) => turn.kind === 'answer');
  const searched = search
    ? answers.find((turn) => turn.id === searching && turn.status === 'complete')
    : undefined;
  const visible = useMemo(
    () => (searched ? answerVisibleText(searched, citationMode) : undefined),
    [searched, citationMode],
  );
  const hits = useMemo(
    () => (searched && visible ? findHits([{ id: searched.id, text: visible.text }], query) : []),
    [searched, visible, query],
  );
  // An answer that changes under a standing query must not leave the reader past the end.
  const current = Math.min(hitIndex, Math.max(hits.length - 1, 0));
  const highlight: MarkdownHighlight | undefined =
    visible && hits.length
      ? {
          hits,
          offsets: visible.offsets,
          current: hits[current],
          markClassName: 'uib-conversation-mark',
        }
      : undefined;

  const searchedId = searched?.id;
  useEffect(() => {
    if (searchedId !== undefined) fieldRef.current?.focus();
  }, [searchedId]);

  // Moving to a hit is what scrolls, and only that: a new query lands on its first hit.
  useEffect(() => {
    if (searchedId === undefined || hits.length === 0) return;
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('mark[data-current]')
        ?.scrollIntoView?.({ behavior: stillMotion() ? 'auto' : 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchedId, query, current, hits.length]);

  const closeSearch = () => {
    const was = searchedId;
    setSearching(null);
    setQuery('');
    setHitIndex(0);
    // The strip is gone, and a keyboard user in it would land at the top of the page.
    if (was !== undefined) toggles.current.get(was)?.focus();
  };
  const toggleSearch = (id: string) => {
    if (id === searchedId) return closeSearch();
    setSearching(id);
    setQuery('');
    setHitIndex(0);
  };

  // Held by identity: the answer scrolls to its footnote each time it gets a new target.
  const answerTarget = useMemo<AnswerTarget | undefined>(
    () => (target ? { citation: target.citation } : undefined),
    [target],
  );

  const rowFor = (turn: ConversationAnswer): ReactNode => {
    const end = turn.createdAt === undefined ? null : <AnswerTime at={turn.createdAt} now={now} />;
    if (turn.status !== 'complete') return end ?? undefined;
    const searchButton = search ? (
      <Button
        ref={(element: HTMLButtonElement | null) => {
          if (element) toggles.current.set(turn.id, element);
          else toggles.current.delete(turn.id);
        }}
        variant="tertiary"
        data-size="sm"
        aria-expanded={turn.id === searchedId}
        onClick={() => toggleSearch(turn.id)}
      >
        <MagnifyingGlassIcon aria-hidden />
        {t('conversation.search')}
      </Button>
    ) : null;
    if (actions) return actions(turn, { end, search: searchButton });
    return end || searchButton ? (
      <>
        {searchButton}
        {end}
      </>
    ) : undefined;
  };

  // The corpus and the filter as two facts: in one list, «Kudos · Årsrapport · 2023» reads as
  // three things the reader chose. Nothing narrowed is not «avgrenset»: it was asked of all of it.
  const scopeWords = (scope: string | ConversationScope | undefined) => {
    if (scope === undefined || typeof scope === 'string') return scope;
    const values = (scope.narrowedTo ?? []).filter(Boolean).join(' · ');
    if (values && scope.corpus)
      return t('conversation.narrowedFrom', { values, corpus: scope.corpus });
    if (values) return t('conversation.narrowed', { values });
    return scope.corpus ? t('conversation.fetchedFrom', { corpus: scope.corpus }) : undefined;
  };

  const scopeLine = (scope: string | ConversationScope | undefined, said: string) => {
    const words = scopeWords(scope);
    return words ? (
      <p className="uib-conversation-scope">
        <span className="ds-sr-only">{said} </span>
        {words}
      </p>
    ) : null;
  };

  const drawTurn = (turn: ConversationTurn, index: number) => {
    if (turn.kind === 'question')
      return (
        <li key={turn.id} className="uib-conversation-turn" data-kind="question">
          <span className="ds-sr-only">{t('conversation.youWrote')}</span>
          <Card className="uib-conversation-question" data-color={questionColor} variant="tinted">
            <Paragraph variant="long" lang={turn.lang}>
              {turn.text}
            </Paragraph>
            {/* Under the words and not over them: the words are what the reader wrote, the
                documents what they wrote it about. */}
            {turn.attachments?.length ? (
              <Paragraph data-size="sm" className="uib-conversation-attachments">
                {t('conversation.attachments', { names: turn.attachments.join(', ') })}
              </Paragraph>
            ) : null}
          </Card>
        </li>
      );

    const question = questionBefore(turns, index);
    if (turn.kind === 'clarification')
      return (
        <li key={turn.id} className="uib-conversation-turn" data-kind="clarification">
          {/* It searched with the filter before it asked, so the question back was narrowed too.
              Said as documents, since the line can be «Hentet fra Kudos», and the question was
              not fetched. */}
          {scopeLine(turn.scope, t('conversation.clarificationScope'))}
          {header?.(turn, question)}
          <Clarification
            text={turn.text}
            options={turn.options}
            onReply={onReply && ((option) => onReply(turn, option))}
            assistantName={assistantName}
            headingLevel={headingLevel}
            color={answerColor}
          />
        </li>
      );

    return (
      <li key={turn.id} className="uib-conversation-turn" data-kind="answer">
        {/* Over the card: a fact about the question, not part of the answer. */}
        {scopeLine(turn.scope, t('conversation.answerScope'))}
        {header?.(turn, question)}
        <Answer
          text={turn.text}
          status={turn.status}
          sources={turn.sources}
          markers={turn.markers}
          citationMode={citationMode}
          noAnswer={turn.noAnswer}
          onOpenCitation={
            onOpenCitation && ((citation, goal) => onOpenCitation(turn, citation, goal))
          }
          onOpenDocument={onOpenDocument && ((source) => onOpenDocument(turn, source))}
          href={href && ((goal) => href(turn, goal))}
          citationId={citationId && ((citation) => citationId(turn, citation))}
          target={target?.turnId === turn.id ? answerTarget : undefined}
          highlight={turn.id === searchedId ? highlight : undefined}
          sourcesUsed={sourcesUsed}
          closingQuestion={closingQuestion}
          onRegenerate={onRegenerate && (() => onRegenerate(turn))}
          failure={turn.failure}
          actions={rowFor(turn)}
          assistantName={assistantName}
          headingLevel={headingLevel}
          color={answerColor}
        />
      </li>
    );
  };

  const searchLabel = () => {
    if (answers.length < 2) return t('conversation.search');
    const n = answers.findIndex((turn) => turn.id === searchedId) + 1;
    return t('conversation.searchOf', { n, total: answers.length });
  };

  return (
    <div ref={rootRef} className={classes('uib-conversation', className)} data-color={color}>
      {/* First, so the tab order meets the strip before the answer it searches. */}
      {searched ? (
        <AnswerSearch
          query={query}
          onQueryChange={(next) => {
            setQuery(next);
            setHitIndex(0);
          }}
          hitCount={hits.length}
          currentHitIndex={current}
          onStep={(step) => setHitIndex(stepHit(hits.length, current, step))}
          onClose={closeSearch}
          fieldRef={fieldRef}
          label={searchLabel()}
        />
      ) : null}
      {/* What is on screen wins over the outline: a question asked while the thread is read is
          the reader's own words, and an outline over it would take them away. */}
      {turns.length ? (
        <ol className="uib-conversation-turns" ref={listRef}>
          {turns.map(drawTurn)}
        </ol>
      ) : reading ? (
        <ThreadLoading color={answerColor} />
      ) : null}
      {/* A line and not an alert: nothing has gone wrong yet, and «Avbryt» is still the way out. */}
      {slow ? (
        <Paragraph data-size="sm" variant="long" className="uib-conversation-slow">
          {t('conversation.slow')}
        </Paragraph>
      ) : null}
      {/* The slow answer is said once per answer: the words stay until it ends, so a second
          wait changes nothing here. */}
      <p aria-live="polite" className="ds-sr-only">
        {reading && noticeSaid
          ? t('conversation.loading')
          : waiting && slowSaidFor === waiting.id
            ? t('conversation.slow')
            : ''}
      </p>
    </div>
  );
};
