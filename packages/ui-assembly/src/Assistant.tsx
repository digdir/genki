// Draws an assistant from a layout: each catalogue block's members in its zone of the shell,
// linked through the channels `useAssistant` keeps. The arrangement inside each zone follows
// kunnskapsassistenten, as the UI blocks preview draws it; what the preview never drew follows
// the design's board 3: Filter in the main column as a strip with «Endre», Chat or Fremgangsmåte
// in the secondary panel, Dokumentvisning in either, and the secondary panel's tool rule.
import { Button, Details, Paragraph, SkipLink } from '@digdir/designsystemet-react';
import {
  AnswerActions,
  Composer,
  ComposerDisclaimer,
  Conversation,
  CorpusChoice,
  CorpusLine,
  Documents,
  DocumentView,
  EmptyState,
  ErrorState,
  Filter,
  NotFoundState,
  Procedure,
  Settings,
  SettingsLinks,
  Shell,
  ShellTools,
  SignedIn,
  Sources,
  Suggestions,
  Threads,
  VariantPicker,
  Welcome,
  answerCopy,
  isEmptySelection,
  type AnswerCopied,
  type AnswerFeedbackStatus,
  type ConversationAnswer,
  type ShellPanel,
  type ShellTool,
  type SourceDocument,
  type SourceTarget,
} from '@genai/ui-blocks';
import { ArrowLeftIcon, FileTextIcon } from '@navikt/aksel-icons';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { phrase, useT, type AssemblyTranslator } from './i18n.js';
import { stepsOf } from './procedure.js';
import { useAssistant, type AssistantOptions, type AssistantState } from './useAssistant.js';

// The modifier to name; the shortcut takes both (kunnskapsassistenten's shortcutModifier.ts).
const modifier = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? 'Cmd' : 'Ctrl';

export interface AssistantProps extends AssistantOptions {
  /** The `id` of `<main>`, the target of «Hopp til hovedinnhold». */
  mainId?: string | undefined;
}

/** The assistant a layout describes, live against the service through `api`. */
export const Assistant = ({ mainId, ...options }: AssistantProps) => (
  <AssistantView assistant={useAssistant(options)} mainId={mainId} />
);

const AnswerRow = ({
  a,
  turn,
  end,
  search,
}: {
  a: AssistantState;
  turn: ConversationAnswer;
  end: ReactNode;
  search: ReactNode;
}) => {
  const t = useT();
  const [copied, setCopied] = useState<AnswerCopied>();
  const [status, setStatus] = useState<AnswerFeedbackStatus>();
  const copy = async (text: string, done: AnswerCopied) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(done);
    } catch {
      setCopied({ kind: 'failed' });
    }
  };
  const copying = a.option('chat', 'copy');
  const feedback = a.option('chat', 'feedback') && !!a.onFeedback;
  return (
    <AnswerActions
      {...(copying
        ? {
            // What the screen says: the footnotes numbered as drawn, and a line per reference.
            onCopyAnswer: () => {
              const { text, sources } = answerCopy(turn.text, {
                sources: turn.sources,
                markers: turn.markers,
                locale: t.locale,
              });
              void copy(text, { kind: 'answer', sources });
            },
            // A link that opens the thread: only where the thread is in the address.
            ...(a.urlThreads && a.currentId
              ? {
                  onCopyLink: () =>
                    void copy(new URL(a.hrefOf(a.currentId), location.href).href, {
                      kind: 'link',
                    }),
                  linkOnlyHere: true,
                }
              : {}),
          }
        : {})}
      copied={copied}
      feedback={feedback}
      onFeedback={(given) => {
        setStatus('sending');
        void Promise.resolve(
          a.onFeedback?.({
            answerId: turn.id,
            rating: given.rating,
            reasons: given.reasons,
            comment: given.comment,
          }),
        ).then(
          () => setStatus('sent'),
          () => setStatus('failed'),
        );
      }}
      feedbackStatus={status}
      actions={search}
      end={end}
    />
  );
};

