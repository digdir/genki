// The state the blocks share and the events that change it, lifted from the UI blocks preview's
// App.tsx so any layout can be drawn from it. The blocks stay as they are: data in, events out
// (ADR 0046). What happens when a partner block is off follows the app builder plan's wiring table:
// - without Tråder, one thread per visit, and a new one from the greeting;
// - without Filter, the question goes to the collection from the setup, narrowed by nothing, and
//   there is no «Endre»;
// - without the corpus choice, the collection is the service's own, with no choice shown;
// - without Kilder, no footnotes (V2-0010 pairs every footnote with an excerpt);
// - without Fremgangsmåte, no steps are asked for;
// - without Innstillinger, the defaults;
// - with one variant, no picker.
import {
  answerCitations,
  blockSpec,
  factsFromModels,
  isDisplayLevel,
  isEmptySelection,
  isOn,
  narrowing,
  needMet,
  optionInForce,
  serviceOf,
  settingsOf,
  zoneOf,
  type AssistantLayout,
  type BlockId,
  type Channel,
  type ColorScheme,
  type ConversationScope,
  type ConversationTarget,
  type ConversationTurn,
  type CorpusOption,
  type DisplayLevel,
  type DocumentItem,
  type FilterField,
  type FilterSelection,
  type ModelRow,
  type Need,
  type ShellLayout,
  type ShellRequest,
  type SourceTarget,
  type VariantOption,
} from '@genai/ui-blocks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  failureOf,
  filterSet,
  HttpError,
  sourceFromWire,
  type AnswerData,
  type AssistantApi,
  type ThreadRow,
  type Turn,
} from './api.js';
import type { StepFrame } from './procedure.js';
import type { AssistantProfile, FieldSpec } from './profile.js';
import { useStoredValue, type AssistantStorage } from './storage.js';

export interface AssistantFeedback {
  answerId: string;
  rating: 'up' | 'down';
  reasons: readonly string[];
  comment?: string | undefined;
}

export interface AssistantOptions {
  api: AssistantApi;
  layout: AssistantLayout;
  /** The genki service, `kunnskapsassistenten`. */
  service: string;
  tenant: string;
  /** The variant to start from, a model id; the service's default without it. */
  model?: string | undefined;
  profile?: AssistantProfile | undefined;
  /** The channels the client is given; all three by default. */
  channels?: readonly Channel[] | undefined;
  /**
   * The assistant owns the page: the thread in the address as `?t=` (only with Tråder), so a
   * reload opens it again; «Innstillinger» as `#innstillinger`, or at its own path with `paths`;
   * and the tab's title.
   */
  threadInUrl?: boolean | undefined;
  /**
   * With `threadInUrl`, where the pages live in the address. Without it, the assistant is a page
   * in its host's: «Innstillinger» is `#innstillinger`, and the rest of the address is kept, as
   * the app builder's `/prov?layout=…` needs. With it, each page has a path of its own and the
   * query holds only the thread, as a site that is only the assistant has it:
   * `{ home: '/', settings: '/innstillinger' }`.
   */
  paths?: { home: string; settings: string } | undefined;
  /**
   * List every thread the key can read, of any service. Without it, only the threads of the
   * service and its family, as a host for one service shows them.
   */
  allThreads?: boolean | undefined;
  /** Where the reader's choices are kept; nothing past the page without it. */
  storage?: AssistantStorage | undefined;
  /** Something the reader should hear about, such as a new thread after a new collection. */
  onNotice?: ((text: string) => void) | undefined;
  /** The reader's colour scheme, kept by the host, which «Innstillinger» changes. */
  colorScheme?: ColorScheme | undefined;
  onColorSchemeChange?: ((scheme: ColorScheme) => void) | undefined;
  /** Feedback on an answer. Without it, no feedback is offered. */
  onFeedback?: ((feedback: AssistantFeedback) => Promise<void> | void) | undefined;
  /** A thread renamed or deleted in the list. Without them, neither is offered. */
  onRename?: ((thread: ThreadRow, title: string) => Promise<void>) | undefined;
  onDelete?: ((thread: ThreadRow) => Promise<void>) | undefined;
  /** The thread on screen changed: its id, or `undefined` for a new one. */
  onThreadChange?: ((id: string | undefined) => void) | undefined;
  /** An answer asked with steps came back with them, or without any. */
  onStepsReported?: ((reported: boolean) => void) | undefined;
}

