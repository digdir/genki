import { Paragraph } from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { ReasonField } from '../components/ReasonField';
import { useT, type PlainKey } from '../i18n';
import { minimumReasonLength } from '../reason';
import { EmptyState, ErrorState, Loading } from '../states';
import type { OperatorFlag, Tenant } from '../types';
import { DialogError, Flash, ReasonDialog, useFlash } from '../ui';
import './platform.css';

type Row = OperatorFlag['rows'][number];

const flagNames: Record<string, PlainKey> = { blockStudio: 'flags.nameBlockStudio' };

const failedText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.problem?.title ? error.problem.title : fallback;

const osloOffset = (date: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')
    ?.value.replace('GMT', '') || '+00:00';

export const endOfDay = (date: string) =>
  new Date(`${date}T23:59:59${osloOffset(date)}`).toISOString();

const osloDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(date);

const pastRemoveBy = (removeBy: string, now: Date) => removeBy < osloDay(now);

const shortDay = (iso: string, f: Format) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  }).format(new Date(iso));

const rowKey = (row: Row) =>
  `${row.tenant}/${row.person?.issuer ?? ''}/${row.person?.subject ?? ''}`;

interface Draft {
  query: string;
  tenant: Tenant | undefined;
  issuer: string;
  subject: string;
  on: boolean;
  expires: string;
  reason: string;
}

const emptyDraft: Draft = {
  query: '',
  tenant: undefined,
  issuer: '',
  subject: '',
  on: true,
  expires: '',
  reason: '',
};

const TenantPicker = ({
  id,
  tenants,
  draft,
  invalid,
  failed,
  onQuery,
  onPick,
}: {
  id: string;
  tenants: Tenant[] | undefined;
  draft: Draft;
  invalid: boolean;
  failed: boolean;
  onQuery: (query: string) => void;
  onPick: (tenant: Tenant) => void;
}) => {
  const t = useT();
  const [active, setActive] = useState(0);
  const q = draft.query.trim().toLowerCase();
  const matches =
    q && !draft.tenant
      ? (tenants ?? [])
          .filter((x) => x.name.toLowerCase().includes(q) || x.orgNumber.includes(q))
          .slice(0, 8)
      : [];
  const open = matches.length > 0;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = matches[active];
      if (picked) onPick(picked);
    } else if (e.key === 'Escape') {
      onQuery('');
    }
  };
  return (
    <div className="pf-field">
      <label htmlFor={`${id}-org`}>{t('flags.tenant')}</label>
      <input
        id={`${id}-org`}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={`${id}-orgs`}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-org-error` : failed ? `${id}-org-hint` : undefined}
        {...(open ? { 'aria-activedescendant': `${id}-org-${active}` } : {})}
        value={draft.query}
        onChange={(e) => {
          setActive(0);
          onQuery(e.target.value);
        }}
        onKeyDown={onKey}
      />
      {invalid ? (
        <span id={`${id}-org-error`} className="pf-error">
          {t('flags.tenantMissing')}
        </span>
      ) : null}
      {failed ? (
        <span id={`${id}-org-hint`} className="pf-meta">
          {t('flags.tenantsFailed')}
        </span>
      ) : null}
      {open ? (
        <ul id={`${id}-orgs`} role="listbox" aria-label={t('flags.tenants')} className="pf-options">
          {matches.map((x, i) => (
            <li
              key={x.orgNumber}
              id={`${id}-org-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(x)}
            >
              {x.name}{' '}
              <span className="pf-meta">
                {x.status === 'paused'
                  ? t('flags.orgPaused', { orgNumber: x.orgNumber })
                  : x.orgNumber}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

