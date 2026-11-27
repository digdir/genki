import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { reasonError } from '../../support-dialog';
import { ReasonField } from '../../components/ReasonField';
import { daysBetween, millions, orgHref, parseAmount, shortDay } from '../org/parts';

type Verb = 'approved' | 'rejected' | 'postponed';

const quotaKey = 'usage.monthlyTokens';

const tomorrow = (now: Date) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface QuotaDone {
  verb: Verb;
  tenant: string;
  tenantName: string;
  amount?: number;
  until?: string;
  reason: string;
}

export const QuotaPanel = ({
  api,
  tenant,
  id,
  onClose,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  onClose: () => void;
  onDone: (done: QuotaDone) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const now = new Date();
  const panel = useRef<HTMLElement>(null);
  const [state, retry] = useAsync(
    async (signal) => {
      const [requests, overview, catalog] = await Promise.all([
        api.quotaRequests(signal, 'pending'),
        api.tenantOverview(tenant, signal).catch(() => undefined),
        api.settingsCatalog(signal).catch(() => []),
      ]);
      return {
        request: requests.find((r) => r.tenant === tenant && r.id === id),
        overview,
        standard: catalog.find((s) => s.key === quotaKey)?.default,
      };
    },
    [api, tenant, id],
  );
  const [verb, setVerb] = useState<Verb>('approved');
  const [amount, setAmount] = useState<string | undefined>();
  const [until, setUntil] = useState(() => tomorrow(now));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{
    amount?: string | undefined;
    until?: string | undefined;
    reason?: string | undefined;
  }>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const ready = state.status === 'ready';
  useEffect(() => {
    if (ready) panel.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [ready]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const head = (eyebrow: string | undefined, name: string) => (
    <div className="inbox-panel-head">
      <div>
        {eyebrow ? (
          <span className="org-subtle" style={{ fontSize: 14 }}>
            {eyebrow}
          </span>
        ) : null}
        <h2 id={`${uid}-h`} tabIndex={-1}>
          <a href={orgHref(tenant)}>{name}</a>
        </h2>
      </div>
      <a
        href="#/queue"
        className="org-strong-link"
        style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', padding: '0 4px' }}
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        {t('inbox.close')}
      </a>
    </div>
  );

  const content = () => {
    if (state.status === 'loading') return <Loading label={t('inbox.loading')} />;
    if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
    const { request, overview, standard } = state.data;
    if (!request)
      return (
        <>
          {head(undefined, overview?.name ?? tenant)}
          <p>{t('inbox.requestGone')}</p>
        </>
      );
    const has = request.quota?.monthlyTokens ?? overview?.tokens?.monthlyTokens;
    const used = request.quota?.usedTokens ?? overview?.tokens?.usedTokens;
    const percent = used !== undefined && has ? Math.round((used / has) * 100) : undefined;
    const draft =
      amount ??
      f.number(request.monthlyTokens / 1_000_000, { maximumFractionDigits: 6, useGrouping: false });
    const parsedAmount =
      amount === undefined ? request.monthlyTokens / 1_000_000 : parseAmount(draft, f);
    const hint =
      verb === 'approved'
        ? t('inbox.hintApprove')
        : verb === 'rejected'
          ? t('inbox.hintReject')
          : t('inbox.hintPostpone');
    const cta =
      verb === 'approved'
        ? t('inbox.ctaApprove')
        : verb === 'rejected'
          ? t('inbox.ctaReject')
          : t('inbox.ctaPostpone');
    const submit = async () => {
      if (busy) return;
      const next: typeof errors = {};
      const problem = reasonError(t, reason);
      if (problem) next.reason = problem;
      if (verb === 'approved' && !(parsedAmount !== undefined && parsedAmount > 0))
        next.amount = t('inbox.amountInvalid');
      if (verb === 'postponed' && !(until && until >= tomorrow(new Date())))
        next.until = t('inbox.dateInvalid');
      setErrors(next);
      if (Object.keys(next).length) return;
      setBusy(true);
      setFailed(undefined);
      const tokens =
        amount === undefined ? request.monthlyTokens : Math.round((parsedAmount ?? 0) * 1_000_000);
      try {
        await api.decideQuota(
          tenant,
          id,
          verb === 'approved'
            ? { decision: 'approved', monthlyTokens: tokens }
            : verb === 'rejected'
              ? { decision: 'rejected' }
              : { decision: 'postponed', until },
          reason.trim(),
        );
      } catch (e) {
        setBusy(false);
        setFailed(
          e instanceof ApiError && e.status === 409
            ? t('inbox.requestGone')
            : e instanceof ApiError && e.problem?.title
              ? e.problem.title
              : t('inbox.decideFailed'),
        );
        return;
      }
      onDone({
        verb,
        tenant,
        tenantName: request.tenantName,
        reason: reason.trim(),
        ...(verb === 'approved' ? { amount: tokens } : {}),
        ...(verb === 'postponed' ? { until } : {}),
      });
    };
    const verbs: [Verb, string][] = [
      ['approved', t('inbox.approve')],
      ['rejected', t('inbox.reject')],
      ['postponed', t('inbox.postpone')],
    ];
    return (
      <>
        {head(
          t('inbox.panelEyebrow', { days: daysBetween(request.requestedAt, now) }),
          request.tenantName,
        )}
        <dl className="inbox-facts">
          <div>
            <dt>{t('inbox.asked')}</dt>
            <dd>{t('inbox.askedValue', { amount: millions(request.monthlyTokens, f) })}</dd>
          </div>
          <div>
            <dt>{t('inbox.hasNow')}</dt>
            <dd>
              {has === undefined ? '' : t('inbox.hasNowValue', { amount: millions(has, f) })}
              {typeof standard === 'number' ? (
                <span className="of">
                  {' '}
                  {t('inbox.standard', { amount: millions(standard, f) })}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{t('inbox.usedIn', { month: f.month(now) })}</dt>
            <dd>
              {used === undefined
                ? ''
                : t('inbox.usedValue', { amount: millions(used, f), percent: percent ?? 0 })}
            </dd>
          </div>
          <div>
            <dt>{t('inbox.forecast')}</dt>
            <dd>
              {overview?.tokens
                ? t('inbox.forecastValue', { amount: millions(overview.tokens.forecastTokens, f) })
                : ''}
            </dd>
          </div>
          <div className="full">
            <dt>
              {t('inbox.askedBy', {
                name: request.requestedByName ?? request.requestedBy,
                date: shortDay(request.requestedAt, f),
              })}
            </dt>
            <dd>{t('inbox.quoted', { text: request.reason })}</dd>
          </div>
        </dl>
        <fieldset className="inbox-verbs">
          <legend>{t('inbox.decision')}</legend>
          {verbs.map(([key, label]) => (
            <label key={key}>
              <input
                type="radio"
                name={`${uid}-verb`}
                checked={verb === key}
                onChange={() => {
                  setVerb(key);
                  setErrors({});
                  setFailed(undefined);
                }}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        {verb === 'approved' ? (
          <div className="org-field">
            <label htmlFor={`${uid}-amount`}>{t('inbox.newQuota')}</label>
            <div className="org-inline">
              <input
                id={`${uid}-amount`}
                className="org-input"
                type="text"
                inputMode="decimal"
                style={{ width: 120 }}
                value={draft}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={`${uid}-unit${errors.amount ? ` ${uid}-amount-e` : ''}`}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setErrors((x) => ({ ...x, amount: undefined }));
                }}
              />
              <span id={`${uid}-unit`} className="org-subtle">
                {t('inbox.newQuotaUnit')}
              </span>
            </div>
            {errors.amount ? (
              <span id={`${uid}-amount-e`} className="error">
                {errors.amount}
              </span>
            ) : null}
          </div>
        ) : null}
        {verb === 'postponed' ? (
          <div className="org-field">
            <label htmlFor={`${uid}-until`}>{t('inbox.postponeUntil')}</label>
            <input
              id={`${uid}-until`}
              className="org-input"
              type="date"
              style={{ width: 200 }}
              value={until}
              min={tomorrow(now)}
              aria-invalid={errors.until ? true : undefined}
              aria-describedby={errors.until ? `${uid}-until-e` : undefined}
              onChange={(e) => {
                setUntil(e.target.value);
                setErrors((x) => ({ ...x, until: undefined }));
              }}
            />
            {errors.until ? (
              <span id={`${uid}-until-e`} className="error">
                {errors.until}
              </span>
            ) : null}
          </div>
        ) : null}
        <ReasonField
          description={hint}
          rows={3}
          value={reason}
          error={errors.reason}
          onChange={(v) => {
            setReason(v);
            setErrors((x) => ({ ...x, reason: undefined }));
          }}
        />
        {verb === 'approved' && has !== undefined ? (
          <div className="inbox-change">
            <span className="label">{t('inbox.changeTitle')}</span>
            <span>
              <strong>{t('inbox.changeTokens')}</strong>{' '}
              {t('inbox.changeValue', {
                from: millions(has, f),
                to: parsedAmount === undefined ? draft : millions(parsedAmount * 1_000_000, f),
              })}
            </span>
          </div>
        ) : null}
        {failed ? (
          <p role="alert" className="error" style={{ margin: 0 }}>
            {failed}
          </p>
        ) : null}
        <div className="org-actions">
          <button
            type="button"
            className="org-btn primary"
            aria-disabled={busy || undefined}
            onClick={() => void submit()}
          >
            {cta}
          </button>
          <button type="button" className="org-btn" onClick={onClose}>
            {t('inbox.cancel')}
          </button>
        </div>
      </>
    );
  };

  return (
    <>
      <div className="inbox-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panel}
        className="inbox-panel"
        role="dialog"
        aria-modal="true"
        {...(ready ? { 'aria-labelledby': `${uid}-h` } : { 'aria-label': t('inbox.loading') })}
      >
        {content()}
      </aside>
    </>
  );
};
