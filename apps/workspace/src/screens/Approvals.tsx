import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Spinner,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { AsyncState } from '../hooks';
import { useT } from '../i18n';
import type { Approval, Decision } from '../types';

export interface Resolved {
  approval: Approval;
  decision: Decision;
}

interface Props {
  state: AsyncState<Approval[]>;
  done: Resolved[];
  onRetry: () => void;
  onResolve: (approval: Approval, decision: Decision, comment: string) => Promise<void>;
  onFlash: (message: string) => void;
}

const preview = (text: string) => `${(text.split('\n')[0] ?? '').slice(0, 110)}…`;
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const Detail = ({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (decision: Decision, comment: string) => Promise<void>;
}) => {
  const t = useT();
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  const decide = async (decision: Decision) => {
    if (busy) return;
    if (decision === 'rejected' && !comment.trim()) {
      setError(t('approvals.writeWhy'));
      field.current?.focus();
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await onDecide(decision, comment.trim());
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="detail">
      <Heading level={2} data-size="xs" id="detail-heading" tabIndex={-1}>
        {approval.title}
      </Heading>
      <dl className="facts">
        <dt>{t('approvals.service')}</dt>
        <dd>{approval.service}</dd>
        <dt>{t('approvals.case')}</dt>
        <dd>{approval.caseNumber}</dd>
        <dt>{t('approvals.due')}</dt>
        <dd>{capitalise(approval.due)}</dd>
        <dt>{t('approvals.assigned')}</dt>
        <dd>{approval.assignedTo}</dd>
      </dl>
      <div className="draft-box">
        <Tag data-size="sm" data-color="warning" className="answer-tag">
          {t('approvals.aiDraft')}
        </Tag>
        <p className="draft-text">{approval.text}</p>
      </div>
      <a href={approval.basisUrl} className="basis-link">
        {t('approvals.basis')}
      </a>
      <Field>
        <Label htmlFor="approval-comment">{t('approvals.comment')}</Label>
        <Paragraph id="approval-comment-help" data-size="sm" className="subtle-sm">
          {t('approvals.commentHelp')}
        </Paragraph>
        <Textarea
          id="approval-comment"
          ref={field}
          rows={3}
          value={comment}
          aria-describedby={
            error ? 'approval-comment-help approval-comment-error' : 'approval-comment-help'
          }
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setComment(e.target.value);
            setError('');
          }}
        />
        {error ? <ValidationMessage id="approval-comment-error">{error}</ValidationMessage> : null}
      </Field>
      {failed ? (
        <Alert data-color="danger" data-size="sm">
          {t('approvals.notSaved')}
        </Alert>
      ) : null}
      <div className="actions">
        <Button aria-disabled={busy || undefined} onClick={() => void decide('approved')}>
          {t('approvals.approve')}
        </Button>
        <Button
          variant="secondary"
          aria-disabled={busy || undefined}
          onClick={() => void decide('rejected')}
        >
          {t('approvals.reject')}
        </Button>
      </div>
      <Paragraph data-size="sm" className="subtle-sm">
        {t('approvals.accountability')}
      </Paragraph>
    </div>
  );
};

export const Approvals = ({ state, done, onRetry, onResolve, onFlash }: Props) => {
  const t = useT();
  const pending = state.status === 'ready' ? state.data : [];
  const [selectedId, setSelectedId] = useState<string>();
  const selected =
    pending.find((a) => a.id === selectedId) ?? (selectedId ? undefined : pending[0]);
  const focusDetail = useRef(false);

  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    document.getElementById('detail-heading')?.focus();
  });

  const decide = async (approval: Approval, decision: Decision, comment: string) => {
    await onResolve(approval, decision, comment);
    const next = pending.find((a) => a.id !== approval.id);
    setSelectedId(next?.id ?? '');
    focusDetail.current = true;
    onFlash(
      decision === 'approved'
        ? t('approvals.approved', { title: approval.title })
        : t('approvals.rejected', { title: approval.title }),
    );
  };

  return (
    <div className="inbox">
      <section aria-labelledby="inbox-heading" className="inbox-list">
        <div>
          <Heading level={2} data-size="sm" id="inbox-heading">
            {t('approvals.heading')}
          </Heading>
          <Paragraph data-size="sm" className="subtle-sm">
            {t('approvals.intro')}
          </Paragraph>
        </div>
        {state.status === 'loading' ? (
          <div role="status" className="state">
            <Spinner aria-label={t('approvals.loading')} data-size="md" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm" className="alert-title">
              {t('approvals.loadFailed')}
            </Paragraph>
            <Paragraph data-size="sm">{t('approvals.notYourFault')}</Paragraph>
            <Button variant="secondary" data-size="sm" className="alert-action" onClick={onRetry}>
              {t('approvals.tryAgain')}
            </Button>
          </Alert>
        ) : null}
        {state.status === 'ready' && pending.length === 0 ? (
          <div className="empty">
            <Paragraph className="empty-title">{t('approvals.empty')}</Paragraph>
            <Paragraph data-size="sm" className="subtle-sm">
              {t('approvals.emptyText')}
            </Paragraph>
          </div>
        ) : null}
        {pending.length ? (
          <ul className="inbox-items">
            {pending.map((a) => {
              const active = a.id === selected?.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    className={active ? 'inbox-item active' : 'inbox-item'}
                    aria-pressed={active}
                    onClick={() => setSelectedId(a.id)}
                  >
                    <span className="inbox-meta">
                      <Tag data-size="sm" data-color={a.dueColor}>
                        {t('approvals.dueTag', { due: a.due })}
                      </Tag>
                      <span className="subtle-xs">
                        {t('approvals.meta', { service: a.service, caseNumber: a.caseNumber })}
                      </span>
                    </span>
                    <span className="inbox-title">{a.title}</span>
                    <span className="subtle-sm">{preview(a.text)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {done.length ? (
          <div className="done">
            <h2 className="done-heading">{t('approvals.doneToday')}</h2>
            <ul>
              {done.map(({ approval, decision }) => (
                <li key={approval.id}>
                  <Tag data-size="sm" data-color={decision === 'approved' ? 'success' : 'neutral'}>
                    {decision === 'approved'
                      ? t('approvals.approvedTag')
                      : t('approvals.rejectedTag')}
                  </Tag>
                  {approval.title}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="detail-heading" className="panel">
        {selected ? (
          <Detail
            key={selected.id}
            approval={selected}
            onDecide={(decision, comment) => decide(selected, decision, comment)}
          />
        ) : (
          <Paragraph id="detail-heading" tabIndex={-1} className="subtle">
            {t('approvals.pick')}
          </Paragraph>
        )}
      </section>
    </div>
  );
};
