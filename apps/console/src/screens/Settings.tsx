import {
  Button,
  Chip,
  Details,
  DetailsContent,
  DetailsSummary,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import { reasonProblem } from '../reason';
import {
  draftOf,
  formatValue,
  gridFromCatalog,
  isRiskValue,
  parseDraft,
  riskLabel,
  riskLevels,
  settingErrorText,
} from '../settings-model';
import { EmptyState, ErrorState, Loading } from '../states';
import { useTenantNames } from '../tenant-names';
import type {
  DefaultVersion,
  GridSetting,
  RiskLevel,
  ServiceImpact,
  SettingsGrid,
  ValidationProblem,
} from '../types';
import { Flash, formatWhen, SidePanel, useFlash } from '../ui';
import { Transfer } from './Transfer';
import './platform.css';
import { ReasonField } from '../components/ReasonField';
import { PageTabs } from '../page-tabs';

const impactGroups = (
  impacts: ServiceImpact[],
  s: GridSetting,
  tenantName: (tenant: string) => string,
  t: T,
  f: Format,
) => {
  const name = (i: ServiceImpact) => `${i.service} · ${tenantName(i.tenant)}`;
  const groups: { title: string; color: 'warning' | 'neutral' | 'info'; items: string[] }[] = [
    {
      title: t('settings.impactChanges'),
      color: 'warning',
      items: impacts.filter((i) => i.status === 'changes').map(name),
    },
    {
      title: t('settings.impactKeeps'),
      color: 'neutral',
      items: impacts
        .filter((i) => i.status === 'overridden')
        .map((i) => `${name(i)}: ${formatValue(s, i.before, t, f)}`),
    },
  ];
  const pinned = impacts.filter((i) => i.status === 'pinned');
  if (pinned.length)
    groups.push({ title: t('settings.impactPinned'), color: 'info', items: pinned.map(name) });
  return groups;
};

const errorText = (error: unknown, t: T) => {
  if (error instanceof ApiError) {
    const problem = error.problem as ValidationProblem | undefined;
    if (problem?.errors?.length)
      return problem.errors.map((e) => settingErrorText(e.message, t)).join(' ');
    return problem?.title ?? t('settings.rejected');
  }
  return t('settings.wentWrong');
};

const allowedText = (s: GridSetting, t: T, f: Format) => {
  if (s.type === 'enum' && s.options) return s.options.map((o) => o.label).join(', ');
  if ((s.type === 'int' || s.type === 'float') && s.min !== undefined && s.max !== undefined)
    return `${t('settings.allowedRange', { min: f.number(s.min), max: f.number(s.max) })}${s.step ? t('settings.allowedStep', { step: f.number(s.step) }) : ''}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.type === 'bool') return t('settings.allowedBool');
  if (s.type === 'risk') return t('settings.allowedRisk');
  if (s.type === 'list') return t('settings.allowedList');
  return undefined;
};

const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const defaultText = (s: GridSetting, t: T, f: Format) =>
  typeof s.platform === 'number' && s.platform >= 1_000_000 && !s.unit
    ? new Intl.NumberFormat(intlLocale(f.locale), {
        notation: 'compact',
        compactDisplay: 'short',
      }).format(s.platform)
    : formatValue(s, s.platform, t, f);

const Panel = ({
  api,
  setting: s,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  setting: GridSetting;
  onClose: () => void;
  onSaved: (flash: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const f = useFormat();
  const [draft, setDraft] = useState(draftOf(s, s.platform));
  const [risk, setRisk] = useState<Partial<Record<RiskLevel, string>>>(() => {
    const p = s.platform;
    return isRiskValue(p)
      ? Object.fromEntries(riskLevels.map((l) => [l, String(Boolean(p[l]))]))
      : {};
  });
  const [error, setError] = useState<string | undefined>();
  const [preview, setPreview] = useState<
    { value: unknown; impacts: ServiceImpact[] } | undefined
  >();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [history] = useAsync((signal) => api.changelog(s.key, signal), [api, s.key]);
  const tenantName = useTenantNames(api);
  const canEdit = s.type !== 'secret';
  const own = Object.entries(s.tenants);
  const changed = () => {
    setError(undefined);
    setPreview(undefined);
  };

  const check = async () => {
    const parsed = parseDraft(s, draft, risk, t, f);
    if ('error' in parsed) {
      setError(parsed.error);
      setPreview(undefined);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const impacts = await api.previewDefault(s.key, parsed.value, t('settings.previewReason'));
      setPreview({ value: parsed.value, impacts });
      setReason('');
      setReasonError(undefined);
    } catch (e) {
      setError(errorText(e, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!preview || busy) return;
    const tooShort = reasonProblem(t, reason);
    if (tooShort) {
      setReasonError(tooShort);
      return;
    }
    setBusy(true);
    try {
      await api.setDefault(s.key, preview.value, reason.trim());
      onSaved(
        tRef.current('settings.saved', {
          label: s.label,
          value: formatValue(s, preview.value, tRef.current, f),
        }),
      );
      setPreview(undefined);
    } catch (e) {
      setReasonError(errorText(e, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const groups = preview ? impactGroups(preview.impacts, s, tenantName, t, f) : [];
  return (
    <SidePanel labelledBy="panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{s.category}</span>
        <Heading level={2} data-size="xs" id="panel-h" tabIndex={-1}>
          {s.label}
        </Heading>
      </div>
      <div className="panel-body">
        <Paragraph>{s.description}</Paragraph>
        <dl className="def-list">
          <dt>{t('settings.colDefault')}</dt>
          <dd>{formatValue(s, s.platform, t, f)}</dd>
          <dt>{t('settings.colOwnValue')}</dt>
          <dd>
            {own.length === 0 ? (
              t('settings.none')
            ) : (
              <ul className="plain">
                {own.map(([tenant, value]) => (
                  <li key={tenant}>
                    {tenantName(tenant)}: {formatValue(s, value, t, f)}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        <section aria-labelledby="ny-h" className="stack-sm">
          <h3 id="ny-h">{canEdit ? t('settings.newDefault') : t('settings.cannotSetHere')}</h3>
          {canEdit && s.type === 'enum' && s.options ? (
            <div className="field">
              <Label htmlFor="ed">{t('settings.value')}</Label>
              <Select
                id="ed"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  changed();
                }}
              >
                {s.options.map((o) => (
                  <Select.Option key={o.value} value={o.value}>
                    {o.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
          ) : null}
          {canEdit &&
          (s.type === 'list' || s.type === 'json' || (s.type === 'text' && s.multiline)) ? (
            <div className="field">
              <Label htmlFor="ed">
                {s.type === 'list'
                  ? t('settings.valueOnePerLine')
                  : s.type === 'json'
                    ? t('settings.valueJson')
                    : t('settings.value')}
              </Label>
              <Textarea
                id="ed"
                rows={s.type === 'text' ? 8 : 4}
                value={draft}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  changed();
                }}
              />
            </div>
          ) : null}
          {canEdit &&
          (s.type === 'int' || s.type === 'float' || (s.type === 'text' && !s.multiline)) ? (
            <Textfield
              id="ed"
              label={s.unit ? t('settings.valueWithUnit', { unit: s.unit }) : t('settings.value')}
              description={s.type === 'text' ? undefined : allowedText(s, t, f)}
              inputMode={s.type === 'text' ? undefined : 'decimal'}
              value={draft}
              error={error}
              onChange={(e) => {
                setDraft(e.target.value);
                changed();
              }}
            />
          ) : null}
          {canEdit && s.type === 'bool' ? (
            <Fieldset>
              <FieldsetLegend>{t('settings.value')}</FieldsetLegend>
              <div className="chips">
                {(
                  [
                    ['true', t('settings.on')],
                    ['false', t('settings.off')],
                  ] as const
                ).map(([v, l]) => (
                  <Chip.Radio
                    key={v}
                    name="bool"
                    checked={draft === v}
                    onChange={() => {
                      setDraft(v);
                      changed();
                    }}
                  >
                    {l}
                  </Chip.Radio>
                ))}
              </div>
            </Fieldset>
          ) : null}
          {canEdit && s.type === 'risk' ? (
            <div className="stack-sm">
              {riskLevels.map((level) => (
                <Fieldset key={level} data-size="sm">
                  <FieldsetLegend>{capitalised(t(riskLabel[level]))}</FieldsetLegend>
                  <div className="chips">
                    {(
                      [
                        ['true', t('settings.on')],
                        ['false', t('settings.off')],
                      ] as const
                    ).map(([v, l]) => (
                      <Chip.Radio
                        key={v}
                        name={`risk-${level}`}
                        checked={risk[level] === v}
                        onChange={() => {
                          setRisk((r) => ({ ...r, [level]: v }));
                          changed();
                        }}
                      >
                        {l}
                      </Chip.Radio>
                    ))}
                  </div>
                </Fieldset>
              ))}
            </div>
          ) : null}
          {s.type === 'secret' ? (
            <Paragraph data-size="sm">{t('settings.secretNote')}</Paragraph>
          ) : null}
          {error && !(s.type === 'int' || s.type === 'float' || s.type === 'text') ? (
            <ValidationMessage>{error}</ValidationMessage>
          ) : null}
          {canEdit ? (
            <div className="actions-row">
              <Button
                variant="secondary"
                data-size="sm"
                loading={busy && !preview}
                onClick={() => void check()}
              >
                {t('settings.previewButton')}
              </Button>
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => {
                  setDraft(draftOf(s, s.platform));
                  changed();
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          ) : null}
        </section>
        {preview ? (
          <section aria-labelledby="pv-h" className="preview">
            <h3 id="pv-h">{t('settings.preview')}</h3>
            <div className="before-after">
              <span>
                <span className="meta">{t('settings.before')}</span>
                {formatValue(s, s.platform, t, f)}
              </span>
              <span aria-hidden="true">→</span>
              <span>
                <span className="meta">{t('settings.after')}</span>
                {formatValue(s, preview.value, t, f)}
              </span>
            </div>
            <Paragraph data-size="sm">{t('settings.appliesAtOnce')}</Paragraph>
            {groups.map((g) => (
              <div key={g.title} className="stack-sm">
                <span className="name-line">
                  <Tag data-size="sm" data-color={g.color}>
                    {String(g.items.length)}
                  </Tag>
                  {g.title}
                </span>
                {g.items.length ? (
                  <ul>
                    {g.items.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            <ReasonField
              id="grunn"
              description={t('settings.savedToAudit')}
              value={reason}
              error={reasonError}
              onChange={(value) => {
                setReason(value);
                setReasonError(undefined);
              }}
            />
            <div className="actions-row">
              <Button loading={busy} onClick={() => void save()}>
                {t('settings.save')}
              </Button>
              <Button variant="secondary" onClick={() => setPreview(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </section>
        ) : null}
        {history.status === 'ready' && history.data.length ? (
          <section aria-labelledby="hist-h" className="stack-sm">
            <h3 id="hist-h">{t('settings.versions')}</h3>
            <ol className="plain history">
              {history.data.map((h: DefaultVersion) => (
                <li key={h.version}>
                  <span>
                    <strong>{formatValue(s, h.value, t, f)}</strong>
                    {h.changedAt ? (
                      <span className="meta"> {formatWhen(h.changedAt, f, t)}</span>
                    ) : null}
                  </span>
                  {h.reason ? <span className="meta">{h.reason}</span> : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </SidePanel>
  );
};

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const Table = ({ grid, onOpen }: { grid: SettingsGrid; onOpen: (key: string) => void }) => {
  const t = useT();
  const f = useFormat();
  return (
    <div className="pf-region" tabIndex={0} role="region" aria-label={t('settings.tabDefaults')}>
      <table className="pf-table pf-min-720 pf-tall">
        <thead>
          <tr>
            <th scope="col">{t('settings.colSetting')}</th>
            <th scope="col">{t('settings.colDefault')}</th>
            <th scope="col">{t('settings.colOwnValue')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('settings.colAction')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {grid.settings.map((s) => {
            const own = Object.keys(s.tenants).length;
            return (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td className="strong">{defaultText(s, t, f)}</td>
                <td className={own ? undefined : 'muted'}>
                  {own ? (
                    <button
                      type="button"
                      className="pf-link"
                      aria-label={t('settings.ownValueFor', {
                        count: own,
                        label: lowerFirst(s.label),
                      })}
                      onClick={() => onOpen(s.key)}
                    >
                      {t('settings.tenantCount', { count: own })}
                    </button>
                  ) : (
                    t('settings.none')
                  )}
                </td>
                <td className="end">
                  {s.type === 'secret' ? null : (
                    <button
                      type="button"
                      className="pf-link"
                      aria-label={t('settings.changeFor', { label: lowerFirst(s.label) })}
                      onClick={() => onOpen(s.key)}
                    >
                      {t('settings.change')}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const Settings = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, defaults, overrides] = await Promise.all([
        api.settingsCatalog(signal),
        api.defaults(signal),
        api.settingOverrides(signal).catch(() => undefined),
      ]);
      return gridFromCatalog(catalog, defaults, overrides, tRef.current);
    },
    [api],
  );
  const flash = useFlash();
  const [grid, setGrid] = useState<SettingsGrid | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const close = useCallback(() => setOpen(undefined), []);

  useEffect(() => {
    if (state.status === 'ready') setGrid(state.data);
  }, [state]);

  const current = grid?.settings.find((s) => s.key === open);
  return (
    <>
      <h1 className="pf-title">{t('settings.title')}</h1>
      <PageTabs />
      <Flash message={flash.message} />
      {!grid && state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !grid ? (
        <Loading label={t('settings.loading')} shape="table" onRetry={retry} />
      ) : grid.settings.length === 0 ? (
        <EmptyState title={t('settings.emptyTitle')}>
          <Paragraph>{t('settings.emptyText')}</Paragraph>
        </EmptyState>
      ) : (
        <Table
          grid={grid}
          onOpen={(key) => {
            flash.clear();
            setOpen(key);
          }}
        />
      )}
      <Details>
        <DetailsSummary>{t('settings.tabTransfer')}</DetailsSummary>
        <DetailsContent>
          <Transfer api={api} grid={grid} onFlash={(text) => flash.show(text)} />
        </DetailsContent>
      </Details>
      {current ? (
        <Panel
          key={current.key}
          api={api}
          setting={current}
          onClose={close}
          onSaved={(message) => {
            flash.show(message);
            retry();
          }}
        />
      ) : null}
    </>
  );
};