export type View = 'new' | 'loading' | 'ready' | 'notfound' | 'error';
export type Page = 'chat' | 'settings';

// kunnskapsassistenten's threadHeading.ts: the first sentence, cut on a word at 80.
export const shortTitle = (text: string) => {
  const flat = text.trim().replace(/\s+/g, ' ');
  const end = flat.search(/[.?!…]+(?=\s)/u);
  const sentence = (end < 0 ? flat : flat.slice(0, end + flat.slice(end).search(/\s/u))).replace(
    /[.?!…]+$/u,
    '',
  );
  if (sentence.length <= 80) return sentence;
  const cut = sentence.lastIndexOf(' ', 80);
  return `${sentence.slice(0, cut > 0 ? cut : 80).trimEnd()} …`;
};

/** The answer's text without its footnotes, for a layout that shows none. */
export const withoutFootnotes = (text: string) =>
  text.replace(/[ \u00a0]?\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '');

/** A stored filter, as kunnskapsassistenten reads its own: a field whose values are not all strings is dropped. */
const readSelection = (stored: unknown): FilterSelection => {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string'),
    ),
  );
};

/** The first sentence of a service's description, as the picker's line under a variant, if short. */
const firstSentence = (text: string | undefined) => {
  const sentence = text?.split(/(?<=[.!?])\s/)[0]?.trim();
  return sentence && sentence.length <= 140 ? sentence : undefined;
};

const threadInAddress = () => new URLSearchParams(location.search).get('t') ?? undefined;