/** «Fremgangsmåte» for one turn asked here, at the reader's level. Stored turns carry no steps. */
const approachOf = (a: AssistantState, turnId: string | undefined, t: AssemblyTranslator) => {
  const turn = a.turns.find((one) => one.id === turnId);
  const approach = turn?.approach;
  if (!turn || !approach) return null;
  const busy = turn.answer?.status === 'streaming';
  const steps = stepsOf(approach, busy, t.locale);
  if (steps.length === 0) return null;
  return (
    <>
      <Procedure
        steps={steps}
        working={busy}
        startedAt={approach.startedAt}
        {...(approach.finishedAt ? { finishedAt: approach.finishedAt } : {})}
        {...(turn.answer?.sources ? { used: turn.answer.sources.length } : {})}
      />
      {a.level === 'detailed' ? (
        // No block draws the detailed level yet: the step frames as genki sent them, for now.
        <Details data-size="sm">
          <Details.Summary>{t('assembly.technicalDetails')}</Details.Summary>
          <Details.Content>
            <ol className="uia-frames">
              {approach.frames.map((frame, i) => (
                <li key={i}>
                  <code>
                    {[
                      frame.event,
                      frame.stage,
                      frame.tool,
                      frame.iteration !== undefined ? `#${frame.iteration}` : '',
                      frame.label,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </code>
                </li>
              ))}
            </ol>
          </Details.Content>
        </Details>
      ) : null}
    </>
  );
};

export const AssistantView = ({
  assistant: a,
  mainId = 'main-content',
}: {
  assistant: AssistantState;
  mainId?: string | undefined;
}) => {
  const t = useT();
  const chatZone = a.where('chat');
  const approachZone = a.where('approach');
  const filterZone = a.where('filter');
  const threadsOn = a.has('threads');
  const sourcesOn = a.has('sources');
  const documentOn = a.has('document-view');
  const settingsOn = a.has('settings');
  const name = a.assistantName;
  // The document stands where the conversation was, with Dokumentvisning beside Chat in «Innhold».
  const chatHidden = a.documentOverChat && !!a.openDoc;

  /** A footnote, or a document under the answer: Kilder when it is there, else Dokumentvisning. */
  const follow = (
    turn: ConversationAnswer,
    target: SourceTarget,
    followed: NonNullable<AssistantState['lastFollowed']['current']>,
  ) => {
    a.lastFollowed.current = followed;
    if (sourcesOn) a.showSources(turn.id, target);
    else if (documentOn) a.openDocument(turn.id, target, 'answer');
  };

  // The primary panel holds Tråder and Filter as two views, as kunnskapsassistenten does, and a
  // first visit lands on the filter.
  const [primaryView, setPrimaryView] = useState<'threads' | 'filters'>('filters');
  const [switchedView, setSwitchedView] = useState(false);
  const [filterPin, setFilterPin] = useState<HTMLDivElement | null>(null);
  // The secondary panel's pinned region, where its tools' switcher stays while a tool scrolls.
  const [toolsPin, setToolsPin] = useState<HTMLDivElement | null>(null);
  // Dokumentvisning's steps stay at the top while the document scrolls: under the switcher pinned
  // there, not behind it.
  const [toolsPinHeight, setToolsPinHeight] = useState(0);
  useEffect(() => {
    if (!toolsPin || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setToolsPinHeight(Math.round(toolsPin.offsetHeight)));
    observer.observe(toolsPin);
    return () => observer.disconnect();
  }, [toolsPin]);
  // A folded panel that opens on a document gets its scroll padding from the shell a frame after
  // the block has scrolled to the excerpt, which then opens under the steps. The same padding,
  // the pinned switcher's height, is set here as the document opens: after the shell's own effects,
  // which open a drawer, and before the block's next frame.
  useEffect(() => {
    const region = toolsPin?.parentElement;
    if (!a.openDoc || !toolsPin || !region) return;
    region.style.scrollPaddingBlockStart = `${Math.round(toolsPin.offsetHeight)}px`;
  }, [a.openDoc, toolsPin]);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (switchedView && primaryView === 'filters') back.current?.focus();
  }, [switchedView, primaryView]);
  // The strip in the main column opens the filter under it with «Endre».
  const [stripOpen, setStripOpen] = useState(false);

  // kunnskapsassistenten's trials, where the profile offers them and the reader turned them on.
  const filtersBeside = a.flags.has('filters-right-panel') && filterZone === 'primary';
  const twoViews = threadsOn && filterZone === 'primary' && !filtersBeside;

  const [atEnd, setAtEnd] = useState(true);
  const start = a.view === 'new' || (a.view === 'ready' && a.turns.length === 0);
  const lastAnswer = a.turns.at(-1)?.answer;

  // The skip link goes to the field's id, so it has a target (axe `region`). Read again only when
  // the field may be another: on the other page, in another zone, or back from a missing thread.
  const [fieldId, setFieldId] = useState<string>();
  const fieldShown = a.page === 'chat' && chatZone !== undefined && a.view !== 'notfound';
  useEffect(() => {
    const field = a.fieldRef.current;
    if (field && !field.id) field.id = 'composer-field';
    setFieldId(field?.id || undefined);
  }, [a.fieldRef, fieldShown, chatZone]);
  // No focus hides under the docked field: scroll padding as tall as the dock (WCAG 2.4.11). One
  // observer per docked field, which reports as the field docks and grows.
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const main = document.getElementById(mainId);
    if (!main || !dock || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      main.style.scrollPaddingBlockEnd =
        getComputedStyle(dock).position === 'sticky' ? `${Math.round(dock.offsetHeight)}px` : '';
    });
    observer.observe(dock);
    return () => {
      observer.disconnect();
      main.style.scrollPaddingBlockEnd = '';
    };
  }, [mainId, dock]);
  // When the answer is done, «Avbryt genereringen» turns back into a disabled send button; focus
  // that was on it goes to the field, not to the page. Focus the reader moved elsewhere stays.
  const wasWorking = useRef(false);
  useEffect(() => {
    const ended = wasWorking.current && !a.working;
    wasWorking.current = a.working;
    if (!ended) return;
    const lost = () => {
      const active = document.activeElement;
      return active === null || active === document.body || !active.isConnected;
    };
    if (lost()) a.fieldRef.current?.focus();
    requestAnimationFrame(() => {
      if (lost()) a.fieldRef.current?.focus();
    });
  }, [a.working, a.fieldRef]);

  // The page's one `h1`, the assistant's name, before everything else on it (WCAG 1.3.1, 2.4.6).
  // Chat alone in the main column draws it, as kunnskapsassistenten does; otherwise the column.
  const pageHeading = <h1 className="ds-sr-only">{name}</h1>;

  // ── Chat ──
  const chat = (inPanel: boolean, titled: boolean) => {
    let middle;
    if (a.view === 'notfound') {
      middle = (
        <NotFoundState
          homeHref={a.hrefOf()}
          onGoHome={() => a.leave(undefined)}
          title={t('assembly.threadNotFoundTitle')}
          description={t('assembly.threadNotFound')}
        />
      );
    } else if (a.view === 'error') {
      middle = (
        <ErrorState
          title={t('assembly.threadFailed')}
          message={a.viewError}
          onRetry={a.retryThread}
        />
      );
    } else if (start) {
      middle = (
        <div className="uia-greeting">
          <Welcome />
          {a.view === 'ready' ? (
            <EmptyState
              title={t('assembly.emptyThreadTitle')}
              description={t('assembly.emptyThread')}
            />
          ) : null}
        </div>
      );
    } else {
      middle = (
        <Conversation
          turns={a.conversation}
          loading={a.view === 'loading'}
          assistantName={name}
          answerColor="neutral"
          {...(a.named ? { title: a.named, titleRepeatsQuestion: a.repeatsQuestion } : {})}
          target={a.answerTarget}
          header={(turn) =>
            turn.kind === 'answer' && approachZone === 'main' && chatZone === 'main'
              ? approachOf(a, turn.id, t)
              : null
          }
          {...(a.footnotes
            ? {
                onOpenCitation: (
                  turn: ConversationAnswer,
                  citation: number,
                  target: SourceTarget,
                ) => follow(turn, target, { turnId: turn.id, citation }),
                onOpenDocument: (turn: ConversationAnswer, source: SourceDocument) => {
                  const target = { documentId: source.documentId, index: source.index };
                  follow(turn, target, { turnId: turn.id, document: target });
                },
                sourcesUsed: true,
              }
            : {})}
          onRegenerate={(turn, question) => {
            const own = a.turns.find((t) => t.id === turn.id || `${t.id}-q` === question?.id);
            const asked = question?.text ?? own?.question;
            if (asked) a.send(asked, { replaces: own?.id ?? turn.id });
          }}
          closingQuestion
          onAtEndChange={setAtEnd}
          actions={(turn, parts) => (
            <AnswerRow a={a} turn={turn} end={parts.end} search={parts.search} />
          )}
        />
      );
    }
    const suggestions = a.option('chat', 'suggestions') ? (a.profile?.suggestions ?? []) : [];
    const followUps = a.option('chat', 'followUps') ? a.profile?.followUps : undefined;
    const disclaimer = a.option('chat', 'disclaimer');
    return (
      <div
        className="uia-chat"
        data-start={start || undefined}
        data-in-panel={inPanel || undefined}
      >
        {titled ? pageHeading : null}
        {middle}
        {a.serviceTrouble ? (
          // Without the service's facts the collection is unknown, so nothing can be asked.
          <ErrorState
            title={t('assembly.serviceFailedTitle')}
            message={
              a.modelsFailed ? t('assembly.serviceFailed', { error: a.modelsFailed }) : undefined
            }
            onRetry={a.retryModels}
            headingLevel={2}
          />
        ) : null}
        {a.view === 'notfound' ? null : (
          <Composer
            className="uia-composer"
            value={a.draft}
            onChange={a.setDraft}
            onSubmit={(question) => a.send(question, { fromField: true })}
            working={a.working}
            onCancel={a.cancel}
            assistantName={name}
            showDisclaimer={disclaimer && !start}
            followUps={
              !a.working && lastAnswer?.status === 'complete' && !lastAnswer.noAnswer
                ? followUps
                : undefined
            }
            {...(atEnd || start || inPanel
              ? {}
              : {
                  onScrollToBottom: () => {
                    const main = document.getElementById(mainId);
                    main?.scrollTo({ top: main.scrollHeight, behavior: 'smooth' });
                  },
                })}
            actions={
              a.option('chat', 'variantPicker') ? (
                <VariantPicker variants={a.variants} value={a.model} onChange={a.setModel} />
              ) : undefined
            }
            sticky={!start && !inPanel}
            fieldRef={a.fieldRef}
            {...(inPanel ? {} : { ref: setDock })}
          />
        )}
        {start ? (
          <>
            {suggestions.length > 0 ? (
              <div className="uia-suggestions">
                <Suggestions
                  suggestions={suggestions}
                  onPick={(question) => {
                    a.setDraft(question);
                    a.fieldRef.current?.focus();
                  }}
                />
              </div>
            ) : null}
            {disclaimer ? (
              <ComposerDisclaimer assistantName={name} className="uia-disclaimer" />
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  // ── Filter ──
  // In the strip, the corpus line stands over the filter already: the documents go without it.
  const filter = (
    pinIn: HTMLDivElement | null | undefined,
    headingLevel: 2 | 3,
    inStrip = false,
  ) => (
    <Filter
      {...(pinIn !== undefined ? { pinIn } : {})}
      yearPeriods={a.flags.has('year-ranges')}
      compactChips={a.flags.has('compact-filter-chips')}
      fields={a.facets}
      selection={a.selection}
      onChange={a.setSelection}
      failed={a.facetsFailed}
      onRetry={a.retryFacets}
      thread={a.currentId}
      newThreadHref={a.hrefOf()}
      onNewThread={(event) => {
        event.preventDefault();
        a.leave(undefined);
      }}
      headingLevel={headingLevel}
      head={
        a.corpusChoice && a.corpus ? (
          <CorpusChoice
            options={a.corpora.length > 0 ? a.corpora : [a.corpus]}
            value={a.corpus.key}
            onChange={a.chooseCorpus}
            resetsFilter={!isEmptySelection(a.selection)}
          />
        ) : undefined
      }
    >
      {a.option('filter', 'documents') ? (
        <Documents
          documents={a.documents}
          corpus={a.corpus}
          {...(inStrip ? {} : { corpusLine })}
          headingLevel={(headingLevel + 1) as 3 | 4}
        />
      ) : null}
    </Filter>
  );
  const corpusProfile = a.corpusKey ? a.profile?.corpora?.[a.corpusKey] : undefined;
  const corpusLine = (
    <CorpusLine
      corpus={a.corpus}
      fields={a.baseFacets}
      typeField={corpusProfile?.typeField}
      typePlurals={corpusProfile?.typePlurals}
    />
  );
  const narrowedTo = (a.facets ?? []).flatMap((field) => [...(a.selection[field.id] ?? [])]);
  // The design's strip over the conversation: what the thread reads from, and «Endre».
  const filterStrip = (
    <section className="uia-filter-strip" aria-label={t('builder.filter')}>
      <div className="uia-filter-strip-row">
        <div className="uia-filter-strip-text">
          {corpusLine}
          {narrowedTo.length > 0 ? (
            <Paragraph data-size="sm" className="uia-filter-strip-narrowed">
              {t('conversation.narrowed', { values: narrowedTo.join(' · ') })}
            </Paragraph>
          ) : null}
        </div>
        <Button
          variant="secondary"
          data-size="sm"
          aria-expanded={stripOpen}
          onClick={() => setStripOpen((open) => !open)}
        >
          {stripOpen ? t('assembly.stripClose') : t('assembly.stripChange')}
        </Button>
      </div>
      {stripOpen ? <div className="uia-filter-strip-body">{filter(undefined, 2, true)}</div> : null}
    </section>
  );

  // ── Threads ──
  const threadList = (
    <Threads
      threads={a.threadRows}
      failed={a.threadsFailed}
      onRetry={a.reloadThreads}
      currentId={a.page === 'chat' ? a.currentId : undefined}
      threadHref={(thread) => a.hrefOf(thread.id)}
      onOpenThread={(thread) => a.leave(thread.id)}
      newThreadHref={a.hrefOf()}
      onNewThread={() => {
        if (twoViews) {
          setPrimaryView('filters');
          setSwitchedView(false);
        }
        a.newThread();
      }}
      {...(a.renameThread ? { onRename: a.renameThread } : {})}
      {...(a.deleteThread ? { onDelete: a.deleteThread } : {})}
      foot={
        a.profile?.signedInAs ? (
          <SignedIn name={a.profile.signedInAs} signOutHref={a.hrefOf()} onSignOut={a.signOut} />
        ) : undefined
      }
      {...(twoViews
        ? {
            onShowFilters: () => {
              setPrimaryView('filters');
              setSwitchedView(true);
            },
            focusShowFilters: switchedView,
          }
        : {})}
    />
  );

  // ── Settings, from the primary panel's foot ──
  const foot = settingsOn ? (
    <SettingsLinks
      settingsHref={a.settingsHref}
      currentHref={a.page === 'settings' ? a.settingsHref : undefined}
      assistantName={name}
      onNavigate={() => a.showSettings()}
    />
  ) : undefined;

  const threadsAndFilter = phrase(t, [t('builder.threads'), t('builder.filter')]);
  let primary: ShellPanel | undefined;
  if (twoViews) {
    primary =
      primaryView === 'threads'
        ? { label: threadsAndFilter, children: threadList, foot }
        : {
            label: threadsAndFilter,
            head: (
              <Button
                ref={back}
                variant="tertiary"
                data-color="neutral"
                onClick={() => {
                  setPrimaryView('threads');
                  setSwitchedView(true);
                }}
              >
                <ArrowLeftIcon aria-hidden />
                {t('builder.threads')}
              </Button>
            ),
            pinnedRef: setFilterPin,
            children: filter(filterPin, 2),
            foot,
          };
  } else if (threadsOn) {
    primary = { label: t('builder.threads'), children: threadList, foot };
  } else if (filterZone === 'primary' && !filtersBeside) {
    primary = {
      label: t('builder.filter'),
      pinnedRef: setFilterPin,
      children: filter(filterPin, 2),
      foot,
    };
  } else if (foot) {
    primary = { label: t('builder.settings'), foot, footPinned: true };
  }

  // ── The secondary panel's tools, in the catalogue's order ──
  const sourcesView = (titled: boolean) => (
    <Sources
      color="neutral"
      {...(titled ? {} : { title: false })}
      sources={a.activeAnswer?.sources}
      answerStatus={a.activeAnswer ? a.activeAnswer.status : 'unasked'}
      citations={a.citations}
      loading={a.activeAnswer?.status === 'streaming' && !a.activeAnswer.sources}
      corpus={a.corpus?.label}
      assistantName={name}
      target={a.sourceTarget}
      answerIndex={a.shownIndex}
      answerCount={a.answered.length}
      onAnswerChange={a.showAnswer}
      onShowUse={a.footnotes ? a.goToUse : undefined}
      onReturn={a.footnotes ? a.returnToAnswer : undefined}
      disclaimer={a.option('sources', 'disclaimer')}
      search={a.option('sources', 'search')}
      details
      headingLevel={3}
      {...(documentOn
        ? {
            excerptActions: ({ source, excerpt }) => (
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => {
                  if (!a.active) return;
                  a.openDocument(
                    a.active.id,
                    { chunkId: excerpt.chunkId, documentId: source.documentId },
                    'sources',
                  );
                }}
              >
                <FileTextIcon aria-hidden />
                {t('assembly.showInDocument')}
                <span className="ds-sr-only">, {source.title}</span>
              </Button>
            ),
          }
        : {})}
    />
  );
  // Escape in the document is its way back. In a drawer, a modal dialog, the browser would also
  // close the drawer and put the focus on the drawer's button, wherever the way back sends it.
  // Not from the question field, where Escape is the field's.
  const escapeStaysInDrawer = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !a.openDoc) return;
    if (event.target instanceof Element && event.target.closest('form')) return;
    event.preventDefault();
  };
  const documentView = (titled: boolean) => (
    <DocumentView
      color="neutral"
      {...(titled ? {} : { title: false })}
      sources={a.documentAnswer?.sources}
      target={a.openDoc?.target}
      citations={a.documentCitations}
      answerIndex={a.documentIndex}
      answerCount={a.answered.length}
      onShowUse={a.footnotes ? a.showDocumentUse : undefined}
      onReturn={a.openDoc ? a.returnFromDocument : undefined}
      returnTo={a.openDoc?.returnTo}
      // Asked in the thread, where Chat is: without it there is nowhere to ask.
      onAsk={chatZone ? a.askAboutDocument : undefined}
      corpus={a.corpus?.label}
      headingLevel={3}
    />
  );
  // Stored answers carry no steps, so a thread that has some says why none are shown.
  const approachPanel = approachOf(a, a.active?.id, t) ?? (
    <Paragraph data-size="sm" className="uia-quiet">
      {a.working
        ? t('assembly.approachWaiting')
        : a.answered.length > 0
          ? t('assembly.approachNotKept')
          : t('assembly.approachEmpty')}
    </Paragraph>
  );
  const tools: ShellTool[] = [
    ...(approachZone === 'secondary'
      ? [{ id: 'approach', label: t('builder.approach'), content: approachPanel }]
      : []),
    ...(chatZone === 'secondary'
      ? [{ id: 'chat', label: t('builder.chat'), content: chat(true, false) }]
      : []),
    ...(sourcesOn
      ? [{ id: 'sources', label: t('builder.sources'), content: sourcesView(false) }]
      : []),
    ...(a.documentZone === 'secondary'
      ? [
          {
            id: 'document-view',
            label: t('builder.documentView'),
            content: (
              <div
                onKeyDownCapture={escapeStaysInDrawer}
                style={
                  {
                    '--genai-document-view-steps-inset': `${toolsPinHeight}px`,
                  } as CSSProperties
                }
              >
                {documentView(false)}
              </div>
            ),
          },
        ]
      : []),
  ];
  // Kilder alone keeps its own heading, as kunnskapsassistenten draws it; the switcher names the
  // tools only when there is a choice, or for a tool with no heading of its own.
  const onlySources = tools.length === 1 && tools[0]?.id === 'sources';
  const toolsView = onlySources ? (
    sourcesView(true)
  ) : tools.length > 0 ? (
    <ShellTools tools={tools} value={a.tool} onChange={a.setTool} pinIn={toolsPin} />
  ) : null;
  // `filters-right-panel`: the filter over the tools, drawn first and named first, as
  // kunnskapsassistenten's withFiltersBesideSources.
  const secondary: ShellPanel | undefined =
    tools.length > 0 || filtersBeside
      ? {
          // Named after what is in it, as one phrase: «Filter og kilder», «Fremgangsmåte, kilder og
          // dokumentvisning».
          label: phrase(t, [
            ...(filtersBeside ? [t('builder.filter')] : []),
            ...tools.map((tool) => tool.label),
          ]),
          ...(onlySources || filtersBeside ? {} : { pinnedRef: setToolsPin }),
          children: filtersBeside ? (
            <>
              <section className="uia-stacked">{filter(undefined, 2)}</section>
              {toolsView ? <section className="uia-stacked">{toolsView}</section> : null}
            </>
          ) : (
            toolsView
          ),
          // Folded until it has something to show, as kunnskapsassistenten's Kilder; open from the
          // start when Chat stands here, or there would be nothing to ask in.
          ...(chatZone === 'secondary' ? { defaultCollapsed: false } : {}),
        }
      : undefined;

  // ── The main column ──
  const experiments = a.profile?.experiments ?? [];
  let main: ReactNode;
  if (a.page === 'settings' && settingsOn) {
    main = (
      <Settings
        headingLevel={1}
        colorScheme={a.colorScheme}
        onColorSchemeChange={(scheme) => a.onColorSchemeChange?.(scheme)}
        displayLevel={a.level}
        onDisplayLevelChange={a.setLevel}
        {...(experiments.length > 0
          ? {
              experiments: experiments.map((experiment) => ({
                ...experiment,
                on: a.flags.has(experiment.id),
              })),
              onExperimentChange: a.setFlag,
            }
          : {})}
        note={a.profile?.settingsNote}
      />
    );
  } else {
    // Chat alone is the shell's child, as in kunnskapsassistenten, with no wrapper around it. With
    // Dokumentvisning beside it the wrapper stays, so opening a document moves nothing.
    const chatAlone = chatZone === 'main' && filterZone !== 'main' && a.documentZone !== 'main';
    const parts: ReactNode[] = [];
    if (approachZone === 'main' && chatZone !== 'main')
      parts.push(<div key="approach">{approachPanel}</div>);
    if (filterZone === 'main') parts.push(<div key="filter">{filterStrip}</div>);
    if (chatZone === 'main')
      parts.push(
        // Hidden, not gone, while a document stands in its place: the conversation keeps its
        // place and the field its text, and the way back finds the footnote.
        <div key="chat" className="uia-main-chat" hidden={chatHidden || undefined}>
          {chat(false, false)}
        </div>,
      );
    // Beside Chat only while a document is open; without Chat, the document has the column.
    if (a.documentZone === 'main' && (!a.documentOverChat || a.openDoc))
      parts.push(
        <div
          key="document-view"
          className="uia-main-document"
          onKeyDownCapture={escapeStaysInDrawer}
        >
          {documentView(true)}
        </div>,
      );
    if (!chatZone)
      parts.push(
        <EmptyState
          key="no-chat"
          title={t('assembly.noChatTitle')}
          description={t('assembly.noChat')}
        />,
      );
    // The main column cannot go, as a panel can: say it is empty rather than draw nothing.
    if (parts.length === 0)
      parts.push(
        <Paragraph key="empty" data-size="sm" className="uia-quiet">
          {t('assembly.emptyMain')}
        </Paragraph>,
      );
    main = chatAlone ? (
      chat(false, true)
    ) : (
      <div className="uia-main">
        {pageHeading}
        {parts}
      </div>
    );
  }

  return (
    <Shell
      primary={primary}
      secondary={secondary}
      request={a.request}
      mainId={mainId}
      initialLayout={a.shellLayout}
      onLayoutChange={a.onShellLayout}
      skipLinks={
        a.page === 'chat' && chatZone === 'main' && !chatHidden ? (
          <SkipLink
            href={`#${fieldId ?? 'composer-field'}`}
            onClick={(event) => {
              event.preventDefault();
              a.fieldRef.current?.focus();
            }}
          >
            {t('assembly.skipToField', { modifier: modifier() })}
          </SkipLink>
        ) : null
      }
    >
      {main}
    </Shell>
  );
};
