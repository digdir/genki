// Draws an assistant from a layout: each catalogue block's members in its zone of the shell,
// linked through the channels `useAssistant` keeps. The arrangement inside each zone follows
// kunnskapsassistenten, as the UI blocks preview draws it; what the preview never drew follows
// the design's board 3: Filter in the main column as a strip with «Endre», Chat or Fremgangsmåte
// in the secondary panel, and the secondary panel's tool rule.
import { Button, Details, Paragraph, SkipLink } from '@digdir/designsystemet-react';
import {
  AnswerActions,
  Composer,
  ComposerDisclaimer,
  Conversation,
  CorpusChoice,
  CorpusLine,
  Documents,
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
  isEmptySelection,
  uiBlocksNb,
  type AnswerCopied,
  type AnswerFeedbackStatus,
  type ConversationAnswer,
  type ShellPanel,
  type ShellTool,
  type SourceDocument,
} from '@genai/ui-blocks';
import { ArrowLeftIcon } from '@navikt/aksel-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { stepsOf } from './procedure.js';
import { useAssistant, type AssistantOptions, type AssistantState } from './useAssistant.js';

const names = uiBlocksNb.builder;

// The modifier to name; the shortcut takes both (kunnskapsassistenten's shortcutModifier.ts).
const modifier = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? 'Cmd' : 'Ctrl';

/** This page's address with the thread given, or none, and the rest kept: the layout, the service. */
const hereHref = (thread?: string) => {
  const url = new URL(location.href);
  url.hash = '';
  if (thread) url.searchParams.set('t', thread);
  else url.searchParams.delete('t');
  return `${url.pathname}${url.search}`;
};

export interface AssistantProps extends AssistantOptions {
  /** The `id` of `<main>`, the target of «Hopp til hovedinnhold». */
  mainId?: string | undefined;
}

/** The assistant a layout describes, live against the service through `api`. */
export const Assistant = ({ mainId, ...options }: AssistantProps) => (
  <AssistantView assistant={useAssistant(options)} mainId={mainId} />
);