export const useAssistant = ({
  api,
  layout,
  service,
  tenant,
  model: givenModel,
  profile,
  channels = ['conversations', 'facets', 'feedback'],
  threadInUrl = false,
  paths,
  allThreads = false,
  storage,
  onNotice,
  colorScheme = 'auto',
  onColorSchemeChange,
  onFeedback,
  onRename,
  onDelete,
  onThreadChange,
  onStepsReported,
}: AssistantOptions) => {
  // ── What the service can back, and what the layout holds ──
  const [models, setModels] = useState<ModelRow[]>();
  const [modelsFailed, setModelsFailed] = useState<string>();
  useEffect(() => {
    let gone = false;
    api.loadModels().then(
      (rows) => !gone && setModels(rows),
      (error: Error) => !gone && setModelsFailed(error.message),
    );
    return () => {
      gone = true;
    };
  }, [api]);
  const channelKey = channels.join(',');
  const facts = useMemo(
    () =>
      models
        ? factsFromModels(models, service, {
            channels: channelKey.split(',') as Channel[],
            family: profile?.family,
          })
        : undefined,
    [models, service, channelKey, profile],
  );
  const met = useCallback((need: Need) => (facts ? needMet(facts, need) : true), [facts]);
  /** A block the layout places, that is built, and whose needs the service meets. */
  const has = useCallback(
    (id: BlockId) =>
      isOn(layout, id) &&
      blockSpec(id).status === 'built' &&
      blockSpec(id).needs.every((n) => n.startsWith('component:') || met(n)),
    [layout, met],
  );
  const where = (id: BlockId) => (has(id) ? zoneOf(layout, id) : undefined);
  const option = (id: BlockId, name: string) => has(id) && optionInForce(layout, id, name, met);

  const threadsOn = has('threads');
  const filterOn = has('filter');
  const sourcesOn = has('sources');
  const chatOn = has('chat');
  const approachOn = has('approach');
  const settingsOn = has('settings');
  const footnotes = chatOn && option('chat', 'footnotes');
  const urlThreads = threadInUrl && threadsOn;

  const assistantName = profile?.assistantName ?? facts?.title ?? service;

  // ── Variants: the pickable rows of this service, or of its family ──
  const inFamily = useCallback(
    (other: string) => other === service || (profile?.family?.(other) ?? false),
    [service, profile],
  );
  const variants = useMemo<VariantOption[]>(
    () =>
      (models ?? [])
        .filter((row) => !row._alias_of && inFamily(serviceOf(row)) && row._pickable)
        .map((row) => {
          const description = firstSentence(row.description);
          return {
            id: row.id,
            title: row._variant_title ?? row.title ?? row.id,
            ...(description ? { description } : {}),
          };
        }),
    [models, inFamily],
  );
  const defaultModel = useMemo(() => {
    const own = (models ?? []).filter((row) => !row._alias_of && serviceOf(row) === service);
    return (
      (own.find((row) => row.id === `${service}__default`) ?? own[0])?.id ?? `${service}__default`
    );
  }, [models, service]);
  const [chosenModel, setModel] = useState<string>();
  const model = chosenModel ?? givenModel ?? defaultModel;

  // ── The collection: the service's own, or the reader's choice where the layout offers one ──
  const ownDataset = facts?.datasets[0];
  const corpusChoice = filterOn && option('filter', 'corpus');
  const [chosenCorpus, setChosenCorpus] = useStoredValue<string | undefined>(
    storage,
    'corpus',
    (stored) => (typeof stored === 'string' ? stored : undefined),
  );
  const corpusKey = (corpusChoice ? chosenCorpus : undefined) ?? ownDataset?.key;
  const [corpora, setCorpora] = useState<CorpusOption[]>([]);
  useEffect(() => {
    if (!corpusChoice) return;
    let gone = false;
    api.loadCorpora().then(
      (found) => !gone && setCorpora(found),
      (error: Error) => console.error('[assistant] corpora', error.message),
    );
    return () => {
      gone = true;
    };
  }, [api, corpusChoice]);
  const corpusLabel = (key: string) =>
    profile?.corpora?.[key]?.label ?? corpora.find((c) => c.key === key)?.label ?? key;
  const corpus: CorpusOption | undefined = corpusKey
    ? (corpora.find((c) => c.key === corpusKey) ?? {
        key: corpusKey,
        label: corpusLabel(corpusKey),
        ...(profile?.corpora?.[corpusKey]?.description
          ? { description: profile.corpora[corpusKey].description }
          : {}),
      })
    : undefined;
  const corpusProfile = corpusKey ? profile?.corpora?.[corpusKey] : undefined;

  // ── Threads ──
  const [loadedThreads, setThreads] = useState<ThreadRow[]>();
  const [threadsFailed, setThreadsFailed] = useState(false);
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const reloadThreads = useCallback(() => {
    if (!threadsOn) return;
    setThreadsFailed(false);
    api.loadThreads().then(setThreads, (error: Error) => {
      console.error('[assistant] threads', error.message);
      setThreadsFailed(true);
    });
  }, [api, threadsOn]);
  useEffect(reloadThreads, [reloadThreads]);
  const threads = useMemo(
    () =>
      loadedThreads
        ?.filter(
          (thread) =>
            !deleted.has(thread.id) && (allThreads || !thread.service || inFamily(thread.service)),
        )
        .map((thread) =>
          renamed[thread.id] ? { ...thread, title: renamed[thread.id] ?? thread.title } : thread,
        ),
    [loadedThreads, renamed, deleted, inFamily, allThreads],
  );

  // ── The address: `#innstillinger` in the host's page, or a path per page with `paths` ──
  const home = paths?.home;
  const settingsPath = paths?.settings;
  const settingsHref = settingsPath ?? '#innstillinger';
  const onSettingsAddress = () =>
    settingsPath !== undefined
      ? location.pathname === settingsPath
      : location.hash === '#innstillinger';
  /** The address of the conversation on this thread, or on a new one, as a link's `href`. */
  const hrefOf = useCallback(
    (thread?: string) => {
      if (home !== undefined) return thread ? `${home}?t=${encodeURIComponent(thread)}` : home;
      const url = new URL(location.href);
      url.hash = '';
      if (thread) url.searchParams.set('t', thread);
      else url.searchParams.delete('t');
      return `${url.pathname}${url.search}`;
    },
    [home],
  );

  // ── The thread on screen ──
  const [page, setPage] = useState<Page>(() =>
    threadInUrl && onSettingsAddress() ? 'settings' : 'chat',
  );
  const [currentId, setCurrentId] = useState<string | undefined>(() =>
    urlThreads ? threadInAddress() : undefined,
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadCorpus, setThreadCorpus] = useState<string>();
  const [view, setView] = useState<View>(currentId ? 'loading' : 'new');
  const [viewError, setViewError] = useState<string>();
  const [reload, setReload] = useState(0);
  const ownThread = useRef<string>(undefined);
  const abort = useRef<AbortController>(undefined);
  const [working, setWorking] = useState(false);
  const [request, setRequest] = useState<ShellRequest>();

  const go = useCallback(
    (id: string | undefined, replace = false) => {
      if (urlThreads) history[replace ? 'replaceState' : 'pushState'](null, '', hrefOf(id));
      else if (threadInUrl && home !== undefined) {
        if (location.pathname !== home) history.pushState(null, '', home);
      } else if (threadInUrl && location.hash) {
        const url = new URL(location.href);
        url.hash = '';
        history.pushState(null, '', url);
      }
      setPage('chat');
      setCurrentId(id);
    },
    [urlThreads, threadInUrl, hrefOf, home],
  );
  /** Opening a thread or «Ny tråd» shuts an open drawer, which would cover it. */
  const leave = useCallback(
    (id: string | undefined) => {
      abort.current?.abort();
      setRequest({ action: 'close-drawers' });
      go(id);
    },
    [go],
  );
  useEffect(() => {
    if (!threadInUrl) return;
    const onPop = () => {
      abort.current?.abort();
      setPage(onSettingsAddress() ? 'settings' : 'chat');
      if (urlThreads) setCurrentId(threadInAddress());
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
    // `onSettingsAddress` reads only `settingsPath`.
  }, [threadInUrl, urlThreads, settingsPath]);
  const reported = useRef(onThreadChange);
  useEffect(() => {
    reported.current = onThreadChange;
  });
  useEffect(() => reported.current?.(currentId), [currentId]);

  const [activeId, setActiveId] = useState<string>();
  const [sourceTarget, setSourceTarget] = useState<SourceTarget>();
  const [answerTarget, setAnswerTarget] = useState<ConversationTarget>();
  const lastFollowed = useRef<ConversationTarget>(undefined);
  const [tool, setTool] = useState<string>();

  useEffect(() => {
    setSourceTarget(undefined);
    setAnswerTarget(undefined);
    setActiveId(undefined);
    setThreadCorpus(undefined);
    if (!currentId) {
      setTurns([]);
      setView('new');
      return;
    }
    // The thread a question just made: its turns are on screen already, streaming.
    if (ownThread.current === currentId) {
      ownThread.current = undefined;
      return;
    }
    let gone = false;
    setTurns([]);
    setView('loading');
    api.loadThread(currentId).then(
      (thread) => {
        if (gone) return;
        setTurns(thread.turns);
        setThreadCorpus(thread.corpus);
        setView('ready');
        if (sourcesOn && thread.turns.some((t) => (t.answer?.sources?.length ?? 0) > 0))
          setRequest({ action: 'offer', side: 'secondary' });
      },
      (error: Error) => {
        if (gone) return;
        if (error instanceof HttpError && error.status === 404) setView('notfound');
        else {
          setViewError(error.message);
          setView('error');
        }
      },
    );
    return () => {
      gone = true;
    };
    // `sourcesOn` only decides whether to offer the panel once the thread is read.
  }, [api, currentId, reload]);

  // ── Filter fields and facets, only with Filter placed ──
  const [fields, setFields] = useState<readonly FieldSpec[]>();
  useEffect(() => {
    if (!filterOn || !corpusKey) return;
    let gone = false;
    setFields(undefined);
    api.loadFields(corpusKey).then(
      (found) => !gone && setFields(found),
      (error: Error) => {
        console.error('[assistant] fields', error.message);
        if (!gone) setFields(corpusProfile?.fields ?? []);
      },
    );
    return () => {
      gone = true;
    };
  }, [api, filterOn, corpusKey]);

  // The filter is kept as kunnskapsassistenten keeps it: a field whose values are not all strings
  // is dropped.
  const [chosenSelection, setSelection] = useStoredValue<FilterSelection>(
    storage,
    'filter',
    readSelection,
  );
  // Without Filter, nothing narrows the question: the setup's collection as a whole.
  const selection = filterOn ? chosenSelection : {};
  const [facets, setFacets] = useState<FilterField[]>();
  const [baseFacets, setBaseFacets] = useState<FilterField[]>();
  const [facetsFailed, setFacetsFailed] = useState(false);
  const [facetsKey, setFacetsKey] = useState(0);
  useEffect(() => {
    if (!filterOn || !fields || !corpusKey) return;
    let gone = false;
    setFacetsFailed(false);
    api.loadFacets(selection, corpusKey, fields).then(
      (found) => {
        if (gone) return;
        setFacets(found);
        if (isEmptySelection(selection)) setBaseFacets(found);
      },
      (error: Error) => {
        if (gone) return;
        console.error('[assistant] facets', error.message);
        setFacetsFailed(true);
      },
    );
    return () => {
      gone = true;
    };
    // `selection` is new on every render without Filter; with it, it is the state.
  }, [api, filterOn, chosenSelection, facetsKey, corpusKey, fields]);
  useEffect(() => {
    if (!filterOn || baseFacets || isEmptySelection(chosenSelection) || !fields || !corpusKey)
      return;
    api.loadFacets({}, corpusKey, fields).then(setBaseFacets, () => {});
  }, [api, filterOn, baseFacets, chosenSelection, corpusKey, fields]);

  const chooseCorpus = (key: string) => {
    // A new collection starts a new thread with an empty filter (kunnskapsassistenten's useCorpus).
    setChosenCorpus(key);
    setSelection({});
    setBaseFacets(undefined);
    leave(undefined);
    onNotice?.(`Byttet til ${corpusLabel(key)}. Du har fått en ny tråd, og filteret er tømt.`);
  };

  // ── The answer shown in Sources and Fremgangsmåte ──
  const active = useMemo(
    () =>
      turns.find((t) => t.id === activeId && t.answer) ??
      [...turns].reverse().find((t) => t.answer && (t.answer.sources?.length ?? 0) > 0) ??
      [...turns].reverse().find((t) => t.answer),
    [turns, activeId],
  );
  const activeAnswer = active?.answer;
  const citations = useMemo(
    () =>
      activeAnswer && footnotes
        ? answerCitations(activeAnswer.text, activeAnswer.sources, activeAnswer.markers)
        : undefined,
    [activeAnswer, footnotes],
  );
  const answered = turns.filter((t) => t.answer);
  const shownIndex = Math.max(
    0,
    answered.findIndex((t) => t.id === active?.id),
  );

  // The line under each title in «Dokumenter», where the profile says how to find it.
  const documentsOn = filterOn && option('filter', 'documents');
  const [about, setAbout] = useState<Record<string, readonly string[]>>({});
  const sourceKey =
    documentsOn && corpusKey
      ? (activeAnswer?.sources ?? [])
          .map((s) => s.documentId)
          .filter(Boolean)
          .join(',')
      : '';
  useEffect(() => {
    if (!sourceKey || !corpusKey) return;
    let gone = false;
    for (const id of sourceKey.split(','))
      void api.loadAbout(corpusKey, id).then((line) => {
        if (!gone && line) setAbout((all) => (all[id] ? all : { ...all, [id]: line }));
      });
    return () => {
      gone = true;
    };
  }, [api, sourceKey, corpusKey]);
  const documents: DocumentItem[] | undefined = activeAnswer?.sources?.map((s, i) => {
    const line = s.documentId ? about[s.documentId] : undefined;
    return {
      id: s.documentId ?? `${i}-${s.title}`,
      title: s.title,
      ...(s.url ? { url: s.url } : {}),
      ...(line ? { about: line } : {}),
    };
  });

  // ── Asking ──
  const [draft, setDraft] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [focusField, setFocusField] = useState(0);
  useEffect(() => {
    if (focusField > 0) fieldRef.current?.focus();
  }, [focusField]);
  const stepsReported = useRef(onStepsReported);
  useEffect(() => {
    stepsReported.current = onStepsReported;
  });

  // `replaces`: «Generer på nytt» or «Prøv igjen» asks the turn again in its place.
  const send = async (question: string, replaces?: string) => {
    if (working || !corpusKey) return;
    const controller = new AbortController();
    abort.current = controller;
    const startedIn = currentId;
    const id = `local-${Date.now()}`;
    setSourceTarget(undefined);
    const narrowedTo = (facets ?? []).flatMap((field) => [...(selection[field.id] ?? [])]);
    const change = (update: (turn: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.id === id ? update(t) : t)));
    const update = (patch: (answer: AnswerData) => AnswerData) =>
      change((t) => (t.answer ? { ...t, answer: patch(t.answer) } : t));
    const finish = () =>
      change((t) =>
        t.approach ? { ...t, approach: { ...t.approach, finishedAt: Date.now() } } : t,
      );
    let frames = 0;
    setWorking(true);
    setDraft('');
    setView('ready');
    setActiveId(id);
    const asked: Turn = {
      id,
      question,
      askedAt: Date.now(),
      answer: { text: '', status: 'streaming', created: Date.now() },
      ...(approachOn ? { approach: { frames: [], startedAt: Date.now() } } : {}),
      scope: { narrowedTo, corpus: corpusKey },
    };
    setTurns((all) =>
      replaces && all.some((t) => t.id === replaces)
        ? all.map((t) => (t.id === replaces ? asked : t))
        : [...all, asked],
    );
    const fromWire = (raw: Parameters<typeof sourceFromWire>[0]) =>
      sourceFromWire(raw, corpusProfile);
    try {
      for await (const event of api.ask({
        question,
        model,
        conversationId: startedIn,
        filters: filterOn ? filterSet(narrowing(selection, facets), fields ?? []) : undefined,
        dataset: { tenant: ownDataset?.tenant || tenant, key: corpusKey },
        steps: approachOn,
        signal: controller.signal,
      })) {
        if (event.type === 'conversation' && !startedIn) {
          ownThread.current = event.conversationId;
          go(event.conversationId, true);
          reloadThreads();
        } else if (event.type === 'step') {
          frames += 1;
          const frame = event.step as StepFrame;
          change((t) =>
            t.approach
              ? { ...t, approach: { ...t.approach, frames: [...t.approach.frames, frame] } }
              : t,
          );
        } else if (event.type === 'text') update((a) => ({ ...a, text: a.text + event.text }));
        else if (event.type === 'retract') update((a) => ({ ...a, text: '' }));
        else if (event.type === 'sources') {
          update((a) => ({ ...a, sources: event.sources.map(fromWire) }));
          if (sourcesOn && event.sources.length > 0)
            setRequest({ action: 'offer', side: 'secondary' });
        } else if (event.type === 'done') {
          finish();
          update((a) => ({
            ...a,
            text: event.answer.text || a.text,
            sources: event.answer.sources.map(fromWire),
            noAnswer: event.answer.noAnswer,
            status: 'complete',
            created: Date.now(),
          }));
          if (sourcesOn && event.answer.sources.length > 0)
            setRequest({ action: 'offer', side: 'secondary' });
          if (approachOn) stepsReported.current?.(frames > 0);
          reloadThreads();
        }
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (!aborted) console.error('[assistant] ask', (error as Error).message);
      finish();
      update((a) => ({
        ...a,
        status: aborted ? 'aborted' : 'failed',
        error: (error as Error).message,
        ...(aborted ? {} : { failure: failureOf(error) }),
      }));
      if (!aborted) reloadThreads();
    } finally {
      setWorking(false);
      if (abort.current === controller) abort.current = undefined;
    }
  };

  // ── The conversation as the blocks take it ──
  const conversation = useMemo<ConversationTurn[]>(
    () =>
      turns.flatMap((turn): ConversationTurn[] => {
        const scopeOf = (): { scope?: ConversationScope } => {
          const asked = turn.scope?.corpus ?? threadCorpus;
          const other = asked && asked !== corpusKey ? corpusLabel(asked) : undefined;
          const narrowedTo = turn.scope?.narrowedTo ?? [];
          if (!other && narrowedTo.length === 0) return {};
          return { scope: { narrowedTo, ...(other ? { corpus: other } : {}) } };
        };
        const answer = turn.answer;
        return [
          ...(turn.question
            ? [{ kind: 'question' as const, id: `${turn.id}-q`, text: turn.question }]
            : []),
          ...(answer
            ? [
                {
                  kind: 'answer' as const,
                  id: turn.id,
                  // Without footnotes, no `[N]` and no sources: a footnote never points nowhere.
                  text: footnotes ? answer.text : withoutFootnotes(answer.text),
                  status: answer.status,
                  ...(footnotes ? { sources: answer.sources, markers: answer.markers } : {}),
                  noAnswer: answer.noAnswer,
                  failure: answer.failure,
                  ...scopeOf(),
                  ...(answer.status === 'complete' ? { createdAt: answer.created } : {}),
                },
              ]
            : []),
        ];
      }),
    // `corpusLabel` reads `corpora` and the profile.
    [turns, corpusKey, corpora, threadCorpus, footnotes],
  );

  const firstQuestion = turns.find((t) => t.question)?.question ?? '';
  const named = ((currentId && threads?.find((t) => t.id === currentId)?.title) || '').trim();
  const repeatsQuestion = !named || named === firstQuestion.trim().replace(/\s+/g, ' ');
  // Each thread gives the tab its own title (WCAG 2.4.2), as kunnskapsassistenten's PageTitle.
  const heading =
    view === 'notfound' ? 'Fant ikke tråden' : named || shortTitle(firstQuestion) || 'Ny tråd';
  useEffect(() => {
    if (!threadInUrl) return;
    const name =
      page === 'settings' ? 'Innstillinger' : repeatsQuestion ? shortTitle(heading) : heading;
    document.title = `${name} – ${assistantName}`;
  }, [threadInUrl, page, heading, repeatsQuestion, assistantName]);

  // Each row names its collection only when the list mixes several, by the collection's name.
  const threadRows = useMemo(() => {
    const own = ownDataset?.key ?? '';
    const mixed = new Set((threads ?? []).map((t) => t.dataset ?? own)).size > 1;
    return threads?.map(({ dataset, service: _service, ...thread }) =>
      mixed ? { ...thread, dataset: corpusLabel(dataset ?? own) } : thread,
    );
    // `corpusLabel` reads the profile and `corpora`.
  }, [threads, ownDataset, corpora]);

  // The panels as the reader left them.
  const [shellLayout] = useState(() => storage?.read('layout') as ShellLayout | undefined);

  /** A footnote or a document asks for Kilder: the panel opens, on the Kilder tool. */
  const showSources = (turnId: string, target: SourceTarget) => {
    setActiveId(turnId);
    setSourceTarget({ ...target });
    setTool('sources');
    setRequest({ action: 'open', side: 'secondary' });
  };

  // ── Settings ──
  const defaultLevel = (
    approachOn ? settingsOf(layout, 'approach').level : 'standard'
  ) as DisplayLevel;
  const [chosenLevel, setLevel] = useStoredValue<DisplayLevel | undefined>(
    storage,
    'displayLevel',
    (stored) => (isDisplayLevel(stored) ? stored : undefined),
  );
  // The trials the reader turned on, of those the profile offers.
  const [flagList, setFlagList] = useStoredValue<readonly string[]>(storage, 'flags', (stored) =>
    Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [],
  );
  const offered = new Set((profile?.experiments ?? []).map((e) => e.id));
  const flags: ReadonlySet<string> = new Set(
    settingsOn ? flagList.filter((id) => offered.has(id)) : [],
  );
  const setFlag = (id: string, on: boolean) =>
    setFlagList(on ? [...new Set([...flagList, id])] : flagList.filter((f) => f !== id));
  // Without Innstillinger, the setup's level stands.
  const level = (settingsOn ? chosenLevel : undefined) ?? defaultLevel;

  return {
    // what is placed
    layout,
    facts,
    modelsFailed,
    has,
    where,
    option,
    footnotes,
    assistantName,
    profile,
    // variants
    variants,
    model,
    setModel,
    // collection and filter
    corpus,
    corpora,
    corpusKey,
    corpusChoice,
    chooseCorpus,
    fields,
    selection,
    setSelection,
    facets,
    baseFacets,
    facetsFailed,
    retryFacets: () => setFacetsKey((n) => n + 1),
    documents,
    // threads
    threads,
    threadRows,
    // «Logg ut» forgets what this browser kept of the reader's choices, as kunnskapsassistenten's
    // beforeLogout: the next person on a shared machine starts without them.
    signOut: () => {
      storage?.remove('filter');
      storage?.remove('flags');
      storage?.remove('corpus');
    },
    threadsFailed,
    reloadThreads,
    renameThread: onRename
      ? async (thread: ThreadRow, title: string) => {
          await onRename(thread, title);
          setRenamed((all) => ({ ...all, [thread.id]: title }));
        }
      : undefined,
    deleteThread: onDelete
      ? async (thread: ThreadRow) => {
          await onDelete(thread);
          setDeleted((all) => new Set(all).add(thread.id));
          if (thread.id === currentId) leave(undefined);
        }
      : undefined,
    currentId,
    named,
    repeatsQuestion,
    leave,
    newThread: () => {
      setSelection({});
      leave(undefined);
      setFocusField((n) => n + 1);
    },
    page,
    showSettings: () => {
      if (threadInUrl && !onSettingsAddress()) {
        if (settingsPath !== undefined) history.pushState(null, '', settingsPath);
        else {
          const url = new URL(location.href);
          url.hash = 'innstillinger';
          history.pushState(null, '', url);
        }
      }
      setPage('settings');
      setRequest({ action: 'close-drawers' });
    },
    settingsHref,
    hrefOf,
    // the thread on screen
    view,
    viewError,
    retryThread: () => setReload((n) => n + 1),
    turns,
    conversation,
    working,
    cancel: () => abort.current?.abort(),
    send,
    draft,
    setDraft,
    fieldRef,
    // sources and approach
    active,
    activeAnswer,
    citations,
    answered,
    shownIndex,
    sourceTarget,
    answerTarget,
    lastFollowed,
    showSources,
    showAnswer: (index: number) => {
      const turn = answered[index];
      if (!turn) return;
      setActiveId(turn.id);
      setSourceTarget(undefined);
    },
    goToUse: (citation: number) => {
      if (!active) return;
      setAnswerTarget({ turnId: active.id, citation });
      setRequest({ action: 'close-drawers' });
    },
    returnToAnswer: () => {
      if (lastFollowed.current) setAnswerTarget({ ...lastFollowed.current });
      setRequest({ action: 'close-drawers' });
    },
    // the shell
    request,
    shellLayout,
    onShellLayout: (next: ShellLayout) => storage?.write('layout', next),
    tool,
    setTool,
    // settings
    level,
    setLevel,
    flags,
    setFlag,
    threadInUrl,
    colorScheme,
    onColorSchemeChange,
    onFeedback,
  };
};

export type AssistantState = ReturnType<typeof useAssistant>;
