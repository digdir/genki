import {
  Alert,
  Button,
  Chip,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Spinner,
  Textarea,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { AnswerLanguage } from '../../data/service-languages';
import { AnswerLanguagePicker } from './AnswerLanguagePicker';
import { ApiError, type ApiClient } from '../../api';
import type {
  PlaygroundHistoryTurn,
  PlaygroundInput,
  PlaygroundInputField,
  PlaygroundOptions,
  PlaygroundQuota,
  PlaygroundRefusal,
  PlaygroundResult,
  PlaygroundRunRequest,
  PlaygroundSetup,
  PlaygroundStreamEvent,
  PlaygroundStreamProblem,
} from '../../api/playground';
import type { Problem } from '../../types';
import {
  decisionQuestion,
  evaluationQuestion,
  exampleResult,
  fieldEntries,
  addCost,
  formatKr,
  initialSetup,
  inputFieldsOf,
  withOptionsFrom,
  modelOf,
  questionOf,
  quotaTokensText,
  resultLabel,
  sampleFileName,
  setupChips,
  shortModelName,
  suggestionsFor,
  withNamedOptions,
} from '../../data/playground';
import { useEscape, useNarrow } from '../../hooks';
import { useT, type T } from '../../i18n';
import { ApiCallPanel } from '../ApiCall';
import { Icon, icons } from '../Icon';
import { isModelFailure, ModelNoAnswer, RunFailure, type RunFailureInfo } from '../RunFailure';
import { AnswerCard } from './AnswerCard';
import { formErrors, formInput, InputForm, type FormValues } from './InputForm';
import { loadSetups, rememberKey, saveSetups } from './remember';
import {
  applyEvent,
  LiveText,
  RunHeader,
  runFromResult,
  startRun,
  TimelinePanel,
  WhatHappened,
  type LiveRun,
} from './RunView';
import { apiBackend, exampleBackend } from './backend';
import { SaveAsTestCase, testSetLabel, type TestCaseDraft } from './SaveAsTestCase';
import { SetupBar } from './SetupBar';
import { SetupForm } from './SetupForm';
import './playground.css';

export type PlaygroundLayout = 'side' | 'full';
export type PlaygroundContext = 'free' | 'service' | 'skill' | 'dataset';
export type PlaygroundState = 'empty' | 'answer' | 'compare' | 'quota' | 'not-allowed' | 'error';

export interface PlaygroundPanelProps {
  layout: PlaygroundLayout;
  context?: PlaygroundContext;
  name?: string;
  title?: string;
  state?: PlaygroundState;
  onClose?: () => void;
  api?: ApiClient;
  tenant?: string;
  tenantName?: string;
  serviceDraft?: ServiceDraft;
  timelinePanel?: boolean;
  bare?: boolean;
  note?: ReactNode;
}

export interface ServiceDraft {
  definition: Record<string, unknown>;
  files?: Record<string, string>;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const withDraftService = (
  options: PlaygroundOptions,
  id: string,
  draft: ServiceDraft,
): PlaygroundOptions => {
  if (!Array.isArray(options.services) || options.services.some((s) => s.id === id)) return options;
  const meta = record(draft.definition.metadata);
  const spec = record(draft.definition.spec);
  const primary = record(spec.model).primary;
  const model =
    options.models.find((m) => m.id === primary)?.id ??
    options.models.find((m) => m.status === 'allowed')?.id ??
    '';
  const service = {
    id,
    name: typeof meta.name === 'string' && meta.name ? meta.name : id,
    latestVersion: 0,
    versions: [
      {
        version: 0,
        draft: true,
        inUse: false,
        setup: {
          model,
          datasets: [],
          skills: [],
          blocks: options.defaultBlocks ?? [],
          output: record(spec.output).kind === 'fields' ? ('fields' as const) : ('text' as const),
        },
      },
    ],
  };
  return { ...options, services: [...options.services, service] };
};

type SetupKey = 'a' | 'b';

interface Message {
  id: string;
  input: PlaygroundInput;
  setups: { a: PlaygroundSetup; b?: PlaygroundSetup };
  live?: { a: LiveRun; b?: LiveRun };
  result?: PlaygroundResult;
  compareResult?: PlaygroundResult;
  error?: string;
  failure?: RunFailureInfo;
  modelDown?: boolean;
  saved?: { name: string; href: string };
}

interface ChosenFile {
  name: string;
  file?: File;
}

const slowModelText = (model: string, t: T, within = false) =>
  t(within ? 'playground.modelSilentWithin' : 'playground.modelSilent', {
    model,
    notStored: t('playground.notStored'),
  });

const failedInService = (error: unknown): RunFailureInfo | undefined => {
  const failed =
    error instanceof ApiError && error.status === 502
      ? (error.problem as Partial<RunFailureInfo> | undefined)
      : undefined;
  return failed?.code && !isModelFailure({ code: failed.code })
    ? { ...failed, code: failed.code }
    : undefined;
};

const modelDown = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500 ? !failedInService(error) : false;

const errorText = (error: unknown, model: string, t: T) => {
  const notStored = t('playground.notStored');
  if (error instanceof ApiError && error.status === 400 && error.problem?.detail)
    return `${error.problem.detail} ${notStored}`;
  if (error instanceof ApiError && error.status === 403) {
    const policy = (error.problem as Partial<PlaygroundRefusal> | undefined)?.policy;
    return `${t('playground.refused', { model })}${policy ? ` ${policy.rule}` : ''} ${notStored}`;
  }
  if (error instanceof ApiError && error.status === 429)
    return error.problem?.title ?? t('playground.quotaUsedUp', { notStored });
  return slowModelText(model, t);
};

const withoutData = (input: PlaygroundInput): PlaygroundInput =>
  'file' in input && typeof input.file === 'object' && 'data' in input.file
    ? {
        file: {
          name: input.file.name,
          ...(input.file.mediaType ? { mediaType: input.file.mediaType } : {}),
          data: '<base64>',
        },
      }
    : input;

const clone = (setup: PlaygroundSetup): PlaygroundSetup => structuredClone(setup);

const maxHistory = 20;

const answerTextOf = (result: PlaygroundResult) =>
  result.clarification?.question ??
  (result.text?.trim()
    ? result.text
    : result.fields
      ? fieldEntries(result.fields)
          .map((f) => `${f.name}: ${f.value}`)
          .join('\n')
      : '');

const historyOf = (list: Message[], before?: string): PlaygroundHistoryTurn[] => {
  const end = before ? list.findIndex((m) => m.id === before) : -1;
  return (end < 0 ? list : list.slice(0, end))
    .flatMap((m): PlaygroundHistoryTurn[] => {
      const answer = m.result ? answerTextOf(m.result) : '';
      return answer && !('file' in m.input)
        ? [
            { role: 'user', text: questionOf(m.input) },
            { role: 'assistant', text: answer },
          ]
        : [];
    })
    .slice(-maxHistory);
};

const problemError = (problem: PlaygroundStreamProblem) =>
  new ApiError(
    typeof problem.status === 'number' ? problem.status : 502,
    problem as unknown as Problem,
  );

const stopped = (live: Message['live']): Message['live'] =>
  live && {
    a: live.a.status === 'running' ? { ...live.a, status: 'failed', endedAt: Date.now() } : live.a,
    ...(live.b
      ? {
          b:
            live.b.status === 'running'
              ? { ...live.b, status: 'failed' as const, endedAt: Date.now() }
              : live.b,
        }
      : {}),
  };

let messageCounter = 0;
const nextId = () => `m${++messageCounter}`;

const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fileInput = async (chosen: ChosenFile): Promise<PlaygroundInput> =>
  chosen.file
    ? {
        file: {
          name: chosen.name,
          mediaType: chosen.file.type || 'application/octet-stream',
          data: await toBase64(chosen.file),
        },
      }
    : { file: { name: chosen.name, sample: true } };

const otherModel = (options: PlaygroundOptions, current: string) =>
  options.models.find((m) => m.status === 'allowed' && m.id !== current)?.id ?? current;

export const PlaygroundPanel = ({
  layout,
  context = 'free',
  name,
  title,
  state = 'empty',
  onClose,
  api,
  tenant,
  tenantName: tenantNameProp,
  serviceDraft,
  timelinePanel = false,
  bare = false,
  note,
}: PlaygroundPanelProps) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const tenantName = tenantNameProp ?? t('playground.defaultTenant');
  const draftRef = useRef(serviceDraft);
  draftRef.current = serviceDraft;
  const hasDraft = !!serviceDraft && context === 'service' && !!name;
  const id = useId();
  const headingId = `${id}-heading`;
  const narrow = useNarrow();
  const side = layout === 'side';
  const overlay = side && narrow;
  const sectionRef = useRef<HTMLElement>(null);
  const backend = useMemo(
    () => (api && tenant ? apiBackend(api, tenant) : exampleBackend),
    [api, tenant],
  );
  const [loaded, setLoaded] = useState<PlaygroundOptions>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [a, setA] = useState<PlaygroundSetup>();
  const [b, setB] = useState<PlaygroundSetup | null>(null);
  const [answerLanguage, setAnswerLanguage] = useState<AnswerLanguage | ''>('');
  const [editing, setEditing] = useState<SetupKey | null>(null);
  const [draft, setDraft] = useState<PlaygroundSetup | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<{ runs: number; cost: number | null }>({
    runs: 0,
    cost: 0,
  });
  const [quotaWarning, setQuotaWarning] = useState<number | null>(null);
  const [saving, setSaving] = useState<{ message: string; which: SetupKey } | null>(null);
  const [call, setCall] = useState<{ title: string; body: PlaygroundRunRequest } | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [formErrs, setFormErrs] = useState<Record<string, string>>({});
  const [draftOptions, setDraftOptions] = useState<PlaygroundInputField[]>();
  const draftDefinition = serviceDraft?.definition;
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const storageKey = rememberKey(tenant, context, name);
  const remember = (setupA: PlaygroundSetup, setupB: PlaygroundSetup | null) =>
    saveSetups(storageKey, { a: setupA, ...(setupB ? { b: setupB } : {}) });

  useEffect(() => {
    if (!api || !tenant || !draftDefinition) return;
    let current = true;
    const timer = setTimeout(() => {
      api.draftInputFields(tenant, draftDefinition).then(
        (found) => current && setDraftOptions(found),
        () => undefined,
      );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, tenant, draftDefinition]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    backend.options(controller.signal).then(
      (options) => !controller.signal.aborted && setLoaded(options),
      () => !controller.signal.aborted && setLoadFailed(true),
    );
    return () => controller.abort();
  }, [backend, attempt]);

  const options = useMemo(() => {
    if (!loaded) return undefined;
    const named = withNamedOptions(loaded, context, name);
    return hasDraft && name && draftRef.current
      ? withDraftService(named, name, draftRef.current)
      : named;
  }, [loaded, context, name, hasDraft]);
  const attachDraft = (setup: PlaygroundSetup): PlaygroundSetup => {
    const draft = draftRef.current;
    if (!hasDraft || !draft || setup.service?.id !== name || setup.service.version !== 'draft')
      return setup;
    return {
      ...setup,
      service: {
        ...setup.service,
        definition: draft.definition,
        ...(draft.files ? { files: draft.files } : {}),
      },
    };
  };

  useEffect(() => {
    if (!options) return;
    const initial = initialSetup(options, context, name);
    const stored =
      state === 'empty'
        ? loadSetups(rememberKey(tenant, context, name), options, hasDraft ? name : undefined)
        : undefined;
    const first: PlaygroundSetup =
      stored?.a ??
      (hasDraft && name ? { ...initial, service: { id: name, version: 'draft' } } : initial);
    const question = first.skills.includes('skrive-vedtaksbrev')
      ? decisionQuestion
      : evaluationQuestion;
    const input: PlaygroundInput =
      first.output === 'fields'
        ? { file: { name: sampleFileName, sample: true } }
        : { text: question };
    const second =
      state === 'compare'
        ? { ...clone(first), model: otherModel(options, first.model) }
        : (stored?.b ?? null);
    const seeded: Message[] = [];
    if (state === 'answer' || state === 'quota' || state === 'compare') {
      const result = exampleResult(options, first, input);
      const compareResult = second ? exampleResult(options, second, input) : undefined;
      const now = Date.now();
      seeded.push({
        id: nextId(),
        input,
        setups: { a: first, ...(second ? { b: second } : {}) },
        live: {
          a: runFromResult(result, now),
          ...(compareResult ? { b: runFromResult(compareResult, now) } : {}),
        },
        result,
        ...(compareResult ? { compareResult } : {}),
      });
    }
    if (state === 'error')
      seeded.push({
        id: nextId(),
        input,
        setups: { a: first },
        error: slowModelText(
          shortModelName(modelOf(options, first.model).name),
          tRef.current,
          true,
        ),
        modelDown: true,
      });
    const blocked = options.models.find((m) => m.status === 'not_allowed');
    setA(first);
    setB(second);
    setEditing(state === 'not-allowed' ? 'a' : null);
    setDraft(
      state === 'not-allowed' ? { ...clone(first), model: blocked?.id ?? first.model } : null,
    );
    setMessages(seeded);
    setText('');
    setFile(null);
    setSaving(null);
    setCall(null);
    setSession(
      seeded.reduce(
        (s, m) =>
          m.result
            ? {
                runs: s.runs + (m.compareResult ? 2 : 1),
                cost: addCost(s.cost, m.result.costNok, m.compareResult?.costNok),
              }
            : s,
        { runs: 0, cost: 0 as number | null },
      ),
    );
    setQuotaWarning(
      state === 'quota' ? 94 : options.quota.usedPercent >= 90 ? options.quota.usedPercent : null,
    );
  }, [options, state, context, name, hasDraft, tenant]);

  const close = useCallback(() => onClose?.(), [onClose]);
  useEscape(overlay && !!onClose && !call, close);
  useEffect(() => {
    if (overlay) sectionRef.current?.focus();
  }, [overlay]);

  const execute = async (input: PlaygroundInput, replace?: string) => {
    if (!a || !options) return;
    setBusy(true);
    const history = historyOf(messagesRef.current, replace);
    const request: PlaygroundRunRequest = {
      setup: attachDraft(a),
      ...(b ? { compareWith: attachDraft(b) } : {}),
      input,
      ...(history.length ? { history } : {}),
      ...(answerLanguage ? { answerLanguage } : {}),
    };
    const setups = { a, ...(b ? { b } : {}) };
    const id = replace ?? nextId();
    const started = Date.now();
    const fresh: Message = {
      id,
      input,
      setups,
      live: { a: startRun(started), ...(b ? { b: startRun(started) } : {}) },
    };
    setMessages((list) =>
      replace ? list.map((m) => (m.id === replace ? fresh : m)) : [...list, fresh],
    );
    const collected: {
      a?: PlaygroundResult;
      b?: PlaygroundResult;
      failed?: PlaygroundStreamProblem;
      quota?: PlaygroundQuota;
      received: boolean;
    } = { received: false };
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const onEvent = (event: PlaygroundStreamEvent) => {
      if (controller.signal.aborted) return;
      collected.received = true;
      if (event.event === 'done') {
        collected.quota = event.quota;
        return;
      }
      const key: SetupKey = event.setup === 'compareWith' ? 'b' : 'a';
      if (event.event === 'result') collected[key] = event.result;
      if (event.event === 'failed') collected.failed ??= event.problem;
      const now = Date.now();
      setMessages((list) =>
        list.map((m) =>
          m.id !== id || !m.live
            ? m
            : {
                ...m,
                live: { ...m.live, [key]: applyEvent(m.live[key] ?? startRun(now), event, now) },
              },
        ),
      );
    };
    let outcome: Partial<Message>;
    try {
      await backend.stream(request, onEvent, controller.signal);
      if (controller.signal.aborted) return;
      if (collected.failed) throw problemError(collected.failed);
      const result = collected.a;
      if (!result) throw new Error('the run ended without a result');
      const compare = collected.b;
      outcome = { result, ...(compare ? { compareResult: compare } : {}) };
      setSession((s) => ({
        runs: s.runs + (compare ? 2 : 1),
        cost: addCost(s.cost, result.costNok, compare?.costNok),
      }));
      const quota = collected.quota;
      if (quota && quota.usedPercent >= 90)
        setQuotaWarning(Math.min(100, Math.round(quota.usedPercent)));
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = failedInService(error);
      outcome = {
        error: errorText(error, shortModelName(modelOf(options, a.model).name), tRef.current),
        ...(failure ? { failure } : {}),
        ...(modelDown(error) ? { modelDown: true } : {}),
      };
    }
    setMessages((list) =>
      list.map((m) => {
        if (m.id !== id) return m;
        const { live, ...rest } = m;
        const kept = collected.received ? stopped(live) : undefined;
        return { ...rest, ...(kept ? { live: kept } : {}), ...outcome };
      }),
    );
    if (running.current === controller) running.current = null;
    setBusy(false);
  };

  const newConversation = () => {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    setMessages([]);
    setSaving(null);
    setText('');
  };

  const formFields =
    a?.service?.version === 'draft'
      ? withOptionsFrom(inputFieldsOf(draftRef.current?.definition), draftOptions)
      : (options?.services
          .find((s) => s.id === a?.service?.id)
          ?.versions.find((v) => v.version === a?.service?.version)?.inputFields ?? []);
  const formRun = (question: string): PlaygroundInput => ({
    fields: formInput(formFields, formValues),
    ...(question ? { text: question } : {}),
  });

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (busy || draft) return;
    if (formFields.length) {
      const missing = formErrors(formFields, formValues, t);
      setFormErrs(missing);
      if (Object.keys(missing).length) return;
      setText('');
      void execute(formRun(trimmed));
      return;
    }
    if (!trimmed) return;
    setText('');
    void execute({ text: trimmed });
  };

  const fillQuestion = (question: string) => {
    setText(question);
    questionRef.current?.focus();
  };

  const extract = async () => {
    if (busy || draft) return;
    const chosen = file ?? { name: sampleFileName };
    if (!file) setFile(chosen);
    void execute(await fileInput(chosen));
  };

  const retry = (message: Message) => {
    if (busy) return;
    void execute(message.input, message.id);
  };

  if (loadFailed)
    return (
      <section
        className="playground-panel"
        data-layout={layout}
        aria-label={t('playground.panelLabel')}
      >
        <Alert data-color="danger">
          <Heading level={2} data-size="2xs">
            {t('playground.loadFailedTitle')}
          </Heading>
          <Paragraph>{t('playground.loadFailedBody')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      </section>
    );

  const ctxName =
    title ??
    (context === 'skill'
      ? (options?.skills.find((s) => s.id === name || s.name === name)?.name ?? name ?? '')
      : context === 'dataset'
        ? (options?.datasets.find((d) => d.id === name || d.name === name)?.name ?? name)
        : name);
  const contextText =
    context === 'skill'
      ? t('playground.contextSkill', { name: ctxName ?? '' })
      : context === 'dataset'
        ? t('playground.contextDataset', {
            name: ctxName ?? t('playground.contextDatasetFallback'),
          })
        : context === 'service'
          ? t('playground.contextService')
          : t('playground.contextFree');

  const header = side ? (
    <div className="playground-head">
      <div className="playground-head-title">
        <Heading level={2} data-size="xs" id={headingId}>
          {t('playground.panelTitle')}
        </Heading>
        <span className="playground-subtle">{contextText}</span>
      </div>
      <div className="playground-head-actions">
        <Link href="#/playground">{t('playground.openInPlayground')}</Link>
        {onClose ? (
          <Button
            variant="tertiary"
            data-size="sm"
            icon
            aria-label={t('common.close')}
            onClick={close}
          >
            <Icon d={icons.close} />
          </Button>
        ) : null}
      </div>
    </div>
  ) : (
    <h2 id={headingId} className="visually-hidden">
      {t('playground.contextFree')}
    </h2>
  );

  const sectionProps = {
    ref: sectionRef,
    role: side ? 'dialog' : 'region',
    'aria-labelledby': headingId,
    ...(side ? { 'aria-modal': overlay } : {}),
    tabIndex: overlay ? -1 : undefined,
    className: 'playground-panel',
    'data-layout': layout,
    'data-overlay': overlay ? 'true' : 'false',
    'data-context': context,
    'data-state': state,
    style: overlay ? ({ position: 'fixed', inset: 0 } as const) : undefined,
  };

  if (!options || !a)
    return (
      <section {...sectionProps}>
        {header}
        <span role="status" className="playground-status">
          <Spinner aria-hidden data-size="xs" />
          {t('playground.loadingSetup')}
        </span>
      </section>
    );

  const comparing = !!b;
  const owners = Object.fromEntries(
    [...options.services, ...options.skills].map((x) => [x.id, x.name]),
  );
  const editFor = (key: SetupKey) => () => {
    if (editing === key) {
      setEditing(null);
      setDraft(null);
      return;
    }
    const source = key === 'b' ? b : a;
    if (!source) return;
    setEditing(key);
    setDraft(clone(source));
  };
  const toggleCompare = () => {
    if (b) {
      setB(null);
      remember(a, null);
      if (editing === 'b') {
        setEditing(null);
        setDraft(null);
      }
      return;
    }
    const next = { ...clone(a), model: otherModel(options, a.model) };
    setB(next);
    remember(a, next);
    setEditing('b');
    setDraft(clone(next));
  };
  const apply = () => {
    if (!draft || !editing) return;
    if (editing === 'a') {
      const nextB = b ? { ...b, output: draft.output } : null;
      setA(draft);
      setB(nextB);
      remember(draft, nextB);
    } else {
      setB(draft);
      remember(a, draft);
    }
    setEditing(null);
    setDraft(null);
  };
  const isExtract = a.output === 'fields';
  const currentInput = (): PlaygroundInput =>
    isExtract
      ? file?.file
        ? {
            file: {
              name: file.name,
              mediaType: file.file.type || 'application/octet-stream',
              data: '<base64>',
            },
          }
        : { file: { name: file?.name ?? sampleFileName, sample: true } }
      : formFields.length
        ? formRun(text.trim())
        : { text: text.trim() };
  const callBody = (input: PlaygroundInput): PlaygroundRunRequest => ({
    setup: attachDraft(a),
    ...(b ? { compareWith: attachDraft(b) } : {}),
    input: withoutData(input),
    ...(answerLanguage ? { answerLanguage } : {}),
  });
  const sessionText = session.runs
    ? t('playground.sessionRuns', {
        count: session.runs,
        cost: formatKr(session.cost, f, t),
        tenant: tenantName,
      })
    : t('playground.sessionNone', { tenant: tenantName });
  const cantSend = busy || !!draft;

  const startSave = (message: Message, which: SetupKey) => {
    if (saving?.message === message.id && saving.which === which) setSaving(null);
    else setSaving({ message: message.id, which });
  };
  const savingDraft = (message: Message, which: SetupKey): TestCaseDraft => {
    const result = which === 'b' ? message.compareResult : message.result;
    const setup = which === 'b' ? (message.setups.b ?? message.setups.a) : message.setups.a;
    const preferred =
      options.testSets.find((t) => t.skill && setup.skills.includes(t.skill)) ??
      options.testSets.find((t) => t.service && t.service === setup.service?.id) ??
      options.testSets[0];
    return {
      testSet: preferred?.id ?? '',
      question: questionOf(message.input),
      expected: result?.fields
        ? fieldEntries(result.fields)
            .map((f) => `${f.name}: ${f.value}`)
            .join('\n')
        : (result?.text ?? ''),
    };
  };
  const sendCandidate = async (message: Message, which: SetupKey, values: TestCaseDraft) => {
    const result = which === 'b' ? message.compareResult : message.result;
    const setup = which === 'b' ? (message.setups.b ?? message.setups.a) : message.setups.a;
    if (!result) return;
    await backend.proposeTestCase({
      task: result.runId,
      question: values.question,
      answer: values.expected,
      testSet: values.testSet,
      ...(setup.service ? { service: setup.service.id } : {}),
      origin: 'playground',
    });
    const set = options.testSets.find((t) => t.id === values.testSet);
    const href = set?.service
      ? `#/services/${encodeURIComponent(set.service)}/quality`
      : set?.skill
        ? `#/skills?id=${encodeURIComponent(set.skill)}`
        : '#/services';
    setMessages((list) =>
      list.map((m) =>
        m.id === message.id
          ? {
              ...m,
              saved: { name: set ? testSetLabel(set, owners, tRef.current) : values.testSet, href },
            }
          : m,
      ),
    );
    setSaving(null);
  };

  const lastMessage = messages.at(-1);
  const timelineRun =
    lastMessage?.live?.a ??
    (lastMessage?.result ? runFromResult(lastMessage.result, Date.now()) : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ask(text);
  };

  return (
    <section {...sectionProps}>
      {header}
      {quotaWarning !== null ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t.rich('playground.quotaBody', {
              percent: quotaWarning,
              tokens: quotaTokensText(options.quota.monthlyTokens, f, t),
              strong: (c) => <strong>{c}</strong>,
              link: (c) => <Link href="#/usage">{c}</Link>,
            })}
          </Paragraph>
        </Alert>
      ) : null}
      {bare ? null : (
        <>
          <SetupBar
            rows={[
              { key: 'a' as const, setup: a },
              ...(b ? [{ key: 'b' as const, setup: b }] : []),
            ].map((row) => ({
              key: row.key,
              chips: setupChips(options, row.setup, t),
              expanded: editing === row.key,
              onEdit: editFor(row.key),
            }))}
            comparing={comparing}
            sessionText={sessionText}
            onToggleCompare={toggleCompare}
            onShowCall={() =>
              setCall({ title: t('playground.callRun'), body: callBody(currentInput()) })
            }
          />
          <AnswerLanguagePicker value={answerLanguage} onChange={setAnswerLanguage} />
        </>
      )}
      {draft && editing ? (
        <SetupForm
          options={options}
          draft={draft}
          title={
            comparing
              ? t('playground.editSetupKey', { key: editing.toUpperCase() })
              : t('playground.editSetup')
          }
          tenantName={tenantName}
          onChange={setDraft}
          onApply={apply}
          onCancel={() => {
            setEditing(null);
            setDraft(null);
          }}
        />
      ) : null}
      {messages.length === 0 && !busy ? (
        <div className="playground-empty">
          <span className="playground-empty-title">
            {t(isExtract ? 'playground.emptyExtract' : 'playground.emptyChat')}
          </span>
          {bare ? null : <span className="playground-subtle">{t('playground.emptyHelp')}</span>}
          {isExtract || !suggestionsFor(options, a).length ? null : (
            <div className="playground-chips">
              {suggestionsFor(options, a).map((s) => (
                <Chip.Button key={s} data-size="sm" onClick={() => fillQuestion(s)}>
                  {s}
                </Chip.Button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      <div className="playground-split" data-timeline={timelinePanel ? 'true' : 'false'}>
        <div className="playground-thread">
          <ol
            aria-live="polite"
            className="playground-messages"
            aria-label={t('playground.runsLabel')}
          >
            {messages.map((m) => (
              <li
                key={m.id}
                aria-busy={
                  m.live?.a.status === 'running' || m.live?.b?.status === 'running'
                    ? true
                    : undefined
                }
              >
                <div className="playground-question">
                  <span className="playground-question-who">{t('playground.you')}</span>
                  {questionOf(m.input, t)}
                </div>
                {m.failure ? (
                  <RunFailure failure={m.failure} busy={busy} onRetry={() => retry(m)} />
                ) : m.error && m.modelDown ? (
                  <ModelNoAnswer text={m.error} busy={busy} onRetry={() => retry(m)} />
                ) : m.error ? (
                  <Alert data-color="danger">
                    <Heading level={3} data-size="2xs">
                      {t('playground.noAnswerTitle')}
                    </Heading>
                    <Paragraph>{m.error}</Paragraph>
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-disabled={busy ? true : undefined}
                      onClick={() => retry(m)}
                    >
                      {t('common.tryAgain')}
                    </Button>
                  </Alert>
                ) : null}
                {m.live || m.result ? (
                  <div
                    className="playground-answers"
                    data-columns={m.setups.b && !side ? 'two' : 'one'}
                  >
                    {(m.setups.b ? (['a', 'b'] as const) : (['a'] as const)).map((key) => {
                      const run = m.live?.[key];
                      const result = key === 'b' ? m.compareResult : m.result;
                      const setup = key === 'b' ? (m.setups.b ?? m.setups.a) : m.setups.a;
                      const label = m.setups.b
                        ? `${key.toUpperCase()} · ${resultLabel(options, setup, t)}`
                        : undefined;
                      const last = messages.at(-1)?.id === m.id;
                      return (
                        <div key={key} className="playground-run">
                          {run && !bare ? (
                            <RunHeader run={run} {...(result ? { result } : {})} />
                          ) : null}
                          {result ? (
                            <AnswerCard
                              {...(label ? { label } : {})}
                              result={result}
                              saveExpanded={saving?.message === m.id && saving.which === key}
                              onSave={() => startSave(m, key)}
                              onShowCall={() =>
                                setCall({
                                  title: t('playground.callRerun'),
                                  body: callBody(m.input),
                                })
                              }
                              {...(last && key === 'a' && !busy ? { onReply: ask } : {})}
                              bare={bare}
                            />
                          ) : run?.status === 'running' ? (
                            <>
                              {label ? <span className="playground-strong">{label}</span> : null}
                              <LiveText run={run} />
                            </>
                          ) : null}
                          {run && !bare ? (
                            <WhatHappened run={run} idPrefix={`${m.id}-${key}-`} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {saving?.message === m.id ? (
                  <SaveAsTestCase
                    key={`${m.id}-${saving.which}`}
                    testSets={options.testSets}
                    owners={owners}
                    initial={savingDraft(m, saving.which)}
                    onSend={(values) => sendCandidate(m, saving.which, values)}
                    onCancel={() => setSaving(null)}
                  />
                ) : null}
                {m.saved ? (
                  <Alert data-color="success" data-size="sm">
                    <Paragraph data-size="sm">
                      {t.rich('playground.saved', {
                        name: m.saved.name,
                        link: (c) => <Link href={m.saved?.href ?? '#'}>{c}</Link>,
                      })}
                    </Paragraph>
                  </Alert>
                ) : null}
              </li>
            ))}
          </ol>
          {note}
          <div className="playground-thread-foot">
            <span role="status" className="playground-status">
              {busy ? (
                <>
                  <Spinner aria-hidden data-size="xs" />
                  {t(comparing ? 'playground.runningBoth' : 'playground.running')}
                </>
              ) : null}
            </span>
            {messages.length && !isExtract ? (
              <Button variant="tertiary" data-size="sm" onClick={newConversation}>
                {t('playground.newConversation')}
              </Button>
            ) : null}
          </div>
          {isExtract ? (
            <div className="playground-input">
              <Field>
                <Label data-size="sm" htmlFor={`${id}-file`}>
                  {t('playground.document')}
                </Label>
                <Field.Description>
                  {file
                    ? t('playground.fileChosen', { name: file.name })
                    : t('playground.fileHelp')}
                </Field.Description>
                <input
                  className="ds-input"
                  id={`${id}-file`}
                  type="file"
                  accept=".pdf,.docx,.png,.jpg"
                  onChange={(e) => {
                    const chosen = e.target.files?.[0];
                    setFile(chosen ? { name: chosen.name, file: chosen } : null);
                  }}
                />
              </Field>
              <div className="playground-actions">
                <Button
                  variant="primary"
                  aria-disabled={cantSend ? true : undefined}
                  onClick={() => void extract()}
                >
                  {t('playground.extract')}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  onClick={() => setFile({ name: sampleFileName })}
                >
                  {t('playground.useSampleFile')}
                </Button>
              </div>
            </div>
          ) : (
            <form className="playground-input playground-chat" onSubmit={submit} noValidate>
              {formFields.length ? (
                <InputForm
                  fields={formFields}
                  values={formValues}
                  errors={formErrs}
                  intro={t('playground.formIntro')}
                  onChange={(field, value) => {
                    setFormValues((v) => ({ ...v, [field]: value }));
                    setFormErrs(({ [field]: _cleared, ...rest }) => rest);
                  }}
                />
              ) : null}
              <Field className="playground-grow">
                <Label data-size="sm" htmlFor={`${id}-in`}>
                  {formFields.length
                    ? t('playground.questionOptional')
                    : comparing
                      ? t('playground.questionBoth')
                      : t('playground.question')}
                </Label>
                <Textarea
                  ref={questionRef}
                  id={`${id}-in`}
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      ask(text);
                    }
                  }}
                />
              </Field>
              <Button variant="primary" type="submit" aria-disabled={cantSend ? true : undefined}>
                {t('playground.send')}
              </Button>
            </form>
          )}
        </div>
        {timelinePanel ? <TimelinePanel run={timelineRun} /> : null}
      </div>
      {call ? (
        <ApiCallPanel
          call={{
            action: call.title,
            method: 'POST',
            path: `/tenants/${tenant ?? '{tenant}'}/playground/runs`,
            body: call.body,
            needsReason: false,
            right: t('playground.callRight', {
              services: t('rights.manageServices'),
              datasets: t('rights.manageDatasets'),
            }),
          }}
          onClose={() => setCall(null)}
        />
      ) : null}
    </section>
  );
};
