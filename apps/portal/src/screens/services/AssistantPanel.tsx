import { ArrowUpIcon, PaperplaneIcon } from '@navikt/aksel-icons';
import { Button, Chip, Field, Label, Paragraph, Tag, Textarea } from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssistantProposal, ProposalDecision } from '../../api/assistant';
import { Icon } from '../../components/Icon';
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
import {
  isAlternative,
  proposalKey,
  type AssistantController,
  type TurnEntry,
} from './assistant/useAssistant';
import './assistant/assistant.css';

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
  /** Beside the Oppsett form: the chat's writing box, and no introduction. */
  chat?: boolean;
}

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
  chat = false,
}: Props) => {
  const t = useT();
  const side = chat;
  const log = useRef<HTMLDivElement>(null);
  const [policyDone, setPolicyDone] = useState<Record<string, boolean>>({});
  const { availability, entries, streaming } = assistant;
  const pending = assistant.pending || typing;
  const off = availability.kind !== 'ready';
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length, pending, entries]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend(composer);
  };

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
    <aside
      aria-label={t('assistant.title')}
      className="assistant"
      // Before the first message the heading and what the assistant is for stand together in the middle.
      data-empty={(chat && messages.length === 0 && !pending) || undefined}
    >
      <div className="assistant-head">
        <h2 className="assistant-title">{t('assistant.title')}</h2>
        {side ? null : <span className="meta">{t('assistant.tagline')}</span>}
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
        {chat && messages.length === 0 && !pending ? (
          <Paragraph data-size="sm" className="assistant-welcome">
            {t('assistant.chatWelcome')}
          </Paragraph>
        ) : null}
        {messages.map((m, i) => {
          const user = m.role === 'user';
          const entry = m.turn ? entries[m.turn] : undefined;
          return (
            <div key={i} className={user ? 'msg msg-user' : 'msg msg-assistant'}>
              <span className={side ? 'visually-hidden' : 'msg-who'}>
                {user ? userName : t('assistant.assistantName')}
              </span>
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
            </div>
          );
        })}
        {pending ? (
          <span role="status" className="typing">
            {t('assistant.typing')}
          </span>
        ) : null}
      </div>
      <div className="assistant-compose">
        {off || side ? null : (
          <div className="tag-row">
            {suggestions.map((s) => (
              <Chip.Button key={s} data-size="sm" onClick={() => onSend(s)}>
                {s}
              </Chip.Button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className={chat ? 'compose-form compose-chat' : 'compose-form'}>
          <Field className="compose-field">
            <Label
              htmlFor="til-assistenten"
              data-size="sm"
              className={side ? 'visually-hidden' : undefined}
            >
              {t('assistant.composerLabel')}
            </Label>
            <Textarea
              id="til-assistenten"
              rows={chat ? 3 : side ? 1 : 2}
              {...(side ? { placeholder: t('assistant.sidePlaceholder') } : {})}
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
          {chat ? (
            <Button
              variant={composer.trim() && !pending && !streaming && !off ? 'primary' : 'tertiary'}
              {...(composer.trim() ? {} : { 'data-color': 'neutral' })}
              icon
              type="submit"
              aria-label={t('assistant.send')}
              aria-disabled={!composer.trim() || pending || streaming || off || undefined}
            >
              <Icon icon={ArrowUpIcon} size={20} />
            </Button>
          ) : side ? (
            <Button
              variant="tertiary"
              icon
              type="submit"
              aria-label={t('assistant.send')}
              aria-disabled={pending || streaming || off || undefined}
            >
              <Icon icon={PaperplaneIcon} size={20} />
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              aria-disabled={pending || streaming || off || undefined}
            >
              {t('assistant.send')}
            </Button>
          )}
        </form>
      </div>
    </aside>
  );
};
