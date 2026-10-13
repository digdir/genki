import { Alert, Button, Paragraph, Spinner, Tag } from '@digdir/designsystemet-react';
import { useId } from 'react';
import { useT } from '../../../i18n';
import type { TestDecision, TestSuggestions } from './useAssistant';

export const SuggestedTests = ({
  state,
  off,
  onSuggest,
  onDecide,
}: {
  state: TestSuggestions;
  off: boolean;
  onSuggest: () => void;
  onDecide: (id: string, decision: TestDecision | undefined) => void;
}) => {
  const t = useT();
  const heading = useId();
  if (state.status !== 'open')
    return (
      <div className="ax-row">
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={off || state.status === 'busy' || undefined}
          onClick={() => !off && state.status === 'idle' && onSuggest()}
        >
          {t('assistant.suggestTests')}
        </Button>
        {state.status === 'busy' ? (
          <span role="status" className="ax-spinner-line">
            <Spinner aria-hidden data-size="xs" />
            {t('assistant.suggestTestsBusy')}
          </span>
        ) : null}
      </div>
    );
  const values = Object.values(state.decisions);
  const sent = values.filter((d) => d === 'sent').length;
  const rejected = values.filter((d) => d === 'rejected').length;
  return (
    <section aria-labelledby={heading} className="ax-suggestion-panel">
      <div className="ax-row">
        <Tag data-size="sm" data-color="info">
          {t('assistant.fromAssistant')}
        </Tag>
        <h3 id={heading} className="ax-heading">
          {t('assistant.suggestedTests')}
        </h3>
      </div>
      <p className="ax-card-text">{state.intro}</p>
      <ul className="ax-test-list">
        {state.cases.map((c) => {
          const decision = state.decisions[c.id];
          return (
            <li key={c.id}>
              <span className="ax-test-text">
                <strong>{c.input}</strong>
                <span>{t('assistant.expected', { expected: c.expected })}</span>
                {c.source ? (
                  <span className="meta">{t('assistant.fromSource', { source: c.source })}</span>
                ) : null}
              </span>
              {decision === 'sending' ? (
                <span role="status" className="ax-spinner-line">
                  <Spinner aria-hidden data-size="xs" />
                  {t('assistant.sending')}
                </span>
              ) : decision === 'sent' ? (
                <span className="ax-row">
                  <Tag data-size="sm" data-color="success">
                    {t('assistant.accepted')}
                  </Tag>
                  <span className="meta">{t('assistant.sentToSet')}</span>
                </span>
              ) : decision ? (
                <span className="ax-row">
                  <Tag data-size="sm" data-color={decision === 'failed' ? 'success' : 'neutral'}>
                    {t(decision === 'failed' ? 'assistant.accepted' : 'assistant.rejectedTest')}
                  </Tag>
                  {decision === 'failed' ? (
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-label={t('assistant.retryLabel', { input: c.input })}
                      onClick={() => onDecide(c.id, 'accepted')}
                    >
                      {t('assistant.retry')}
                    </Button>
                  ) : null}
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-label={t('assistant.undoTestLabel', { input: c.input })}
                    onClick={() => onDecide(c.id, undefined)}
                  >
                    {t('assistant.undo')}
                  </Button>
                </span>
              ) : (
                <span className="ax-row">
                  <Button
                    variant="secondary"
                    data-size="sm"
                    aria-label={t('assistant.acceptLabel', { input: c.input })}
                    onClick={() => onDecide(c.id, 'accepted')}
                  >
                    {t('assistant.accept')}
                  </Button>
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-label={t('assistant.rejectLabel', { input: c.input })}
                    onClick={() => onDecide(c.id, 'rejected')}
                  >
                    {t('assistant.reject')}
                  </Button>
                </span>
              )}
              {decision === 'failed' ? (
                <Alert data-color="danger" data-size="sm" className="ax-test-alert">
                  <Paragraph data-size="sm">{t('assistant.sendFailed')}</Paragraph>
                </Alert>
              ) : null}
            </li>
          );
        })}
      </ul>
      {sent ? <p className="ax-card-text">{t('assistant.testsSentNote')}</p> : null}
      <span role="status" className="ax-card-text">
        {sent || rejected ? t('assistant.testsTally', { sent, rejected }) : ''}
      </span>
    </section>
  );
};
