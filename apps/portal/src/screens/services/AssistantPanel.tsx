import {
  Button,
  Chip,
  Field,
  Label,
  Paragraph,
  Spinner,
  Tag,
  Textarea,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssistantProposal, AssistantTurn, ProposalDecision } from '../../api/assistant';
import { useDeveloperView } from '../../components/developer-view';
import { Icon, icons } from '../../components/Icon';
import { useT } from '../../i18n';
import type { ChangeCard, ChatMessage } from '../../data/services';
import {
  AssistantBanner,
  ChangeProposalCard,
  PlatformCard,
  PolicyCard,
  Questions,
  RejectedCard,
} from './assistant/cards';
import { MessageApiCall, type MessageCall } from './assistant/MessageApiCall';
import {
  isAlternative,
  proposalKey,
  type AssistantController,
  type TurnEntry,
} from './assistant/useAssistant';
import './assistant/assistant.css';

const sendArrow = 'M12 19V5M6 11l6-6 6 6';
const sparkle = 'M12 3l2 6.5L20.5 12 14 14.5 12 21l-2-6.5L3.5 12 10 9.5z';

interface Props {
  messages: ChatMessage[];
  cardFor: (id: string) => ChangeCard | undefined;
  undone: Record<string, boolean>;
  done: Record<string, boolean>;
  applied: Record<string, boolean>;
  typing: boolean;
  composer: string;
  suggestions: string[];
  userName: string;
  tenantName: string;
  assistant: AssistantController;
  canApprove: (level: number) => boolean;
  onDecide: (
    proposal: AssistantProposal,
    action: 'approve' | 'reject' | 'send',
    reason: string,
  ) => Promise<ProposalDecision>;
  onComposer: (value: string) => void;
  onSend: (text: string) => void;
  onShow: (id: string) => void;
  onUndo: (id: string) => void;
  onAction: (id: string) => void;
}

const exampleResponse = (message: ChatMessage, cardFor: Props['cardFor']): AssistantTurn => ({
  turnId: 'trn_eksempel',
  status: 'completed',
  message: message.text,
  proposals: (message.cards ?? []).flatMap((id) => {
    const card = cardFor(id);
    return card
      ? [
          {
            id,
            level: 1 as const,
            kind: 'change' as const,
            title: card.title,
            detail: card.detail,
            section: card.section,
            validation: { ok: true },
            requiresApproval: false,
            appliedToDraft: false as const,
          },
        ]
      : [];
  }),
  usage: { tokens: 2140, budgetLeftToday: 118400, dailyBudget: 200000 },
});

