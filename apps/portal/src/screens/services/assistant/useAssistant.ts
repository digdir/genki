import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../api';
import type {
  AssistantEvent,
  AssistantIntent,
  AssistantPolicy,
  AssistantProposal,
  AssistantQuestion,
  AssistantRejected,
  AssistantTurn,
  AssistantTurnRequest,
  AssistantUnavailableReason,
  AssistantUsage,
  ImprovedInstructions,
  SuggestedTestCase,
} from '../../../api/assistant';
import type { ChatMessage } from '../../../data/services';
import { useT } from '../../../i18n';
import { refusalOf } from '../../../states';

export type Availability =
  | { kind: 'ready' }
  | {
      kind: 'unavailable';
      reason: AssistantUnavailableReason | 'api' | 'unknown';
      task?: string;
      message?: string;
    }
  | { kind: 'disabled' }
  | { kind: 'refused'; message: string }
  | { kind: 'budget'; usage: AssistantUsage };

export interface TurnEntry {
  id: string;
  message: string;
  request: Omit<AssistantTurnRequest, 'draft'>;
  draft: Record<string, unknown>;
  text: string;
  streaming: boolean;
  questions: AssistantQuestion[];
  proposals: AssistantProposal[];
  rejected: AssistantRejected[];
  policy?: AssistantPolicy;
  turn?: AssistantTurn;
  answered?: boolean;
  alternativeUsed?: boolean;
}

export type ImproveState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'open' | 'applied'; data: ImprovedInstructions; previous: string };

export type TestDecision = 'accepted' | 'rejected';
export type TestCaseState = 'sending' | 'sent' | 'failed' | 'rejected';

export type TestSuggestions =
  | { status: 'idle' | 'busy' }
  | {
      status: 'open';
      intro: string;
      turnId: string;
      cases: SuggestedTestCase[];
      decisions: Record<string, TestCaseState>;
    };

export const proposalKey = (entry: string, proposal: string) => `${entry}:${proposal}`;

export const isAlternative = (entry: TurnEntry, proposal: AssistantProposal) =>
  proposal.level === 1 && entry.proposals.some((p) => p.level === 4);

export const appliesDirectly = (entry: TurnEntry, proposal: AssistantProposal) =>
  proposal.level === 1 &&
  proposal.validation.ok &&
  !!proposal.after &&
  !isAlternative(entry, proposal);

interface Options {
  api: ApiClient;
  tenant: string;
  service: string;
  definition: () => Record<string, unknown>;
  onMessage: (message: ChatMessage) => void;
  onApply: (entry: TurnEntry, proposal: AssistantProposal) => void;
}

const statusOf = (error: unknown) =>
  error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 0;

const knownReasons: readonly string[] = [
  'not_published',
  'no_model',
  'model_failed',
  'empty_result',
] satisfies AssistantUnavailableReason[];

export const unavailableOf = (turn: AssistantTurn): Availability => {
  const reason =
    turn.reason && knownReasons.includes(turn.reason) ? turn.reason : ('unknown' as const);
  const withTask = reason === 'model_failed' || reason === 'empty_result';
  return {
    kind: 'unavailable',
    reason,
    ...(withTask && turn.turnId ? { task: turn.turnId } : {}),
    ...(reason === 'unknown' && turn.message ? { message: turn.message } : {}),
  };
};

let counter = 0;
const nextId = () => `turn-${++counter}`;