/** The answer with the sources its footnotes cite, as kunnskapsassistenten's «Kopier svaret». */
const copyText = (text: string, sources: readonly SourceDocument[] | undefined) => {
  const cited = (sources ?? []).filter(
    (s) => s.index !== undefined && text.includes(`[${s.index}]`),
  );
  if (cited.length === 0) return { text, count: 0 };
  const list = cited.map((s) => `[${s.index}] ${s.title}${s.url ? `. ${s.url}` : ''}`);
  return { text: `${text}\n\nKilder\n${list.join('\n')}`, count: cited.length };
};

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
            onCopyAnswer: () => {
              const { text, count } = copyText(turn.text, turn.sources);
              void copy(text, { kind: 'answer', sources: count });
            },
            ...(a.has('threads')
              ? { onCopyLink: () => void copy(location.href, { kind: 'link' }), linkOnlyHere: true }
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
const approachOf = (a: AssistantState, turnId: string | undefined) => {
  const turn = a.turns.find((t) => t.id === turnId);
  const approach = turn?.approach;
  if (!turn || !approach) return null;
  const busy = turn.answer?.status === 'streaming';
  const steps = stepsOf(approach, busy);
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
          <Details.Summary>Tekniske detaljer</Details.Summary>
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
  const chatZone = a.where('chat');
  const approachZone = a.where('approach');
  const filterZone = a.where('filter');
  const threadsOn = a.has('threads');
  const sourcesOn = a.has('sources');
  const settingsOn = a.has('settings');
  const name = a.assistantName;

  // The primary panel holds Tråder and Filter as two views, as kunnskapsassistenten does, and a
  // first visit lands on the filter.
  const [primaryView, setPrimaryView] = useState<'threads' | 'filters'>('filters');
  const [switchedView, setSwitchedView] = useState(false);
  const [filterPin, setFilterPin] = useState<HTMLDivElement | null>(null);
  // The secondary panel's pinned region, where its tools' switcher stays while a tool scrolls.
  const [toolsPin, setToolsPin] = useState<HTMLDivElement | null>(null);
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

  // The skip link goes to the field's id, so it has a target (axe `region`).
  const [fieldId, setFieldId] = useState<string>();
  useEffect(() => {
    const field = a.fieldRef.current;
    if (field && !field.id) field.id = 'composer-field';
    setFieldId(field?.id || undefined);
  });
  // No focus hides under the docked field: scroll padding as tall as the dock (WCAG 2.4.11).
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const main = document.getElementById(mainId);
    const dock = dockRef.current;
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
  });
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

  // ── Chat ──
  const chat = (inPanel: boolean) => {
    let middle;
    if (a.view === 'notfound') {
      middle = (
        <NotFoundState
          homeHref={hereHref()}
          onGoHome={() => a.leave(undefined)}
          title="Fant ikke tråden"
          description="Den kan være slettet, eller lenken kan være feil."
        />
      );
    } else if (a.view === 'error') {
      middle = (
        <ErrorState title="Kunne ikke hente tråden" message={a.viewError} onRetry={a.retryThread} />
      );
    } else if (start) {
      middle = (
        <div className="uia-greeting">
          <Welcome />
          {a.view === 'ready' ? (
            <EmptyState
              title="Tråden har ingen meldinger ennå"
              description="Still et spørsmål for å starte samtalen."
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
              ? approachOf(a, turn.id)
              : null
          }
          {...(a.footnotes
            ? {
                onOpenCitation: (
                  turn: ConversationAnswer,
                  citation: number,
                  target: Parameters<AssistantState['showSources']>[1],
                ) => {
                  a.lastFollowed.current = { turnId: turn.id, citation };
                  a.showSources(turn.id, target);
                },
                onOpenDocument: (turn: ConversationAnswer, source: SourceDocument) => {
                  const target = { documentId: source.documentId, index: source.index };
                  a.lastFollowed.current = { turnId: turn.id, document: target };
                  a.showSources(turn.id, target);
                },
                sourcesUsed: true,
              }
            : {})}
          onRegenerate={(turn, question) => {
            const own = a.turns.find((t) => t.id === turn.id || `${t.id}-q` === question?.id);
            const asked = question?.text ?? own?.question;
            if (asked) void a.send(asked, own?.id ?? turn.id);
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
        {inPanel ? null : <h1 className="ds-sr-only">{name}</h1>}
        {middle}
        {a.view === 'notfound' ? null : (
          <Composer
            className="uia-composer"
            value={a.draft}
            onChange={a.setDraft}
            onSubmit={(question) => void a.send(question)}
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
                <VariantPicker variants={a.variants} chosen={a.model} onChoose={a.setModel} />
              ) : undefined
            }
            sticky={!start && !inPanel}
            fieldRef={a.fieldRef}
            {...(inPanel ? {} : { ref: dockRef })}
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
  const filter = (pinIn: HTMLDivElement | null | undefined, headingLevel: 2 | 3) => (
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
      newThreadHref={hereHref()}
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
          corpusLine={corpusLine}
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
    <section className="uia-filter-strip" aria-label="Filter">
      <div className="uia-filter-strip-row">
        <div className="uia-filter-strip-text">
          {corpusLine}
          {narrowedTo.length > 0 ? (
            <Paragraph data-size="sm" className="uia-filter-strip-narrowed">
              Avgrenset til: {narrowedTo.join(' · ')}
            </Paragraph>
          ) : null}
        </div>
        <Button
          variant="secondary"
          data-size="sm"
          aria-expanded={stripOpen}
          onClick={() => setStripOpen((open) => !open)}
        >
          {stripOpen ? 'Lukk' : 'Endre'}
        </Button>
      </div>
      {stripOpen ? <div className="uia-filter-strip-body">{filter(undefined, 2)}</div> : null}
    </section>
  );

  // ── Threads ──
  const threadList = (
    <Threads
      threads={a.threadRows}
      failed={a.threadsFailed}
      onRetry={a.reloadThreads}
      currentId={a.page === 'chat' ? a.currentId : undefined}
      threadHref={(thread) => hereHref(thread.id)}
      onOpenThread={(thread) => a.leave(thread.id)}
      newThreadHref={hereHref()}
      onNewThread={() => {
        if (twoViews) {
          setPrimaryView('filters');
          setSwitchedView(false);
        }
        a.newThread();
      }}
      {...(a.renameThread ? { onRename: a.renameThread } : {})}
      {...(a.deleteThread ? { onDelete: a.deleteThread } : {})}
      footer={
        a.profile?.signedInAs ? (
          <SignedIn name={a.profile.signedInAs} signOutHref={hereHref()} onSignOut={a.signOut} />
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
      settingsHref="#innstillinger"
      currentHref={a.page === 'settings' ? '#innstillinger' : undefined}
      assistantName={name}
      onNavigate={() => a.showSettings()}
    />
  ) : undefined;

  let primary: ShellPanel | undefined;
  if (twoViews) {
    primary =
      primaryView === 'threads'
        ? { label: 'Tråder og filter', children: threadList, foot }
        : {
            label: 'Tråder og filter',
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
                Tråder
              </Button>
            ),
            pinnedRef: setFilterPin,
            children: filter(filterPin, 2),
            foot,
          };
  } else if (threadsOn) {
    primary = { label: 'Tråder', children: threadList, foot };
  } else if (filterZone === 'primary' && !filtersBeside) {
    primary = { label: 'Filter', pinnedRef: setFilterPin, children: filter(filterPin, 2), foot };
  } else if (foot) {
    primary = { label: names.settings, foot, footPinned: true };
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
    />
  );
  const approachPanel = approachOf(a, a.active?.id) ?? (
    <Paragraph data-size="sm" className="uia-quiet">
      {a.working
        ? 'Venter på det første steget …'
        : 'Fremgangsmåten vises her når du stiller et spørsmål.'}
    </Paragraph>
  );
  const tools: ShellTool[] = [
    ...(approachZone === 'secondary'
      ? [{ id: 'approach', label: names.approach, content: approachPanel }]
      : []),
    ...(chatZone === 'secondary' ? [{ id: 'chat', label: names.chat, content: chat(true) }] : []),
    ...(sourcesOn ? [{ id: 'sources', label: names.sources, content: sourcesView(false) }] : []),
  ];
  // Kilder alone keeps its own heading, as kunnskapsassistenten draws it; the switcher names the
  // tools only when there is a choice, or for a tool with no heading of its own.
  const onlySources = tools.length === 1 && tools[0]?.id === 'sources';
  const toolsView = onlySources ? (
    sourcesView(true)
  ) : tools.length > 0 ? (
    <ShellTools tools={tools} active={a.tool} onChange={a.setTool} pinIn={toolsPin} />
  ) : null;
  // `filters-right-panel`: the filter over the tools, drawn first and named first, as
  // kunnskapsassistenten's withFiltersBesideSources.
  const secondary: ShellPanel | undefined =
    tools.length > 0 || filtersBeside
      ? {
          label: [...(filtersBeside ? ['Filter'] : []), ...tools.map((t) => t.label)].join(' og '),
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
    const parts: ReactNode[] = [];
    if (approachZone === 'main' && chatZone !== 'main')
      parts.push(<div key="approach">{approachPanel}</div>);
    if (filterZone === 'main') parts.push(<div key="filter">{filterStrip}</div>);
    if (chatZone === 'main')
      parts.push(
        <div key="chat" className="uia-main-chat">
          {chat(false)}
        </div>,
      );
    if (!chatZone)
      parts.push(
        <EmptyState
          key="no-chat"
          title="Legg Chat i innholdet for å prøve assistenten."
          description="Uten Chat er det ingen samtale å prøve."
        />,
      );
    // The main column cannot go, as a panel can: say it is empty rather than draw nothing.
    if (parts.length === 0)
      parts.push(
        <Paragraph key="empty" data-size="sm" className="uia-quiet">
          Ingen klosser i innholdet.
        </Paragraph>,
      );
    // Chat alone is the shell's child, as in kunnskapsassistenten, with no wrapper around it.
    main =
      chatZone === 'main' && parts.length === 1 ? (
        chat(false)
      ) : (
        <div className="uia-main">{parts}</div>
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
        a.page === 'chat' && chatZone === 'main' ? (
          <SkipLink
            href={`#${fieldId ?? 'composer-field'}`}
            onClick={(event) => {
              event.preventDefault();
              a.fieldRef.current?.focus();
            }}
          >
            Hopp til skrivefeltet ({modifier()} + /)
          </SkipLink>
        ) : null
      }
    >
      {main}
    </Shell>
  );
};