export const AssistantPanel = ({
  messages,
  cardFor,
  undone,
  done,
  applied,
  typing,
  composer,
  suggestions,
  userName,
  tenantName,
  assistant,
  canApprove,
  onDecide,
  onComposer,
  onSend,
  onShow,
  onUndo,
  onAction,
}: Props) => {
  const t = useT();
  const developer = useDeveloperView();
  const log = useRef<HTMLDivElement>(null);
  const [call, setCall] = useState<MessageCall | null>(null);
  const [policyDone, setPolicyDone] = useState<Record<string, boolean>>({});
  const { availability, entries, streaming } = assistant;
  const pending = assistant.pending || typing;
  const off = availability.kind !== 'ready';
  const empty = messages.length === 0 && !pending;
  const ready = !!composer.trim() && !pending && !streaming && !off;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length, pending, entries]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend(composer);
  };
  const previousUser = (index: number) =>
    messages
      .slice(0, index)
      .reverse()
      .find((m) => m.role === 'user')?.text ?? '';

  const proposalCard = (entry: TurnEntry, p: AssistantProposal) => {
    const key = proposalKey(entry.id, p.id);
    return (
      <ChangeProposalCard
        key={key}
        proposal={p}
        applied={!!applied[key]}
        undone={!!undone[key]}
        onShow={() => onShow(key)}
        onUndo={() => onUndo(key)}
      />
    );
  };

  const turnBody = (entry: TurnEntry) => {
    const alternatives = entry.proposals.filter((p) => isAlternative(entry, p));
    return (
      <>
        <div className="msg-text">
          {entry.text}
          {entry.streaming ? <span aria-hidden="true" className="stream-cursor" /> : null}
        </div>
        {entry.rejected.map((r) => (
          <RejectedCard key={`${r.code}-${r.attempted}`} rejected={r} retrying={entry.streaming} />
        ))}
        {entry.questions.length && !entry.streaming ? (
          <Questions entry={entry} onSend={(answers) => assistant.answer(entry, answers)} />
        ) : null}
        {entry.policy ? (
          <PolicyCard
            policy={entry.policy}
            tenantName={tenantName}
            alternativeDone={!!policyDone[entry.id]}
            onAlternative={(text) => {
              setPolicyDone((d) => ({ ...d, [entry.id]: true }));
              void assistant.send(text);
            }}
          />
        ) : null}
        {entry.proposals
          .filter((p) => !isAlternative(entry, p))
          .map((p) =>
            p.level === 1 ? (
              proposalCard(entry, p)
            ) : (
              <PlatformCard
                key={proposalKey(entry.id, p.id)}
                proposal={p}
                tenantName={tenantName}
                canApprove={canApprove(p.level)}
                alternative={p.level === 4 ? alternatives[0] : undefined}
                alternativeUsed={!!entry.alternativeUsed}
                onAlternative={() => assistant.applyAlternative(entry)}
                decide={(action, reason) => onDecide(p, action, reason)}
              />
            ),
          )}
        {entry.alternativeUsed ? alternatives.map((p) => proposalCard(entry, p)) : null}
      </>
    );
  };

  return (
    <aside aria-label={t('assistant.title')} className="assistant">
      <div className="assistant-head">
        <h2 className="assistant-title">{t('assistant.title')}</h2>{' '}
      </div>
      <AssistantBanner
        availability={availability}
        tenantName={tenantName}
        onRetry={assistant.retry}
      />
      <div role="status" className="visually-hidden">
        {assistant.announce}
      </div>
      <div ref={log} aria-live={streaming ? 'off' : 'polite'} className="assistant-log">
        {empty ? (
          <div className="assistant-empty">
            <div className="assistant-welcome">
              <span className="assistant-mark" aria-hidden="true">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  focusable="false"
                >
                  <path d={sparkle} />
                </svg>
              </span>
              <Paragraph data-size="sm">{t('assistant.emptyWelcome')}</Paragraph>
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => {
          const user = m.role === 'user';
          const entry = m.turn ? entries[m.turn] : undefined;
          const showCall = !user && !entry?.streaming;
          return (
            <div key={i} className={user ? 'msg msg-user' : 'msg msg-assistant'}>
              <span className="msg-who">{user ? userName : t('assistant.assistantName')}</span>
              {entry ? turnBody(entry) : <div className="msg-text">{m.text}</div>}
              {(m.cards ?? []).map((id) => {
                const card = cardFor(id);
                if (!card) return null;
                const isUndone = !!undone[id];
                return (
                  <div key={id} className="change-card">
                    <div className="tag-row">
                      <Tag
                        data-size="sm"
                        data-color={isUndone ? 'neutral' : card.tag ? 'info' : 'accent'}
                      >
                        {isUndone
                          ? t('assistant.undoneTag')
                          : (card.tag ?? t('assistant.changeTag'))}
                      </Tag>
                    </div>
                    <span className={isUndone ? 'change-title undone' : 'change-title'}>
                      {card.title}
                    </span>
                    <span className="meta">{card.detail}</span>
                    <div className="change-actions">
                      <Button
                        variant="tertiary"
                        data-size="sm"
                        aria-label={t('assistant.showChangeLabel', { title: card.title })}
                        onClick={() => onShow(id)}
                      >
                        {t('assistant.showChange')}
                      </Button>
                      {card.undo || card.apply ? (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t(isUndone ? 'assistant.redoLabel' : 'assistant.undoLabel', {
                            title: card.title,
                          })}
                          onClick={() => onUndo(id)}
                        >
                          {t(isUndone ? 'assistant.redo' : 'assistant.undo')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {m.actions?.length ? (
                <div className="tag-row">
                  {m.actions.map(([aid, label]) => (
                    <Button
                      key={aid}
                      variant="secondary"
                      data-size="sm"
                      aria-disabled={done[aid] || undefined}
                      onClick={() => !done[aid] && onAction(aid)}
                    >
                      {done[aid] ? t('assistant.actionDone', { label }) : label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {showCall && developer ? (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  className="ax-call"
                  onClick={() =>
                    setCall({
                      path: assistant.turnPath,
                      request: entry
                        ? entry.request
                        : {
                            message: previousUser(i) || t('assistant.previousMessage'),
                            intent: 'chat',
                          },
                      response: entry?.turn ?? exampleResponse(m, cardFor),
                    })
                  }
                >
                  <Icon d={icons.code} size={16} />
                  {t('assistant.showApiCall')}
                </Button>
              ) : null}
            </div>
          );
        })}
        {pending ? (
          <span role="status" className="typing">
            <Spinner aria-hidden="true" data-size="xs" />
            {t('assistant.typing')}
          </span>
        ) : null}
      </div>
      <div className="assistant-compose">
        {off || empty || !suggestions.length ? null : (
          <div className="tag-row">
            {suggestions.map((s) => (
              <Chip.Button key={s} data-size="sm" onClick={() => onSend(s)}>
                {s}
              </Chip.Button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="compose-form">
          <Field className="compose-field">
            <Label htmlFor="til-assistenten" className="visually-hidden">
              {t('assistant.composerLabel')}
            </Label>
            <Textarea
              id="til-assistenten"
              rows={1}
              placeholder={t('assistant.composerPlaceholder')}
              value={composer}
              disabled={off}
              onChange={(e) => onComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend(composer);
                }
              }}
            />
          </Field>
          <Button
            variant={ready ? 'primary' : 'tertiary'}
            {...(ready ? {} : { 'data-color': 'neutral' })}
            icon
            data-size="sm"
            type="submit"
            className="compose-send"
            aria-label={t('assistant.send')}
            aria-disabled={!ready || undefined}
          >
            <Icon d={sendArrow} size={22} />
          </Button>
        </form>
      </div>
      {call ? <MessageApiCall call={call} onClose={() => setCall(null)} /> : null}
    </aside>
  );
};
