import { setting } from '../runtime-config';
import {
  Alert,
  Button,
  Details,
  ErrorSummary,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Spinner,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Conversation } from '../Conversation';
import { DocumentPicker } from '../DocumentPicker';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { detectLang } from '../language';
import { restoreRuns, runTitle } from '../saved-runs';
import { serviceIdOf } from './projects/shared';
import {
  defaultValues,
  filledValues,
  formErrors,
  formInput,
  ServiceForm,
  type FormValues,
} from '../ServiceForm';
import type {
  AssistantMessage,
  AttachedDocument,
  ChatMessage,
  ChatReply,
  ConversationSummary,
  FormInput,
  ServiceOption,
  UserMessage,
  WorkspaceApi,
} from '../types';

const portalUrl = (setting('PORTAL_URL') ?? 'http://localhost:5173').replace(/\/+$/, '');

export const dataPolicyUrl = `${portalUrl}/#/data-handling`;
export const runLogUrl = (task: string) => `${portalUrl}/#/log/${encodeURIComponent(task)}`;

const PastConversations = ({
  list,
  service,
  current,
  onOpen,
}: {
  list: ConversationSummary[];
  service: string;
  current: string | undefined;
  onOpen: (id: string) => void;
}) => {
  const t = useT();
  const own = list.filter((c) => !c.agentId || c.agentId === serviceIdOf(service));
  if (own.length === 0) return null;
  return (
    <Details data-size="sm" className="past-conversations">
      <Details.Summary>{t('chat.pastConversations')}</Details.Summary>
      <Details.Content>
        <ul className="plain-list">
          {own.slice(0, 10).map((c) => (
            <li key={c.id}>
              <Button
                variant="tertiary"
                data-size="sm"
                aria-current={c.id === current ? 'true' : undefined}
                onClick={() => onOpen(c.id)}
              >
                {c.title || t('chat.untitledConversation')}
              </Button>
            </li>
          ))}
        </ul>
      </Details.Content>
    </Details>
  );
};

export const AiNotice = ({ service }: { service: ServiceOption | undefined }) => {
  const t = useT();
  return (
    <Alert data-color="info" data-size="sm">
      <Paragraph data-size="sm">
        {t.rich('chat.aiNotice', { strong: (c) => <strong>{c}</strong> })}{' '}
        {service?.processing
          ? t('chat.processedBy', { processing: service.processing })
          : t('chat.processedByPlatform')}{' '}
        <a href={dataPolicyUrl}>{t('chat.dataPolicy')}</a>
      </Paragraph>
    </Alert>
  );
};

interface Props {
  api: WorkspaceApi;
  services: ServiceOption[];
  service: ServiceOption;
  onSelectService: (id: string) => void;
  organisation: string;
  initialMessages?: ChatMessage[];
  now?: () => Date;
  question: string;
  onQuestion: (text: string) => void;
  onOpenTable?: (message: AssistantMessage, inputs: { label: string; value: string }[]) => void;
  saved?: Thread | undefined;
  onSave?: ((thread: Thread) => void) | undefined;
  tenant?: string | undefined;
}

export interface Thread {
  messages: ChatMessage[];
  conversationId?: string | undefined;
}

const userContent = (m: UserMessage) =>
  [(m.values ?? []).map((v) => `${v.label}: ${v.value}`).join('\n'), m.text]
    .filter(Boolean)
    .join('\n\n');

const historyOf = (messages: ChatMessage[]) =>
  messages.flatMap((m, i): { role: 'user' | 'assistant'; content: string }[] =>
    m.role === 'assistant'
      ? m.failure || !m.text
        ? []
        : [{ role: m.role, content: m.text }]
      : [{ role: m.role, content: i === messages.length - 1 ? m.text : userContent(m) }],
  );

const inputsBefore = (messages: ChatMessage[], answer: AssistantMessage) => {
  const index = messages.indexOf(answer);
  const asked = messages
    .slice(0, index)
    .reverse()
    .find((m): m is UserMessage => m.role === 'user' && Boolean(m.values?.length));
  return asked?.values ?? [];
};

