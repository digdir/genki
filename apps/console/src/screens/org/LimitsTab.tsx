import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { Fragment, useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import type { TenantOverview } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { reasonError } from '../../support-dialog';
import { ReasonField } from '../../components/ReasonField';
import { millions, orgHref, parseAmount, shortDay } from './parts';

type Unit = 'millions' | 'count' | 'kr';

interface Limit {
  key: string;
  label: PlainKey;
  unit: Unit;
}

const sections: { title: PlainKey; limits: Limit[] }[] = [
  {
    title: 'org.sectionUse',
    limits: [
      { key: 'usage.monthlyTokens', label: 'org.limitMonthlyTokens', unit: 'millions' },
      { key: 'usage.tenantCallsPerMinute', label: 'org.limitCallsPerMinute', unit: 'count' },
    ],
  },
  {
    title: 'org.sectionBudgets',
    limits: [
      { key: 'assistant.dailyTokens', label: 'org.limitAssistantTokens', unit: 'count' },
      { key: 'batch.approvalLimitNok', label: 'org.limitBatchApproval', unit: 'kr' },
    ],
  },
];

const shown = (value: unknown, unit: Unit, f: Format, t: T) => {
  if (typeof value !== 'number') return t('org.none');
  if (unit === 'millions') return t('org.millions', { amount: millions(value, f) });
  if (unit === 'kr') return t('org.kr', { amount: f.number(value) });
  return f.number(value);
};

const draftOf = (value: unknown, unit: Unit) =>
  typeof value !== 'number' ? '' : String(unit === 'millions' ? value / 1_000_000 : value);

const parse = (draft: string, unit: Unit, f: Format) => {
  const n = parseAmount(draft, f);
  if (n === undefined || n < 0) return undefined;
  const value = unit === 'millions' ? Math.round(n * 1_000_000) : n;
  return Number.isInteger(value) ? value : undefined;
};

interface Editing {
  limit: Limit;
  step: 'edit' | 'check';
  draft: string;
  reason: string;
  draftError?: string | undefined;
  reasonError?: string | undefined;
  failed?: string | undefined;
  busy?: boolean;
}

const QuotaCard = ({ overview }: { overview: TenantOverview }) => {
  const t = useT();
  const f = useFormat();
  const now = new Date();
  const tokens = overview.tokens;
  const resets = shortDay(new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(), f);
  if (!tokens) return <p className="org-subtle">{t('org.noQuota')}</p>;
  const percent = Math.round(tokens.usedPercent);
  const forecastPercent = Math.min(100, (tokens.forecastTokens / tokens.monthlyTokens) * 100);
  const used = millions(tokens.usedTokens, f);
  const forecast = millions(tokens.forecastTokens, f);
  const quota = millions(tokens.monthlyTokens, f);
  return (
    <section aria-labelledby="org-quota" className="org-card">
      <div className="org-section-head">
        <h2 id="org-quota">{t('org.quotaTitle', { month: f.month(now) })}</h2>
        <span className="org-subtle">{t('org.quotaResets', { date: resets })}</span>
      </div>
      <p className="org-big">
        {used} <span className="of">{t('org.quotaOf', { quota, percent })}</span>
      </p>
      <div className="org-bar" role="img" aria-label={t('org.quotaBar', { used, forecast, quota })}>
        <div className="forecast" style={{ width: `${forecastPercent}%` }} />
        <div className="used" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="org-legend">
        <span>
          <span aria-hidden="true" className="swatch used" />
          {t('org.quotaUsed', { used })}
        </span>
        <span>
          <span aria-hidden="true" className="swatch forecast" />
          {t('org.quotaForecast', { forecast })}
        </span>
        <a href={orgHref(overview.orgNumber, 'usage')}>{t('org.seeUsage')}</a>
      </div>
    </section>
  );
};

export const LimitsTab = ({
  api,
  tenant,
  overview,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  name: string;
  overview: TenantOverview;
  onChanged: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, effective] = await Promise.all([
        api.settingsCatalog(signal),
        api.tenantSettings(tenant, signal),
      ]);
      return { catalog, effective };
    },
    [api, tenant],
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState<Editing | undefined>();
  const [saved, setSaved] = useState<{ limit: Limit; value: unknown; reason: string }>();
  const [logged, setLogged] = useState<string[]>([]);

  if (state.status === 'loading') return <Loading label={t('org.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { catalog, effective } = state.data;
  const known = new Set(catalog.map((s) => s.key));
  const valueOf = (key: string) =>
    key in values
      ? values[key]
      : (effective[key]?.value ??
        (key === 'usage.monthlyTokens' ? overview.tokens?.monthlyTokens : undefined) ??
        catalog.find((s) => s.key === key)?.default);
  const defaultOf = (key: string) => catalog.find((s) => s.key === key)?.default;
  const update = (patch: Partial<Editing>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  const check = () => {
    if (!editing) return;
    const value = parse(editing.draft, editing.limit.unit, f);
    const problem = reasonError(t, editing.reason);
    update({
      draftError: value === undefined ? t('org.numberInvalid') : undefined,
      reasonError: problem,
      failed: undefined,
    });
    if (value !== undefined && !problem) update({ step: 'check' });
  };

  const save = async () => {
    if (!editing || editing.busy) return;
    const value = parse(editing.draft, editing.limit.unit, f);
    if (value === undefined) return;
    const reason = editing.reason.trim();
    update({ busy: true, failed: undefined });
    try {
      await api.setTenantSetting(tenant, editing.limit.key, value, reason);
    } catch (e) {
      update({
        busy: false,
        failed: e instanceof ApiError && e.problem?.title ? e.problem.title : t('org.saveFailed'),
      });
      return;
    }
    setValues((v) => ({ ...v, [editing.limit.key]: value }));
    setLogged((l) => [...l.filter((k) => k !== editing.limit.key), editing.limit.key]);
    setSaved({ limit: editing.limit, value, reason });
    setEditing(undefined);
    onChanged();
  };

  return (
    <>
      <div aria-live="polite">
        {saved ? (
          <p role="status" className="org-status">
            {t('org.savedStatus', {
              limit: t(saved.limit.label),
              value: shown(saved.value, saved.limit.unit, f, t),
              name: api.actor() ?? '',
              reason: saved.reason,
            })}{' '}
            <a href={orgHref(tenant, 'log')}>{t('org.seeInLog')}</a>
          </p>
        ) : null}
      </div>
      <QuotaCard overview={overview} />
      {sections.map((section, si) => {
        const limits = section.limits.filter((l) => known.has(l.key));
        if (limits.length === 0) return null;
        return (
          <section key={section.title} className="org-section" aria-labelledby={`${id}-s${si}`}>
            <h2 id={`${id}-s${si}`}>{t(section.title)}</h2>
            <div className="org-table-wrap">
              <table className="org-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: '40%' }}>
                      {t('org.colLimit')}
                    </th>
                    <th scope="col">{t('org.colValue')}</th>
                    <th scope="col">{t('org.colDefault')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('org.colAction')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {limits.map((limit) => {
                    const label = t(limit.label);
                    const open = editing?.limit.key === limit.key ? editing : undefined;
                    const inputId = `${id}-${limit.key}`;
                    return (
                      <Fragment key={limit.key}>
                        <tr>
                          <th scope="row">{label}</th>
                          <td className="strong">
                            {shown(valueOf(limit.key), limit.unit, f, t)}
                            {logged.includes(limit.key) ? (
                              <span className="org-saved">{t('org.logged')}</span>
                            ) : null}
                          </td>
                          <td className="subtle">
                            {shown(defaultOf(limit.key), limit.unit, f, t)}
                          </td>
                          <td className="end">
                            {open ? null : (
                              <button
                                type="button"
                                className="org-link-btn"
                                aria-label={t('org.editLabel', { limit: label.toLowerCase() })}
                                onClick={() =>
                                  setEditing({
                                    limit,
                                    step: 'edit',
                                    draft: draftOf(valueOf(limit.key), limit.unit),
                                    reason: '',
                                  })
                                }
                              >
                                {t('org.edit')}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open ? (
                          <tr>
                            <td colSpan={4} className="org-edit-cell">
                              {open.step === 'edit' ? (
                                <div className="org-edit">
                                  <div className="org-field">
                                    <label htmlFor={inputId}>{label}</label>
                                    <div className="org-inline">
                                      <input
                                        id={inputId}
                                        className="org-input"
                                        type="text"
                                        inputMode="numeric"
                                        style={{ width: 160 }}
                                        value={open.draft}
                                        aria-invalid={open.draftError ? true : undefined}
                                        aria-describedby={
                                          open.draftError ? `${inputId}-e` : undefined
                                        }
                                        onChange={(e) =>
                                          update({ draft: e.target.value, draftError: undefined })
                                        }
                                      />
                                      <button
                                        type="button"
                                        className="org-link-btn"
                                        onClick={() =>
                                          update({
                                            draft: draftOf(defaultOf(limit.key), limit.unit),
                                            draftError: undefined,
                                          })
                                        }
                                      >
                                        {t('org.useDefault')}
                                      </button>
                                    </div>
                                    {open.draftError ? (
                                      <span id={`${inputId}-e`} className="error">
                                        {open.draftError}
                                      </span>
                                    ) : null}
                                  </div>
                                  <ReasonField
                                    description={t('org.reasonSeen')}
                                    value={open.reason}
                                    error={open.reasonError}
                                    onChange={(reason) =>
                                      update({ reason, reasonError: undefined })
                                    }
                                  />
                                  <div className="org-actions">
                                    <button
                                      type="button"
                                      className="org-btn primary"
                                      onClick={check}
                                    >
                                      {t('org.check')}
                                    </button>
                                    <button
                                      type="button"
                                      className="org-btn"
                                      onClick={() => setEditing(undefined)}
                                    >
                                      {t('org.cancel')}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="org-edit">
                                  <p style={{ margin: 0 }}>
                                    <strong>{label}</strong>{' '}
                                    {t('org.change', {
                                      from: shown(valueOf(limit.key), limit.unit, f, t),
                                      to: shown(parse(open.draft, limit.unit, f), limit.unit, f, t),
                                    })}
                                  </p>
                                  {open.failed ? (
                                    <p role="alert" className="error" style={{ margin: 0 }}>
                                      {open.failed}
                                    </p>
                                  ) : null}
                                  <div className="org-actions">
                                    <button
                                      type="button"
                                      className="org-btn primary"
                                      aria-disabled={open.busy || undefined}
                                      onClick={() => void save()}
                                    >
                                      {t('org.save')}
                                    </button>
                                    <button
                                      type="button"
                                      className="org-btn"
                                      onClick={() => update({ step: 'edit' })}
                                    >
                                      {t('org.back')}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
};