const FlagCard = ({
  api,
  flag,
  tenants,
  tenantsFailed,
  now,
  onSaved,
  onClear,
}: {
  api: ApiClient;
  flag: OperatorFlag;
  tenants: Tenant[] | undefined;
  tenantsFailed: boolean;
  now: () => Date;
  onSaved: (message: string) => void;
  onClear: (row: Row) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<
    Partial<Record<'tenant' | 'person' | 'expires' | 'reason' | 'save', string>>
  >({});
  const [busy, setBusy] = useState(false);
  const name = flagNames[flag.key] ? t(flagNames[flag.key] as PlainKey) : flag.key;
  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));

  const whereOf = (row: Row) => {
    if (!row.person) return row.tenantName ?? row.tenant;
    return t('flags.personIn', {
      person: row.personName ?? `${row.person.issuer}:${row.person.subject}`,
      organisation: row.tenantName ?? row.tenant,
    });
  };

  const save = async () => {
    if (busy) return;
    const issuer = draft.issuer.trim();
    const subject = draft.subject.trim();
    const found: typeof errors = {};
    const typed = draft.query.trim();
    const orgNumber = draft.tenant?.orgNumber ?? (/^\d{9}$/.test(typed) ? typed : undefined);
    if (!orgNumber) found.tenant = t('flags.tenantMissing');
    if (Boolean(issuer) !== Boolean(subject)) found.person = t('flags.personIncomplete');
    if (draft.expires && draft.expires <= osloDay(now())) found.expires = t('flags.expiryPast');
    if (draft.reason.trim().length < minimumReasonLength)
      found.reason = t('common.reasonTooShortAudited', { min: minimumReasonLength });
    setErrors(found);
    if (!orgNumber || Object.keys(found).length) return;
    setBusy(true);
    try {
      await api.setFlag(
        flag.key,
        {
          tenant: orgNumber,
          ...(issuer ? { person: { issuer, subject } } : {}),
          on: draft.on,
          ...(draft.expires ? { expiresAt: endOfDay(draft.expires) } : {}),
        },
        draft.reason.trim(),
      );
      setDraft(emptyDraft);
      onSaved(t('flags.saved', { key: name }));
    } catch (error) {
      setErrors({ save: failedText(error, t('flags.saveFailed')) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pf-card" aria-labelledby={`${id}-h`}>
      <div className="pf-card-head">
        <h2 className="pf-h2" id={`${id}-h`}>
          {name}
        </h2>
        <span className="pf-chip">
          {t(flag.selfService ? 'flags.selfService' : 'flags.operatorOnly')}
        </span>
        {pastRemoveBy(flag.removeBy, now()) ? (
          <span className="pf-chip" data-tone="danger">
            {t('flags.overdue')}
          </span>
        ) : null}
        <span className="pf-meta">
          {t('flags.facts', {
            owner: flag.owner,
            removeBy: f.date(new Date(`${flag.removeBy}T12:00:00Z`), 'long'),
          })}
        </span>
      </div>
      {flag.rows.length === 0 ? (
        <Paragraph data-size="sm">{t('flags.offEverywhere')}</Paragraph>
      ) : (
        <div
          className="pf-region"
          tabIndex={0}
          role="region"
          aria-label={t('flags.tableLabel', { key: name })}
        >
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">{t('flags.colWhere')}</th>
                <th scope="col">{t('flags.colState')}</th>
                <th scope="col">{t('flags.colExpires')}</th>
                <th scope="col">{t('flags.colBy')}</th>
                <th scope="col">{t('flags.colReason')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('flags.colAction')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {flag.rows.map((row) => (
                <tr key={rowKey(row)}>
                  <td>
                    {row.person ? (
                      whereOf(row)
                    ) : (
                      <a
                        className="action"
                        href={`#/support-access?tenant=${encodeURIComponent(row.tenant)}`}
                      >
                        {whereOf(row)}
                      </a>
                    )}
                  </td>
                  <td>
                    <span className="pf-chip" {...(row.on ? { 'data-tone': 'ok' } : {})}>
                      {t(row.on ? 'flags.on' : 'flags.off')}
                    </span>
                  </td>
                  <td>
                    {!row.expiresAt
                      ? t('flags.noExpiry')
                      : row.expired
                        ? t('flags.expiredOn', { date: shortDay(row.expiresAt, f) })
                        : shortDay(row.expiresAt, f)}
                  </td>
                  <td>{t('flags.byAt', { by: row.byName ?? row.by, at: shortDay(row.at, f) })}</td>
                  <td>{row.reason}</td>
                  <td className="end">
                    <button
                      type="button"
                      className="pf-link"
                      aria-label={t('flags.clearLabel', {
                        where: row.personName ?? row.tenantName ?? row.tenant,
                      })}
                      onClick={() => onClear(row)}
                    >
                      {t('flags.clear')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pf-form">
        <h3 className="pf-form-title">{t('flags.switch')}</h3>
        <TenantPicker
          id={id}
          tenants={tenants}
          draft={draft}
          invalid={Boolean(errors.tenant)}
          failed={tenantsFailed}
          onQuery={(query) => set({ query, tenant: undefined })}
          onPick={(tenant) => {
            set({ query: tenant.name, tenant });
            setErrors(({ tenant: _, ...rest }) => rest);
          }}
        />
        <fieldset className="pf-group">
          <legend>
            {t('flags.person')} <span className="pf-optional">{t('flags.optional')}</span>
          </legend>
          <div className="pf-row">
            <div className="pf-field">
              <label htmlFor={`${id}-issuer`}>{t('flags.issuer')}</label>
              <input
                id={`${id}-issuer`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.issuer}
                aria-invalid={Boolean(errors.person) || undefined}
                aria-describedby={errors.person ? `${id}-person-error` : undefined}
                onChange={(e) => set({ issuer: e.target.value })}
              />
            </div>
            <div className="pf-field">
              <label htmlFor={`${id}-subject`}>{t('flags.subject')}</label>
              <input
                id={`${id}-subject`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.subject}
                aria-invalid={Boolean(errors.person) || undefined}
                aria-describedby={errors.person ? `${id}-person-error` : undefined}
                onChange={(e) => set({ subject: e.target.value })}
              />
            </div>
          </div>
          {errors.person ? (
            <span id={`${id}-person-error`} className="pf-error">
              {errors.person}
            </span>
          ) : null}
        </fieldset>
        <div className="pf-row">
          <fieldset className="pf-choice">
            <legend>{t('flags.choice')}</legend>
            <label>
              <input
                type="radio"
                name={`${id}-on`}
                checked={draft.on}
                onChange={() => set({ on: true })}
              />{' '}
              {t('flags.turnOn')}
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-on`}
                checked={!draft.on}
                onChange={() => set({ on: false })}
              />{' '}
              {t('flags.turnOff')}
            </label>
          </fieldset>
          <div className="pf-field pf-date">
            <label htmlFor={`${id}-exp`}>
              {t('flags.colExpires')} <span className="pf-optional">{t('flags.optional')}</span>
            </label>
            <input
              id={`${id}-exp`}
              type="date"
              value={draft.expires}
              aria-invalid={Boolean(errors.expires) || undefined}
              aria-describedby={errors.expires ? `${id}-exp-error` : undefined}
              onChange={(e) => set({ expires: e.target.value })}
            />
            {errors.expires ? (
              <span id={`${id}-exp-error`} className="pf-error">
                {errors.expires}
              </span>
            ) : null}
          </div>
        </div>
        <ReasonField
          single
          id={`${id}-why`}
          label={t('flags.colReason')}
          value={draft.reason}
          error={errors.reason}
          onChange={(reason) => set({ reason })}
        />
        {errors.save ? (
          <span className="pf-error" role="alert">
            {errors.save}
          </span>
        ) : null}
        <div>
          <button
            type="button"
            className="pf-button primary"
            aria-disabled={busy || undefined}
            onClick={() => void save()}
          >
            {t('flags.save')}
          </button>
        </div>
      </div>
    </section>
  );
};

export const Flags = ({ api, now = () => new Date() }: { api: ApiClient; now?: () => Date }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.flags(signal), [api]);
  const [tenantState] = useAsync((signal) => api.listTenants(signal), [api]);
  const [flags, setFlags] = useState<OperatorFlag[] | undefined>();
  const flash = useFlash();
  const [clearing, setClearing] = useState<{ flag: OperatorFlag; row: Row } | undefined>();
  const tenants = useMemo(
    () => (tenantState.status === 'ready' ? tenantState.data : undefined),
    [tenantState],
  );

  useEffect(() => {
    if (state.status === 'ready') setFlags(state.data);
  }, [state]);

  const clear = async (reason: string) => {
    if (!clearing) return;
    try {
      await api.setFlag(
        clearing.flag.key,
        {
          tenant: clearing.row.tenant,
          ...(clearing.row.person ? { person: clearing.row.person } : {}),
          on: null,
        },
        reason,
      );
    } catch (error) {
      throw new DialogError(failedText(error, t('flags.saveFailed')));
    }
    flash.show(t('flags.cleared'));
    retry();
  };

  const clearingWhere = clearing
    ? (clearing.row.personName ?? clearing.row.tenantName ?? clearing.row.tenant)
    : '';

  return (
    <>
      <h1 className="pf-title">{t('flags.title')}</h1>
      <Flash message={flash.message} />
      {!flags && state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !flags ? (
        <Loading label={t('flags.loading')} />
      ) : flags.length === 0 ? (
        <EmptyState title={t('flags.noneTitle')}>
          <Paragraph>{t('flags.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        flags.map((flag) => (
          <FlagCard
            key={flag.key}
            api={api}
            flag={flag}
            tenants={tenants}
            tenantsFailed={tenantState.status === 'error'}
            now={now}
            onSaved={(message) => {
              flash.show(message);
              retry();
            }}
            onClear={(row) => {
              flash.clear();
              setClearing({ flag, row });
            }}
          />
        ))
      )}
      <ReasonDialog
        open={clearing !== undefined}
        title={t('flags.clearLabel', { where: clearingWhere })}
        text={clearing ? t('flags.clearText', { where: clearingWhere }) : ''}
        confirmLabel={t('flags.clear')}
        onClose={() => setClearing(undefined)}
        onConfirm={clear}
      />
    </>
  );
};
