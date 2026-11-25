import {
  Alert,
  Button,
  Dialog,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { quotaRequestPendingType } from '../../api/quota-requests';
import { reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT, type Format } from '../../i18n';
import {
  extraOptions,
  pendingRequest,
  latestDecision,
  requestedTokens,
  type AmountChoice,
  type QuotaFacts,
} from './model';
import './quota.css';

const millions = (f: Format, tokens: number) =>
  f.number(tokens / 1_000_000, { maximumFractionDigits: 1 });

interface DialogProps {
  api: Pick<ApiClient, 'quotaRequests'>;
  tenant: string;
  facts: QuotaFacts;
  forecast: number;
  month: string;
  onClose: () => void;
}

export const QuotaRequestDialog = ({
  api,
  tenant,
  facts,
  forecast,
  month,
  onClose,
}: DialogProps) => {
  const t = useT();
  const f = useFormat();
  const ids = { amount: useId(), other: useId() };
  const [choice, setChoice] = useState<AmountChoice>();
  const [other, setOther] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(false);
  const current = facts.quota / 1_000_000;
  const picked: AmountChoice | undefined =
    choice?.kind === 'other' ? { kind: 'other', text: other } : choice;
  const amount = requestedTokens(facts.quota, picked);
  const amountError = !tried
    ? undefined
    : amount.error === 'pick'
      ? t('quotaRequest.pickAmount')
      : amount.error === 'tooLow'
        ? t('quotaRequest.otherTooLow', {
            quota: f.number(current),
            example: f.number(Math.round(current * 2.4)),
          })
        : undefined;
  const reasonError = tried ? reasonProblem(reason, t) : undefined;
  const dirty = choice !== undefined || other.trim() !== '' || reason.trim() !== '';
  const requestClose = () => {
    if (done || !dirty) onClose();
    else setConfirm(true);
  };
  const send = async () => {
    if (busy) return;
    setTried(true);
    if (amount.tokens === undefined || reasonProblem(reason, t)) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.quotaRequests.create(tenant, amount.tokens, reason.trim());
      setDone(true);
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.problem?.type === quotaRequestPendingType
          ? t('quotaRequest.alreadyPending')
          : t('quotaRequest.failed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modal
      closeButton={false}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      aria-labelledby="quota-request-h"
      className="int-dialog quota-dialog"
    >
      <div className="stack-dialog stack-sm">
        <div className="int-dialog-head">
          <Heading level={2} data-size="xs" id="quota-request-h">
            {t('quotaRequest.title')}
          </Heading>
          <Button variant="tertiary" data-size="sm" onClick={requestClose}>
            {t('common.close')}
          </Button>
        </div>
        {done ? (
          <>
            <Alert data-color="success" role="status">
              <strong>{t('quotaRequest.doneTitle')}</strong> {t('quotaRequest.doneText')}
            </Alert>
            <div className="actions">
              <Button variant="primary" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <dl className="kv quota-facts">
              <dt>{t('quotaRequest.current')}</dt>
              <dd>{t('quotaRequest.tokens', { value: millions(f, facts.quota) })}</dd>
              <dt>{t('quotaRequest.usedIn', { month })}</dt>
              <dd>
                {t('quotaRequest.usedValue', { value: millions(f, facts.used), pct: facts.pct })}
              </dd>
              <dt>{t('quotaRequest.expected')}</dt>
              <dd>{t('quotaRequest.expectedValue', { value: millions(f, forecast) })}</dd>
            </dl>
            <Fieldset aria-describedby={amountError ? ids.amount : undefined}>
              <Fieldset.Legend>{t('quotaRequest.amountLegend')}</Fieldset.Legend>
              <Fieldset.Description>
                {t('quotaRequest.amountHelp', { quota: f.number(current) })}
              </Fieldset.Description>
              {extraOptions(facts.quota).map((extra) => (
                <Radio
                  key={extra}
                  name="quota-amount"
                  value={String(extra)}
                  label={t('quotaRequest.option', {
                    extra: f.number(extra),
                    total: f.number(Math.round(current + extra)),
                  })}
                  checked={choice?.kind === 'extra' && choice.millions === extra}
                  onChange={() => setChoice({ kind: 'extra', millions: extra })}
                />
              ))}
              <Radio
                name="quota-amount"
                value="other"
                label={t('quotaRequest.other')}
                checked={choice?.kind === 'other'}
                onChange={() => setChoice({ kind: 'other', text: other })}
              />
              {choice?.kind === 'other' ? (
                <Textfield
                  id={ids.other}
                  label={t('quotaRequest.otherLabel')}
                  inputMode="decimal"
                  className="quota-other"
                  value={other}
                  aria-invalid={amountError ? true : undefined}
                  onChange={(e) => setOther(e.target.value)}
                />
              ) : null}
              {amountError ? (
                <p id={ids.amount} className="quota-error" role="alert">
                  {amountError}
                </p>
              ) : null}
            </Fieldset>
            <Textfield
              multiline
              rows={3}
              label={t('quotaRequest.reasonLabel')}
              value={reason}
              error={reasonError}
              aria-invalid={reasonError ? true : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            <Paragraph data-size="sm" className="meta">
              {t('quotaRequest.note')}
            </Paragraph>
            {confirm ? (
              <Alert data-color="warning" data-size="sm" role="alert">
                {t('quotaRequest.discardAsk')}
                <div className="actions">
                  <Button data-size="sm" variant="primary" onClick={onClose}>
                    {t('quotaRequest.discard')}
                  </Button>
                  <Button data-size="sm" variant="secondary" onClick={() => setConfirm(false)}>
                    {t('quotaRequest.keepWriting')}
                  </Button>
                </div>
              </Alert>
            ) : null}
            {failure ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {failure}
              </Alert>
            ) : null}
            <div className="actions">
              <Button
                variant="primary"
                aria-disabled={busy || undefined}
                onClick={() => void send()}
              >
                {busy ? t('quotaRequest.sending') : t('quotaRequest.send')}
              </Button>
              <Button variant="secondary" onClick={requestClose}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
};

export const QuotaRequestAction = ({
  api,
  tenant,
  facts,
  forecast,
  month,
  canRequest,
  fallback = null,
}: Omit<DialogProps, 'onClose'> & { canRequest: boolean; fallback?: ReactNode }) => {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [requests, reload] = useAsync(
    (signal) => api.quotaRequests.list(tenant, signal),
    [api, tenant],
  );
  const pending = requests.status === 'ready' ? pendingRequest(requests.data) : undefined;
  if (requests.status === 'loading') return null;
  if (pending)
    return (
      <span className="meta quota-pending" role="status">
        {t('quotaRequest.pending', {
          amount: millions(f, pending.monthlyTokens),
          when: f.dateTime(pending.requestedAt),
        })}
      </span>
    );
  const decided = requests.status === 'ready' ? latestDecision(requests.data) : undefined;
  const decision = decided?.decision ? (
    <span className="meta quota-pending" role="status">
      {decided.state === 'approved'
        ? t('quotaRequest.approved', {
            amount: millions(f, decided.monthlyTokens),
            when: f.dateTime(decided.decision.at),
          })
        : t('quotaRequest.rejected', {
            when: f.dateTime(decided.decision.at),
            reason: decided.decision.reason,
          })}
    </span>
  ) : null;
  if (!canRequest)
    return (
      <>
        {decision}
        {fallback}
      </>
    );
  return (
    <>
      {decision}
      <Button variant="tertiary" data-size="sm" onClick={() => setOpen(true)}>
        {t('quotaRequest.open')}
      </Button>
      {open ? (
        <QuotaRequestDialog
          api={api}
          tenant={tenant}
          facts={facts}
          forecast={forecast}
          month={month}
          onClose={() => {
            setOpen(false);
            reload();
          }}
        />
      ) : null}
    </>
  );
};
