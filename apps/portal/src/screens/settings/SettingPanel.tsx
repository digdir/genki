import {
  Alert,
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { actorLabel, formatDateTime } from '../../format';
import { useT, type Format, type T } from '../../i18n';
import { useAsync } from '../../hooks';
import { useRights } from '../../Shell';
import { ApiCallLink, type ApiCallPreview } from '../../components/ApiCall';
import { NotDecided } from '../../components/NotDecided';
import { SidePanel } from '../../components/SidePanel';
import {
  riskLevels as riskLevelList,
  type RiskValues,
  type SettingRow,
  type SettingValue,
} from '../../data/settings';
import { settingCall } from '../../data/api-calls';
import type { ServiceImpact } from '../../types';
import {
  allowedText,
  buildPreview,
  editLayerFor,
  effectiveOf,
  formatValue,
  isSet,
  layerName,
  layersFor,
  layerValue,
  optionText,
  parseDraft,
  riskLabel,
  scopeText,
  sensColor,
  sensText,
  toApiValue,
  typeText,
  type Change,
  settingErrorText,
  type Ctx,
  type Preview,
  type PreviewGroup,
} from './model';
import { reasonProblem } from '../../components/ReasonField';
import {
  categoryText,
  piiText,
  settingDesc,
  settingLabel,
  settingMinRisk,
  settingRule,
  unitText,
} from './text';

export interface LogEntry {
  id: string;
  when: string;
  who: string;
  what: string;
  reason: string;
}

const without = <T,>(record: Record<string, T>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const initialDraft = (s: SettingRow, v: SettingValue | null) =>
  s.type === 'secret'
    ? ''
    : Array.isArray(v)
      ? v.join('\n')
      : s.type === 'bool'
        ? String(!!v)
        : isSet(v) && typeof v !== 'object'
          ? String(v)
          : '';

const impactGroups = (services: ServiceImpact[], t: T): PreviewGroup[] => {
  const by = (status: ServiceImpact['status']) => services.filter((x) => x.status === status);
  const label = (x: ServiceImpact) =>
    t('settings.pvVersioned', { name: x.service, version: x.version });
  const changes = by('changes');
  const keep = by('overridden');
  const pinned = by('pinned');
  return [
    {
      title: t('settings.pvChanges'),
      n: changes.length,
      color: 'warning',
      items: changes.length ? changes.map(label) : [t('settings.pvNone')],
    },
    {
      title: t('settings.pvKeep'),
      n: keep.length,
      color: 'neutral',
      items: keep.length
        ? keep.map((x) => t('settings.pvNamedValue', { name: label(x), value: String(x.before) }))
        : [t('settings.pvNone')],
    },
    ...(pinned.length
      ? [
          {
            title: t('settings.pvPinnedGroup'),
            n: pinned.length,
            color: 'info' as const,
            items: pinned.map(label),
          },
        ]
      : []),
  ];
};

const changesFrom = async (
  api: ApiClient,
  tenant: string,
  key: string,
  service: string | undefined,
  signal: AbortSignal,
  t: T,
  f: Format,
  canAudit: boolean,
): Promise<(LogEntry & { at: string })[]> => {
  const [audit, defaults] = await Promise.all([
    canAudit ? api.audit(tenant, signal).catch(() => []) : [],
    api.settingChangelog(key, signal).catch(() => []),
  ]);
  const own = audit
    .filter(
      (a) =>
        a.outcome === 'applied' &&
        (a.target === `setting:${key}` ||
          a.target === `pin:${key}` ||
          (service !== undefined && a.target.startsWith(`Service:${service}@`))),
    )
    .map((a) => ({
      id: key,
      at: a.at,
      when: formatDateTime(a.at, f),
      who: actorLabel(a.actor, t, a.actor.startsWith('operator:') ? undefined : a.actorName),
      what: a.target.startsWith('Service:')
        ? t('settings.panelNewVersion', { version: a.target.slice(a.target.indexOf('@') + 1) })
        : a.target.startsWith('pin:')
          ? t('settings.panelPinChanged')
          : t('settings.panelChangedTenant'),
      reason: a.reason,
    }));
  const platform = defaults.map((d) => ({
    id: key,
    at: d.changedAt ?? '',
    when: d.changedAt ? formatDateTime(d.changedAt, f) : '',
    who: d.changedBy ? actorLabel(d.changedBy, t) : t('common.actorPlatform'),
    what: t('settings.panelPlatformDefault', {
      version: d.version,
      value: JSON.stringify(d.value),
    }),
    reason: d.reason ?? '',
  }));
  return [...own, ...platform].sort((a, b) => b.at.localeCompare(a.at));
};

interface Props {
  api: ApiClient;
  live?: boolean;
  tenant: string;
  serviceId: string | undefined;
  datasetId: string | undefined;
  setting: SettingRow;
  ctx: Ctx;
  names: { services: string[]; datasets: string[] };
  draftVersion: number;
  log: LogEntry[];
  onClose: () => void;
  onSaved: (row: SettingRow, entry: LogEntry, kind: 'draft' | 'saved', what: string) => void;
}

export const SettingPanel = ({
  api,
  live: liveMode = false,
  tenant,
  serviceId,
  setting: s,
  ctx,
  names,
  draftVersion,
  log,
  onClose,
  onSaved,
}: Props) => {
  const t = useT();
  const canAudit = useRights().has('manage-services');
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const el = editLayerFor(ctx.kind);
  const e = effectiveOf(s, ctx, t);
  const show = (v: SettingValue | null | undefined) => formatValue(s, v, t, f);
  const label = settingLabel(t, s);
  const rule = settingRule(t, s);
  const here = layerValue(s, el, ctx.target);
  const current = here ?? e.v;
  const ids = { value: useId(), help: useId(), reason: useId(), secret: useId() };
  const [draft, setDraft] = useState(() => initialDraft(s, current));
  const [risk, setRisk] = useState<RiskValues | undefined>(() =>
    s.type === 'risk' && current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as RiskValues) }
      : undefined,
  );
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const liveService = liveMode && el === 'T' && serviceId !== undefined && s.type !== 'secret';
  const isDraft = el === 'T' && !liveService;
  const canEditHere = s.scope.includes(
    el === 'V' ? 'virksomhet' : el === 'T' ? 'tjeneste' : 'datasett',
  );
  const pinned = ctx.kind !== 'tenant' ? s.pins?.[ctx.target] : undefined;
  const live = el === 'V' && s.apiKey !== undefined && s.type !== 'secret';
  const layerLabel = t('settings.panelLayerOf', {
    layer: layerName(t, el),
    name: el === 'V' ? ctx.tenantName : ctx.target,
  });

  const resetPreview = () => {
    setPreview(undefined);
    setSaveErr('');
    setStale(false);
  };

  const runPreview = async (change: Change) => {
    setErr('');
    setSaveErr('');
    setStale(false);
    setReason('');
    setReasonErr('');
    const local = buildPreview(s, change, ctx, names, t, f);
    if (!live || change.kind !== 'value') {
      setPreview(local);
      return;
    }
    setLoadingPreview(true);
    try {
      const result = await api.previewTenantSetting(
        tenant,
        s.apiKey ?? s.id,
        toApiValue(s, change.v),
        t('settings.panelPreviewReason'),
      );
      setPreview({
        ...local,
        groups: [
          ...impactGroups(result.services, t),
          ...local.groups.filter((g) => g.color === 'danger'),
        ],
      });
    } catch (error) {
      const details = error instanceof ApiError ? error.problem?.errors : undefined;
      setPreview({
        ...local,
        blocked: details?.length
          ? details.map((d) => settingErrorText(d.message, tRef.current)).join(' ')
          : tRef.current('settings.panelPreviewFailed'),
      });
    } finally {
      setLoadingPreview(false);
    }
  };

  const previewValue = () => {
    const parsed = parseDraft(s, draft, t, f, risk);
    if ('err' in parsed) {
      setErr(parsed.err);
      setPreview(undefined);
      return;
    }
    void runPreview({ kind: 'value', v: parsed.v });
  };

  const actions: { label: string; change: Change }[] = [];
  if (el !== 'V' && isSet(here))
    actions.push({ label: t('settings.panelResetInherited'), change: { kind: 'reset' } });
  if (ctx.kind === 'tenant' && isSet(here))
    actions.push({ label: t('settings.panelResetPlatform'), change: { kind: 'reset' } });
  if (!liveMode && ctx.kind !== 'tenant' && !pinned && !isSet(here) && e.L === 'P')
    actions.push({ label: t('settings.panelPin'), change: { kind: 'pin' } });
  if (!liveMode && ctx.kind !== 'tenant' && pinned)
    actions.push({ label: t('settings.panelUnpin'), change: { kind: 'unpin' } });

  const blocked = !!preview?.blocked;
  const change = preview?.change;
  const key = s.apiKey ?? s.id;
  const callValue = change?.kind === 'value' ? toApiValue(s, change.v) : null;
  const route = settingCall(
    liveService || isDraft
      ? {
          kind: liveService ? 'service' : 'serviceDraft',
          tenant,
          service: serviceId ?? '',
          key,
          value: callValue,
        }
      : el === 'D'
        ? { kind: 'dataset' }
        : { kind: 'tenant', tenant, key, value: callValue, reset: change?.kind === 'reset' },
  );
  const apiCall: ApiCallPreview | undefined = route && {
    ...route,
    action: liveService
      ? t('settings.panelPublishCall', { label })
      : isDraft
        ? t('settings.panelDraftCall', { label, version: draftVersion })
        : change?.kind === 'reset'
          ? t('settings.panelResetCall', { label })
          : t('settings.panelChangeCall', { label }),
    ...(isDraft ? { needsReason: false } : {}),
    right: t('rights.manageServices'),
  };

  const unsaveable = liveMode && el === 'D';
  const save = async () => {
    if (!preview || blocked || busy || unsaveable) return;
    const text = reason.trim();
    const reasonError = isDraft ? undefined : reasonProblem(text, t);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    const finalReason =
      isDraft && !text ? t('settings.panelDraftReason', { version: draftVersion }) : text;
    const next: SettingRow = structuredClone(s);
    const c = preview.change;
    if (live || liveService) {
      setBusy(true);
      try {
        if (liveService)
          await api.saveServiceSetting(
            tenant,
            serviceId ?? '',
            key,
            c.kind === 'value' ? toApiValue(s, c.v) : null,
            finalReason,
          );
        else if (c.kind === 'reset') await api.unsetTenantSetting(tenant, key, finalReason);
        else if (c.kind === 'value')
          await api.setTenantSetting(tenant, key, toApiValue(s, c.v), finalReason);
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        const details = error instanceof ApiError ? error.problem?.errors : undefined;
        setStale(conflict);
        setSaveErr(
          conflict
            ? (error.problem?.detail ?? tRef.current('settings.panelStale'))
            : details?.length
              ? details.map((d) => settingErrorText(d.message, tRef.current)).join(' ')
              : tRef.current('settings.panelSaveFailed'),
        );
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (c.kind === 'reset') {
      if (el === 'V') next.V = null;
      else if (el === 'T') next.svc = without(next.svc, ctx.target);
      else next.ds = without(next.ds, ctx.target);
    } else if (c.kind === 'pin') {
      if (isSet(s.P)) next.pins = { ...next.pins, [ctx.target]: ['v12', s.P] };
    } else if (c.kind === 'unpin') {
      next.pins = without(next.pins ?? {}, ctx.target);
    } else if (el === 'V') next.V = c.v;
    else if (el === 'T') next.svc = { ...next.svc, [ctx.target]: c.v };
    else next.ds = { ...next.ds, [ctx.target]: c.v };
    const what =
      c.kind === 'reset'
        ? t('settings.panelWhatReset')
        : c.kind === 'pin'
          ? t('settings.panelWhatPin')
          : c.kind === 'unpin'
            ? t('settings.panelWhatUnpin')
            : s.type === 'secret'
              ? t('settings.panelWhatSecret')
              : show(c.v);
    onSaved(
      next,
      {
        id: s.id,
        when: t('settings.panelToday', { time: f.time(new Date()) }),
        who: 'Kari Nordmann',
        what: t('settings.panelLogLine', { label, what }),
        reason: finalReason,
      },
      isDraft ? 'draft' : 'saved',
      what,
    );
    setPreview(undefined);
    setReason('');
    if (liveMode) reloadHistory();
  };

  const [history, reloadHistory] = useAsync(
    (signal) =>
      liveMode && s.apiKey
        ? changesFrom(api, tenant, s.apiKey, serviceId, signal, t, f, canAudit)
        : Promise.resolve([]),
    [api, tenant, s.apiKey, serviceId, liveMode, t, f, canAudit],
  );
  const changes = liveMode ? (history.status === 'ready' ? history.data : []) : log;

  const chain = layersFor(ctx.kind).map((l) => {
    const v = layerValue(s, l, ctx.target);
    return {
      layer: layerName(t, l),
      text: isSet(v) ? show(v) : t('settings.panelInheritedWord'),
      inherited: !isSet(v),
      effective: e.L === l,
    };
  });

  return (
    <SidePanel title={label} eyebrow={`${categoryText(t, s.cat)} · ${key}`} onClose={onClose}>
      <div className="tag-row">
        <Tag data-size="sm" data-color={sensColor[s.sens]}>
          {t('settings.panelSensitivity', { value: sensText(t, s.sens) })}
        </Tag>
        <Tag data-size="sm" data-color="neutral">
          {t('settings.panelEditing', { layer: layerLabel })}
        </Tag>
        {isDraft ? (
          <Tag data-size="sm" data-color="info">
            {t('settings.panelGoesToDraft', { version: draftVersion })}
          </Tag>
        ) : null}
      </div>
      <Paragraph>
        {settingDesc(t, s)} {s.notDecided ? <NotDecided /> : null}
      </Paragraph>
      <dl className="kv panel-kv">
        <dt>{t('settings.panelType')}</dt>
        <dd>{typeText(t, s.type)}</dd>
        <dt>{t('settings.panelAllowed')}</dt>
        <dd>{allowedText(s, t, f)}</dd>
        <dt>{t('settings.panelScope')}</dt>
        <dd>{scopeText(s, t)}</dd>
        {rule || s.minRisk ? (
          <>
            <dt>{t('settings.panelRule')}</dt>
            <dd>{rule ?? settingMinRisk(t, s)}</dd>
          </>
        ) : null}
        {s.categories ? (
          <>
            <dt>{t('settings.panelApplies')}</dt>
            <dd>
              <ul className="tag-row plain-list" aria-label={t('settings.panelCategories')}>
                {s.categories.map((c) => (
                  <li key={c}>
                    <Tag data-size="sm" data-color="neutral">
                      {piiText(t, c)}
                    </Tag>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>
      <div className="stack-xs">
        <span className="panel-label">{t('settings.panelChain')}</span>
        <ol className="chain plain-list">
          {chain.map((c) => (
            <li key={c.layer} className={c.effective ? 'effective' : undefined}>
              <span>{c.layer}</span>
              <span className={c.inherited ? 'inherited' : c.effective ? 'strong' : undefined}>
                {c.text}
              </span>
            </li>
          ))}
          {e.L === 'pin' ? (
            <li className="pinned">
              <span>{t('settings.panelPinnedLayer')}</span>
              <span className="strong">
                {show(e.v)} ({e.pinVersion})
              </span>
            </li>
          ) : null}
        </ol>
      </div>
      <section
        className="panel-edit stack-sm"
        aria-label={canEditHere ? t('settings.panelNewValue') : t('settings.panelCannotHere')}
      >
        <Heading level={3} data-size="2xs">
          {canEditHere ? t('settings.panelNewValue') : t('settings.panelCannotHere')}
        </Heading>
        {canEditHere ? (
          <>
            {s.type === 'secret' ? (
              <div className="stack-xs">
                <span>
                  {here === 'set'
                    ? t('settings.panelSecretStored')
                    : t('settings.panelSecretNotSet')}
                </span>
                <Field>
                  <Label htmlFor={ids.secret}>{t('settings.panelNewSecret')}</Label>
                  <Field.Description>{t('settings.panelSecretHelp')}</Field.Description>
                  <Input
                    id={ids.secret}
                    type="password"
                    autoComplete="off"
                    value={draft}
                    aria-invalid={err ? true : undefined}
                    onChange={(ev) => {
                      setDraft(ev.target.value);
                      setErr('');
                      resetPreview();
                    }}
                  />
                </Field>
              </div>
            ) : null}
            {s.type === 'enum' ? (
              <Field>
                <Label htmlFor={ids.value}>{t('settings.panelValue')}</Label>
                <Select
                  id={ids.value}
                  value={draft}
                  onChange={(ev) => {
                    setDraft(ev.target.value);
                    resetPreview();
                  }}
                >
                  {(s.opts ?? []).map(([v]) => (
                    <Select.Option key={v} value={v}>
                      {optionText(t, s, v)}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {s.type === 'int' || s.type === 'float' || s.type === 'text' ? (
              <Field className="num-field">
                <Label htmlFor={ids.value}>
                  {s.unit
                    ? t('settings.panelValueUnit', { unit: unitText(t, s.unit) })
                    : t('settings.panelValue')}
                </Label>
                <Field.Description id={ids.help}>{allowedText(s, t, f)}</Field.Description>
                <Input
                  id={ids.value}
                  inputMode={s.type === 'text' ? 'text' : 'decimal'}
                  value={draft}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={ids.help}
                  onChange={(ev) => {
                    setDraft(ev.target.value);
                    setErr('');
                    resetPreview();
                  }}
                />
              </Field>
            ) : null}
            {s.type === 'bool' ? (
              <Fieldset>
                <Fieldset.Legend>{t('settings.panelValue')}</Fieldset.Legend>
                <div className="tag-row">
                  {[
                    ['true', t('settings.valueOn')],
                    ['false', t('settings.valueOff')],
                  ].map(([v, l]) => (
                    <Chip.Radio
                      key={v}
                      name={`bool-${s.id}`}
                      checked={draft === v}
                      onChange={() => {
                        setDraft(v ?? 'false');
                        resetPreview();
                      }}
                    >
                      {l}
                    </Chip.Radio>
                  ))}
                </div>
              </Fieldset>
            ) : null}
            {s.type === 'list' ? (
              <Field>
                <Label htmlFor={ids.value}>{t('settings.panelListValue')}</Label>
                <Textarea
                  id={ids.value}
                  rows={4}
                  value={draft}
                  onChange={(ev) => {
                    setDraft(ev.target.value);
                    setErr('');
                    resetPreview();
                  }}
                />
              </Field>
            ) : null}
            {s.type === 'risk' && risk ? (
              <Fieldset>
                <Fieldset.Legend>{t('settings.panelRiskValue')}</Fieldset.Legend>
                <Fieldset.Description>{rule}</Fieldset.Description>
                <div className="risk-grid">
                  {riskLevelList.map(([level]) => (
                    <Field key={level}>
                      <Label htmlFor={`${ids.value}-${level}`}>{riskLabel(t, level)}</Label>
                      <Select
                        id={`${ids.value}-${level}`}
                        value={risk[level]}
                        onChange={(ev) => {
                          setRisk({ ...risk, [level]: ev.target.value });
                          setErr('');
                          resetPreview();
                        }}
                      >
                        {(s.opts ?? []).map(([v]) => (
                          <Select.Option key={v} value={v}>
                            {optionText(t, s, v)}
                          </Select.Option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
              </Fieldset>
            ) : null}
            {err ? <ValidationMessage>{err}</ValidationMessage> : null}
            <div className="actions">
              <Button variant="secondary" data-size="sm" onClick={previewValue}>
                {t('settings.panelPreviewButton')}
              </Button>
              {actions.map((a) => (
                <Button
                  key={a.label}
                  variant="tertiary"
                  data-size="sm"
                  onClick={() => void runPreview(a.change)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </section>
      {loadingPreview ? (
        <div role="status" className="row-wrap">
          <Spinner aria-hidden data-size="sm" />
          {t('settings.panelLoadingImpact')}
        </div>
      ) : null}
      {preview && !loadingPreview ? (
        <section className="panel-preview stack-sm" aria-label={t('settings.panelPreview')}>
          <Heading level={3} data-size="2xs">
            {t('settings.panelPreview')}
          </Heading>
          <div className="before-after">
            <span className="before">
              <span className="ba-label">{t('settings.panelBefore')}</span>
              {preview.before}
            </span>
            <span aria-hidden="true">→</span>
            <span className="after">
              <span className="ba-label">{t('settings.panelAfter')}</span>
              {preview.after}
            </span>
          </div>
          {preview.groups.map((g) => (
            <div key={g.title} className="stack-xs">
              <span className="row-wrap pv-group-title">
                <Tag data-size="sm" data-color={g.color}>
                  {g.n}
                </Tag>
                {g.title}
              </span>
              <ul className="pv-items">
                {g.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
          {preview.blocked ? (
            <Alert data-color="danger" data-size="sm">
              {preview.blocked}
            </Alert>
          ) : null}
          {isDraft ? null : (
            <Field>
              <Label htmlFor={ids.reason}>{t('common.reason')}</Label>
              <Field.Description>{t('settings.panelReasonHelp')}</Field.Description>
              <Textarea
                id={ids.reason}
                rows={2}
                value={reason}
                aria-invalid={reasonErr ? true : undefined}
                onChange={(ev) => {
                  setReason(ev.target.value);
                  setReasonErr('');
                }}
              />
              {reasonErr ? <ValidationMessage>{reasonErr}</ValidationMessage> : null}
            </Field>
          )}
          {saveErr ? (
            <Alert data-color="danger" data-size="sm">
              {saveErr}
              {stale ? (
                <Button variant="secondary" data-size="sm" onClick={() => window.location.reload()}>
                  {t('settings.panelReload')}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <div className="actions">
            <Button
              variant="primary"
              aria-disabled={blocked || busy || unsaveable || undefined}
              loading={busy}
              onClick={() => void save()}
            >
              {isDraft ? t('settings.panelSaveDraft') : t('common.save')}
            </Button>
            <Button variant="secondary" onClick={resetPreview}>
              {t('common.cancel')}
            </Button>
            {apiCall ? (
              <ApiCallLink call={apiCall} />
            ) : (
              <span className="small">{t('settings.panelNoDatasetApi')}</span>
            )}
            {isDraft ? (
              <span className="small">
                {t('settings.panelDraftHint', { version: draftVersion })}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
      {changes.length ? (
        <section className="stack-xs" aria-label={t('settings.panelChanges')}>
          <Heading level={3} data-size="2xs">
            {t('settings.panelChanges')}
          </Heading>
          <ul className="plain-list log-list">
            {changes.map((l, i) => (
              <li key={`${l.when}-${i}`}>
                <strong>{l.when}</strong> · {l.who}: {l.what}
                <span className="meta log-reason">«{l.reason}»</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </SidePanel>
  );
};