export const useAssistant = ({ api, tenant, service, definition, onMessage, onApply }: Options) => {
  const translate = useT();
  const tRef = useRef(translate);
  tRef.current = translate;
  const entriesRef = useRef<Record<string, TurnEntry>>({});
  const [entries, setEntries] = useState<Record<string, TurnEntry>>({});
  const [availability, setAvailability] = useState<Availability>({ kind: 'ready' });
  const [pending, setPending] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [improve, setImprove] = useState<ImproveState>({ status: 'idle' });
  const [tests, setTestsState] = useState<TestSuggestions>({ status: 'idle' });
  const testsRef = useRef<TestSuggestions>(tests);
  const setTests = useCallback((next: (current: TestSuggestions) => TestSuggestions) => {
    testsRef.current = next(testsRef.current);
    setTestsState(testsRef.current);
  }, []);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const callbacks = useRef({ onMessage, onApply, definition });
  callbacks.current = { onMessage, onApply, definition };

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const update = useCallback((id: string, patch: Partial<TurnEntry>) => {
    const current = entriesRef.current[id];
    if (!current) return;
    entriesRef.current = { ...entriesRef.current, [id]: { ...current, ...patch } };
    setEntries(entriesRef.current);
  }, []);

  const statusTurn = (turn: AssistantTurn) => {
    if (typeof turn?.message !== 'string' || !Array.isArray(turn.proposals))
      setAvailability({ kind: 'unavailable', reason: 'api' });
    else if (turn.status === 'unavailable') setAvailability(unavailableOf(turn));
    else if (turn.status === 'budget_exhausted')
      setAvailability({ kind: 'budget', usage: turn.usage });
    else return false;
    return true;
  };

  const failed = (error: unknown) => {
    const refusal = refusalOf(error);
    setAvailability(
      refusal
        ? { kind: 'refused', message: refusal }
        : statusOf(error) === 409
          ? { kind: 'disabled' }
          : { kind: 'unavailable', reason: 'api' },
    );
  };

  const begin = (
    message: string,
    request: TurnEntry['request'],
    draft: Record<string, unknown>,
  ) => {
    const entry: TurnEntry = {
      id: nextId(),
      message,
      request,
      draft,
      text: '',
      streaming: true,
      questions: [],
      proposals: [],
      rejected: [],
    };
    entriesRef.current = { ...entriesRef.current, [entry.id]: entry };
    setEntries(entriesRef.current);
    callbacks.current.onMessage({ role: 'assistant', text: '', turn: entry.id });
    return entry.id;
  };

  const finish = (id: string, turn: AssistantTurn) => {
    update(id, {
      streaming: false,
      text: turn.message,
      turn,
      questions: turn.questions ?? [],
      proposals: turn.proposals,
      rejected: turn.rejected ?? [],
      ...(turn.policy ? { policy: turn.policy } : {}),
    });
    const entry = entriesRef.current[id];
    if (!entry) return;
    entry.proposals
      .filter((p) => appliesDirectly(entry, p))
      .forEach((p) => {
        if (!p.flows?.length) return callbacks.current.onApply(entry, p);
        void publishFlows(p).then(
          () => callbacks.current.onApply(entry, p),
          () =>
            update(id, {
              rejected: [
                ...(entriesRef.current[id]?.rejected ?? []),
                {
                  attempted: p.title,
                  reason: tRef.current('assistant.flowPublishFailed'),
                  code: 'FLOW_PUBLISH_FAILED',
                },
              ],
            }),
        );
      });
  };

  const publishFlows = async (proposal: AssistantProposal) => {
    for (const flow of proposal.flows ?? [])
      await api.publish(flow, {}, tRef.current('assistant.flowReason', { title: proposal.title }));
  };

  const play = (id: string, turn: AssistantTurn) => {
    const full = turn.message;
    let shown = 0;
    let announced = 0;
    update(id, { rejected: turn.rejected ?? [] });
    const tick = () => {
      shown = Math.min(full.length, shown + 24);
      const now = full.slice(0, shown);
      const parts = now.split('\n\n');
      const complete = shown >= full.length ? parts : parts.slice(0, -1);
      if (complete.length > announced) {
        announced = complete.length;
        setAnnounce(complete[complete.length - 1] ?? '');
      }
      update(id, { text: now });
      if (shown < full.length) later(tick, 30);
      else later(() => finish(id, turn), turn.rejected?.length ? 1200 : 0);
    };
    tick();
  };

  const receive = (
    message: string,
    request: TurnEntry['request'],
    draft: Record<string, unknown>,
    turn: AssistantTurn,
  ) => {
    if (statusTurn(turn)) return;
    play(begin(message, request, draft), turn);
  };

  const lastTurn = useRef<string>(undefined);
  const send = async (text: string, answers?: Record<string, string>, display?: string) => {
    const message = text.trim();
    if (!message || pending || availability.kind !== 'ready') return;
    setAnnounce('');
    callbacks.current.onMessage({ role: 'user', text: display ?? message });
    const draft = callbacks.current.definition();
    const request: TurnEntry['request'] = {
      message,
      intent: 'chat',
      ...(answers ? { answers } : {}),
      ...(lastTurn.current ? { previousTurn: lastTurn.current } : {}),
    };
    setPending(true);
    let streamed: string | undefined;
    const onEvent = (event: AssistantEvent) => {
      if (event.type === 'done') return;
      streamed ??= begin(message, request, draft);
      const entry = entriesRef.current[streamed];
      if (!entry) return;
      if (event.type === 'delta') update(entry.id, { text: entry.text + event.text });
      if (event.type === 'paragraph') setAnnounce(event.text);
      if (event.type === 'question')
        update(entry.id, { questions: [...entry.questions, event.question] });
      if (event.type === 'rejected')
        update(entry.id, { rejected: [...entry.rejected, event.rejected] });
    };
    try {
      const result = await api.assistant.turn(
        tenant,
        service,
        { ...request, draft: { definition: draft } },
        api.assistant.streams ? onEvent : undefined,
      );
      if (result.turn?.turnId) lastTurn.current = result.turn.turnId;
      if (streamed) {
        if (!statusTurn(result.turn)) finish(streamed, result.turn);
      } else receive(message, request, draft, result.turn);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };

  const retry = () => {
    setAvailability({ kind: 'ready' });
  };

  const answer = (entry: TurnEntry, answers: Record<string, string>) => {
    update(entry.id, { answered: true });
    const display = entry.questions.map((q, i) => `${i + 1}. ${answers[q.id] ?? ''}`).join('\n');
    void send(display, answers, display);
  };

  const applyAlternative = (entry: TurnEntry) => {
    update(entry.id, { alternativeUsed: true });
    entry.proposals
      .filter((p) => isAlternative(entry, p) && p.validation.ok && p.after)
      .forEach((p) => callbacks.current.onApply(entry, p));
  };

  const ask = async (intent: AssistantIntent, message: string) => {
    const draft = callbacks.current.definition();
    try {
      const { turn } = await api.assistant.turn(tenant, service, {
        message,
        intent,
        draft: { definition: draft },
      });
      return statusTurn(turn) ? undefined : turn;
    } catch (error) {
      failed(error);
      return undefined;
    }
  };

  const showImprove = (turn: AssistantTurn | undefined, previous: string) =>
    setImprove(
      turn?.improvedInstructions
        ? { status: 'open', data: turn.improvedInstructions, previous }
        : { status: 'idle' },
    );

  const startImprove = async (current: string) => {
    if (improve.status !== 'idle') {
      setImprove({ status: 'idle' });
      return;
    }
    setImprove({ status: 'busy' });
    showImprove(
      await ask('improve-instructions', tRef.current('assistant.improveMessage')),
      current,
    );
  };

  const showTests = (turn: AssistantTurn | undefined) =>
    setTests(() =>
      turn?.testCases
        ? {
            status: 'open',
            intro: turn.message,
            turnId: turn.turnId,
            cases: turn.testCases,
            decisions: {},
          }
        : { status: 'idle' },
    );

  const suggestTests = async () => {
    setTests(() => ({ status: 'busy' }));
    showTests(await ask('suggest-test-cases', tRef.current('assistant.suggestMessage')));
  };

  const markTest = (id: string, state: TestCaseState | undefined) =>
    setTests((t) => {
      if (t.status !== 'open') return t;
      const rest = Object.fromEntries(Object.entries(t.decisions).filter(([key]) => key !== id));
      return { ...t, decisions: state ? { ...rest, [id]: state } : rest };
    });

  const serviceId = () => {
    if (service !== 'new') return service;
    const metadata = callbacks.current.definition().metadata;
    const id = metadata && typeof metadata === 'object' && 'id' in metadata ? metadata.id : '';
    return typeof id === 'string' && id ? id : service;
  };

  const sendTest = async (id: string) => {
    const t = testsRef.current;
    const testCase = t.status === 'open' ? t.cases.find((c) => c.id === id) : undefined;
    if (t.status !== 'open' || !testCase) return;
    markTest(id, 'sending');
    try {
      const owner = serviceId();
      const sets = await api.listTestSets(tenant, owner);
      await api.assistant.proposeTestCase(tenant, {
        task: t.turnId,
        question: testCase.input,
        answer: testCase.expected,
        testSet: sets[0]?.metadata.id ?? `${owner}-default`,
        service: owner,
        origin: 'assistant',
      });
      markTest(id, 'sent');
    } catch {
      markTest(id, 'failed');
    }
  };

  const decideTest = (id: string, decision: TestDecision | undefined) => {
    const t = testsRef.current;
    if (t.status !== 'open') return;
    const current = t.decisions[id];
    if (current === 'sending' || current === 'sent') return;
    if (decision === 'accepted') void sendTest(id);
    else if (decision === 'rejected') {
      if (!current) markTest(id, 'rejected');
    } else markTest(id, undefined);
  };

  const seed = (
    message: string | undefined,
    turn: AssistantTurn,
    draft: Record<string, unknown>,
  ) => {
    if (turn.improvedInstructions) {
      showImprove(turn, turn.improvedInstructions.before);
      return;
    }
    if (turn.testCases) {
      showTests(turn);
      return;
    }
    if (statusTurn(turn)) return;
    if (message) callbacks.current.onMessage({ role: 'user', text: message });
    receive(message ?? '', { message: message ?? '', intent: 'chat' }, draft, turn);
  };

  return {
    entries,
    availability,
    setAvailability,
    pending,
    streaming: Object.values(entries).some((e) => e.streaming),
    announce,
    improve,
    setImprove,
    tests,
    send,
    retry,
    answer,
    applyAlternative,
    startImprove,
    suggestTests,
    decideTest,
    seed,
    turnPath: api.assistant.turnPath(tenant, service),
  };
};

export type AssistantController = ReturnType<typeof useAssistant>;