export const Chat = ({
  api,
  services,
  service,
  onSelectService,
  organisation,
  initialMessages = [],
  now = () => new Date(),
  question,
  onQuestion: setQuestion,
  onOpenTable,
  saved,
  onSave,
  tenant,
}: Props) => {
  const t = useT();
  const pausedText = t('failures.paused');
  const fields = service.inputFields ?? [];
  const formMode = fields.length > 0;
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => saved?.messages.filter((m) => !(m.role === 'assistant' && m.pending)) ?? initialMessages,
  );
  const [conversationId, setConversationId] = useState(saved?.conversationId);
  const [past, retryPast] = useAsync(
    async (signal) => (api.conversations ? await api.conversations.list(signal) : undefined),
    [api],
  );
  const [pastList, setPastList] = useState<ConversationSummary[]>();
  useEffect(() => {
    if (past.status === 'ready') setPastList(past.data);
    if (past.status === 'error') setPastList(undefined);
  }, [past]);
  const conversationsOn = pastList !== undefined;
  const ownPast = (pastList ?? []).filter(
    (c) => !c.agentId || c.agentId === serviceIdOf(service.id),
  );
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<FormValues>(() => defaultValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editingForm, setEditingForm] = useState(true);
  const [note, setNote] = useState('');
  const [documents, setDocuments] = useState<AttachedDocument[]>([]);
  const rules = service.documents;
  const field = useRef<HTMLTextAreaElement>(null);
  const summary = useRef<HTMLElement | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const counter = useRef(0);

  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => {
    onSave?.({ messages, conversationId });
  }, [messages, conversationId]);
  const formService = useRef(service.id);
  useEffect(() => {
    if (formService.current === service.id) return;
    formService.current = service.id;
    setValues(defaultValues(service.inputFields ?? []));
    setErrors({});
    setEditingForm(true);
  }, [service.id]);

  const patch = (id: string, change: Partial<AssistantMessage>) =>
    setMessages((list) =>
      list.map((m) => (m.id === id && m.role === 'assistant' ? { ...m, ...change } : m)),
    );

  const ask = async (answerId: string, history: ChatMessage[]) => {
    const last = history.at(-1);
    const input = last?.role === 'user' ? last.input : undefined;
    const controller = new AbortController();
    inFlight.current = controller;
    setAnnounce('');
    setBusy(true);
    let reply: ChatReply;
    try {
      reply = await api.chat(
        service.id,
        historyOf(history),
        (text) => patch(answerId, { text, lang: detectLang(text) }),
        controller.signal,
        input,
        conversationsOn ? { ...(conversationId ? { id: conversationId } : {}) } : undefined,
        rules && documents.length ? documents : undefined,
      );
    } catch {
      if (controller.signal.aborted) return;
      reply = { text: '', sources: [], failure: { kind: 'unavailable' } };
    }
    if (reply.conversationId) {
      const filled = last?.role === 'user' ? (last.values ?? []) : [];
      const rename = api.conversations?.rename;
      setConversationId(reply.conversationId);
      if (formMode && !conversationId && filled.length && rename)
        void rename(reply.conversationId, runTitle(filled)).then(retryPast, retryPast);
      else retryPast();
    }
    patch(answerId, {
      pending: false,
      text: reply.failure ? '' : reply.text,
      lang: detectLang(reply.text),
      sources: reply.failure ? [] : reply.sources,
      ...(reply.task ? { task: reply.task } : {}),
      ...(reply.noAnswer ? { noAnswer: true } : {}),
      ...(reply.table && !reply.failure
        ? { table: reply.table, ...(reply.csv ? { csv: reply.csv } : {}) }
        : {}),
      ...(reply.failure ? { failure: reply.failure } : {}),
    });
    setAnnounce(reply.failure ? t('chat.answerFailed') : t('chat.answerReady'));
    setBusy(false);
  };

  const send = (text: string, input?: FormInput, filled: UserMessage['values'] = []) => {
    counter.current += 1;
    const asked: ChatMessage = {
      id: `asked-${counter.current}`,
      role: 'user',
      text,
      lang: detectLang(text || filled.map((v) => v.value).join(' ')),
      ...(filled.length ? { values: filled } : {}),
      ...(input ? { input } : {}),
      ...(rules && documents.length ? { attachments: documents.map((d) => d.name) } : {}),
    };
    const answer: AssistantMessage = {
      id: `answer-${counter.current}`,
      role: 'assistant',
      text: '',
      lang: 'nb',
      sources: [],
      pending: true,
    };
    const history = [...messages, asked];
    setMessages([...history, answer]);
    void ask(answer.id, history);
  };

  const runForm = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const missing = formErrors(fields, values, t);
    setErrors(missing);
    if (Object.keys(missing).length) {
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setEditingForm(false);
    send(note.trim(), formInput(fields, values), filledValues(fields, values));
    setNote('');
  };

  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const text = question.trim();
    if (!text) {
      setError(t('chat.writeQuestion'));
      field.current?.focus();
      return;
    }
    send(text);
    setQuestion('');
  };

  const retry = (failed: AssistantMessage) => {
    if (busy) return;
    const index = messages.findIndex((m) => m.id === failed.id);
    if (index < 0) return;
    const history = messages.slice(0, index);
    const retried: AssistantMessage = {
      id: failed.id,
      role: 'assistant',
      text: '',
      lang: failed.lang,
      sources: [],
      pending: true,
    };
    setMessages([...history, retried, ...messages.slice(index + 1)]);
    void ask(failed.id, history);
  };

  const startNew = () => {
    inFlight.current?.abort();
    setBusy(false);
    setMessages([]);
    setConversationId(undefined);
    setDocuments([]);
    setQuestion('');
    setError('');
    setEditingForm(true);
    field.current?.focus();
  };

  const reviewRun = api.tableReview;
  const openPast = async (id: string) => {
    inFlight.current?.abort();
    setBusy(false);
    try {
      const loaded = await (api.conversations as NonNullable<typeof api.conversations>).messages(
        id,
      );
      const restored =
        formMode && tenant && reviewRun
          ? await restoreRuns(loaded, fields, (task) => reviewRun(tenant, task))
          : loaded;
      setMessages(restored);
      setConversationId(id);
      if (formMode && restored.some((m) => m.role === 'assistant')) setEditingForm(false);
    } catch {
      setError(t('chat.pastFailed'));
    }
  };

  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || !formMode || pastList === undefined) return;
    reopened.current = true;
    const latest = ownPast[0];
    if (latest && messages.length === 0 && !saved?.messages.length) void openPast(latest.id);
  }, [pastList]);

  const shown = formMode
    ? messages.filter((m) => !(m.role === 'user' && m.values?.length && !m.text))
    : messages;
  const lastValues = [...messages]
    .reverse()
    .find((m): m is UserMessage => m.role === 'user' && Boolean(m.values?.length))?.values;
  const answered = messages.some((m) => m.role === 'assistant' && !m.pending);
  const errorList = Object.entries(errors);

  const questionField = (label: string, id: string) => (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {formMode ? null : (
        <Paragraph id="question-help" data-size="sm" className="subtle-sm">
          {t('chat.noPersonalData')}
        </Paragraph>
      )}
      <Textarea
        id={id}
        ref={field}
        rows={2}
        value={question}
        aria-describedby={
          [formMode ? '' : 'question-help', error ? 'question-error' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setQuestion(e.target.value);
          setError('');
        }}
      />
      {error ? <ValidationMessage id="question-error">{error}</ValidationMessage> : null}
    </Field>
  );

  return (
    <div className="chat">
      <div role="status" className="visually-hidden">
        {announce}
      </div>
      <div className="page-head">
        <Heading level={1} data-size="md">
          {service.name}
        </Heading>
        {service.description ? <Paragraph>{service.description}</Paragraph> : null}
      </div>
      <AiNotice service={service} />
      {conversationsOn ? (
        <div className="chat-tools">
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={messages.length === 0 || undefined}
            onClick={() => messages.length > 0 && startNew()}
          >
            {t('chat.newConversation')}
          </Button>
          <PastConversations
            list={pastList ?? []}
            service={service.id}
            current={conversationId}
            onOpen={(id) => void openPast(id)}
          />
        </div>
      ) : null}
      {services.length > 1 ? (
        <Field data-size="sm">
          <Label htmlFor="service">{t('chat.service')}</Label>
          <Select id="service" value={service.id} onChange={(e) => onSelectService(e.target.value)}>
            {services.map((s) => (
              <Select.Option key={s.id} value={s.id} disabled={s.paused}>
                {s.paused ? t('chat.pausedOption', { name: s.name }) : s.name}
              </Select.Option>
            ))}
          </Select>
        </Field>
      ) : null}
      {services.length > 1 && services.some((s) => s.paused) ? (
        <ul className="subtle-sm" aria-label={t('chat.pausedServices')}>
          {services
            .filter((s) => s.paused)
            .map((s) => (
              <li key={s.id}>
                {t('chat.pausedItem', { name: s.name, reason: s.pausedReason ?? pausedText })}
              </li>
            ))}
        </ul>
      ) : null}
      {service.paused ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t('chat.paused', { reason: service.pausedReason ?? pausedText })}
          </Paragraph>
        </Alert>
      ) : null}
      {formMode && !service.paused && editingForm ? (
        <form onSubmit={runForm} className="form-card" noValidate>
          {errorList.length ? (
            <ErrorSummary
              ref={(el) => {
                summary.current = el;
              }}
              tabIndex={-1}
            >
              <ErrorSummary.Heading>{t('chat.fixBeforeRun')}</ErrorSummary.Heading>
              <ErrorSummary.List>
                {errorList.map(([id, text]) => (
                  <ErrorSummary.Item key={id}>
                    <ErrorSummary.Link href={`#skjema-${id}`}>{text}</ErrorSummary.Link>
                  </ErrorSummary.Item>
                ))}
              </ErrorSummary.List>
            </ErrorSummary>
          ) : null}
          <ServiceForm
            fields={fields}
            values={values}
            errors={errors}
            onChange={(id, value) => {
              setValues((v) => ({ ...v, [id]: value }));
              setErrors(({ [id]: _cleared, ...rest }) => rest);
            }}
          />
          <Field data-size="sm">
            <Label htmlFor="skjema-merknad">
              {t('chat.note')} <span className="subtle-label">{t('chat.optional')}</span>
            </Label>
            <Textarea
              id="skjema-merknad"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {rules ? (
            <DocumentPicker
              id="skjema-filer"
              rules={rules}
              documents={documents}
              onChange={setDocuments}
            />
          ) : null}
          <Details data-size="sm" aria-label={t('chat.showApiCall')}>
            <Details.Summary>{t('chat.showApiCall')}</Details.Summary>
            <Details.Content>
              <code className="api-line">POST /v1/chat/completions</code>
              <pre className="api-body">
                {JSON.stringify(
                  {
                    model: service.id,
                    input: formInput(fields, values),
                    ...(note.trim() ? { messages: [{ role: 'user', content: note.trim() }] } : {}),
                  },
                  null,
                  2,
                )}
              </pre>
            </Details.Content>
          </Details>
          <Button type="submit" className="form-submit" aria-disabled={busy || undefined}>
            {t('chat.runService')}
          </Button>
        </form>
      ) : null}
      {formMode && !editingForm && lastValues ? (
        <div className="choice-summary">
          <dl className="inline-facts">
            {lastValues.map((v) => (
              <div key={v.label}>
                <dt>{v.label}:</dt>
                <dd>{v.value}</dd>
              </div>
            ))}
          </dl>
          <Button variant="secondary" data-size="sm" onClick={() => setEditingForm(true)}>
            {t('chat.changeChoices')}
          </Button>
        </div>
      ) : null}
      {formMode && busy ? (
        <div className="running-panel">
          <Spinner aria-hidden data-size="sm" />
          <span role="status">{t('chat.working')}</span>
        </div>
      ) : null}
      {shown.length ? (
        <Conversation
          messages={shown}
          organisation={organisation}
          now={now()}
          onRetry={retry}
          onFeedback={(input) => api.sendFeedback(input)}
          {...(onOpenTable
            ? { onOpenTable: (m: AssistantMessage) => onOpenTable(m, inputsBefore(messages, m)) }
            : {})}
        />
      ) : null}
      {service.batch && !formMode && !service.paused ? (
        <Alert data-color="info" data-size="sm">
          <Paragraph data-size="sm">
            {t('chat.batchNotice')}{' '}
            <a
              href={`${portalUrl}/#/services/${encodeURIComponent(serviceIdOf(service.id))}/batch`}
            >
              {t('chat.batchLink')}
            </a>
          </Paragraph>
        </Alert>
      ) : service.paused ? null : !formMode ? (
        <form onSubmit={submitQuestion} className="composer" noValidate>
          {questionField(service.prompt ?? t('chat.askQuestion'), 'question')}
          {rules ? (
            <DocumentPicker
              id="question-files"
              rules={rules}
              documents={documents}
              onChange={setDocuments}
            />
          ) : null}
          <Button type="submit" className="composer-send" aria-disabled={busy || undefined}>
            {t('chat.send')}
          </Button>
        </form>
      ) : answered && !editingForm ? (
        <form onSubmit={submitQuestion} className="follow-up" noValidate>
          {questionField(t('chat.askFollowUp'), 'question')}
          <Button
            type="submit"
            variant="secondary"
            data-size="sm"
            className="form-submit"
            aria-disabled={busy || undefined}
          >
            {t('chat.send')}
          </Button>
        </form>
      ) : null}
    </div>
  );
};
