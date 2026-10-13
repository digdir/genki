import {
  Alert,
  Button,
  Chip,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import {
  draftOf,
  formatValue,
  gridFromCatalog,
  isRiskValue,
  parseDraft,
  riskLabel,
  riskLevels,
  sensitivityLabel,
  settingErrorText,
  suggestionOf,
} from '../settings-model';
import { EmptyState, ErrorState, Loading } from '../states';
import type {
  DefaultVersion,
  GridSetting,
  RiskLevel,
  ServiceImpact,
  SettingsGrid,
  ValidationProblem,
} from '../types';
import {
  Flash,
  formatWhen,
  isMissing,
  SidePanel,
  TableRegion,
  useFlash,
  VisuallyHidden,
} from '../ui';
import { Transfer } from './Transfer';
import { reasonProblem } from '../reason';
import type { Format } from '@genai/i18n';

type Mode = 'one' | 'all';

interface Selection {
  tenant: string;
  service: string;
}

interface Effective {
  value: unknown;
  layer: 'P' | 'V' | 'T' | 'pin';
  source: string;
  color: 'neutral' | 'warning' | 'accent';
}

const serviceKey = (sel: Selection) => `${sel.tenant}/${sel.service}`;

export const effectiveOf = (s: GridSetting, sel: Selection, version: number, t: T): Effective => {
  const pin = s.pins?.[serviceKey(sel)];
  if (pin)
    return {
      value: pin.value,
      layer: 'pin',
      source: t('settings.sourcePinned', { version: pin.version }),
      color: 'warning',
    };
  const svc = s.scope.includes('service') ? s.services[serviceKey(sel)] : undefined;
  if (svc !== undefined)
    return { value: svc, layer: 'T', source: t('settings.sourceService'), color: 'accent' };
  const ten = s.scope.includes('tenant') ? s.tenants[sel.tenant] : undefined;
  if (ten !== undefined)
    return { value: ten, layer: 'V', source: t('settings.sourceTenant'), color: 'warning' };
  return {
    value: s.platform,
    layer: 'P',
    source: t('settings.sourceInherited', { version }),
    color: 'neutral',
  };
};

const impactGroups = (
  impacts: ServiceImpact[],
  s: GridSetting,
  after: unknown,
  tenantName: (tenant: string) => string,
  t: T,
  f: Format,
) => {
  const changes = impacts.filter((i) => i.status === 'changes');
  const name = (i: ServiceImpact) => `${i.service} · ${tenantName(i.tenant)}`;
  const groups: {
    title: string;
    color: 'warning' | 'neutral' | 'info' | 'danger';
    items: string[];
  }[] = [
    { title: t('settings.impactChanges'), color: 'warning', items: changes.map(name) },
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
  const breaks =
    typeof after === 'number' && s.needs
      ? changes.filter((i) => (s.needs?.[`${i.tenant}/${i.service}`] ?? 0) > after)
      : [];
  if (breaks.length)
    groups.push({
      title: t('settings.impactBreaks'),
      color: 'danger',
      items: breaks.map((i) =>
        t('settings.needsAtLeast', {
          service: i.service,
          value: formatValue(s, s.needs?.[`${i.tenant}/${i.service}`], t, f),
        }),
      ),
    });
  const blocked = breaks.length
    ? t('settings.blocked', { services: f.list(breaks.map((i) => i.service)) })
    : undefined;
  return { groups, blocked };
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

const typeText: Record<GridSetting['type'], PlainKey> = {
  int: 'settings.typeInt',
  float: 'settings.typeFloat',
  enum: 'settings.typeEnum',
  bool: 'settings.typeBool',
  list: 'settings.typeList',
  secret: 'settings.typeSecret',
  risk: 'settings.typeRisk',
  text: 'settings.typeText',
  json: 'settings.typeJson',
};

const allowedText = (s: GridSetting, t: T, f: Format) => {
  if (s.type === 'enum' && s.options) return s.options.map((o) => o.label).join(', ');
  if ((s.type === 'int' || s.type === 'float') && s.min !== undefined && s.max !== undefined)
    return `${t('settings.allowedRange', { min: f.number(s.min), max: f.number(s.max) })}${s.step ? t('settings.allowedStep', { step: f.number(s.step) }) : ''}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.type === 'bool') return t('settings.allowedBool');
  if (s.type === 'risk')
    return `${t('settings.allowedRisk')}${s.floorText ? t('settings.allowedFloor', { floor: s.floorText }) : ''}`;
  if (s.type === 'list') return t('settings.allowedList');
  if (s.type === 'secret') return t('settings.allowedSecret');
  return t('settings.allowedSee');
};

const scopeText = (s: GridSetting, t: T) =>
  [
    t('settings.layerPlatform'),
    ...s.scope.map((x) =>
      x === 'tenant'
        ? t('settings.layerTenant')
        : x === 'service'
          ? t('settings.layerService')
          : t('settings.layerDataset'),
    ),
  ].join(', ');

const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

interface LogEntry {
  key: string;
  when: string;
  what: string;
  reason: string;
}

const Panel = ({
  api,
  grid,
  setting: s,
  selection,
  mode,
  log,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  grid: SettingsGrid;
  setting: GridSetting;
  selection: Selection;
  mode: Mode;
  log: LogEntry[];
  onClose: () => void;
  onSaved: (entry: LogEntry, flash: string) => void;
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
  const eff = effectiveOf(s, selection, s.version, t);
  const suggestion = suggestionOf(s, grid.tenants);
  const canEdit = s.type !== 'secret';
  const chain =
    mode === 'all'
      ? [{ layer: t('settings.layerPlatform'), value: s.platform, effective: true }]
      : [
          { layer: t('settings.layerPlatform'), value: s.platform, effective: eff.layer === 'P' },
          {
            layer: t('settings.layerTenant'),
            value: s.scope.includes('tenant') ? s.tenants[selection.tenant] : undefined,
            effective: eff.layer === 'V',
          },
          {
            layer: t('settings.layerService'),
            value: s.scope.includes('service') ? s.services[serviceKey(selection)] : undefined,
            effective: eff.layer === 'T',
          },
          ...(eff.layer === 'pin'
            ? [{ layer: t('settings.layerPinned'), value: eff.value, effective: true }]
            : []),
        ];

  const runPreview = async (value?: unknown) => {
    let next = value;
    if (next === undefined) {
      const parsed = parseDraft(s, draft, risk, t, f);
      if ('error' in parsed) {
        setError(parsed.error);
        setPreview(undefined);
        return;
      }
      next = parsed.value;
    }
    setError(undefined);
    setBusy(true);
    try {
      const impacts = await api.previewDefault(s.key, next, t('settings.previewReason'));
      setPreview({ value: next, impacts });
      setReason('');
      setReasonError(undefined);
    } catch (e) {
      setError(errorText(e, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const pv = preview
    ? impactGroups(preview.impacts, s, preview.value, tenantName, t, f)
    : undefined;

  const save = async () => {
    if (!preview || pv?.blocked) return;
    const tooShort = reasonProblem(t, reason);
    if (tooShort) {
      setReasonError(tooShort);
      return;
    }
    setBusy(true);
    try {
      await api.setDefault(s.key, preview.value, reason.trim());
      const now = tRef.current;
      const what = formatValue(s, preview.value, now, f);
      onSaved(
        {
          key: s.key,
          when: formatWhen(new Date().toISOString(), f, now),
          what: `${s.label}: ${what}`,
          reason: reason.trim(),
        },
        now('settings.saved', { label: s.label, value: what }),
      );
      setPreview(undefined);
    } catch (e) {
      setReasonError(errorText(e, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const mine = log.filter((l) => l.key === s.key);
  return (
    <SidePanel labelledBy="panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">
          {s.category} · {s.key}
        </span>
        <Heading level={2} data-size="xs" id="panel-h" tabIndex={-1}>
          {s.label}
        </Heading>
        <span className="name-line">
          <Tag data-size="sm" data-color={sensitivityLabel[s.sensitivity][1]}>
            {t('settings.sensitivityLine', { level: t(sensitivityLabel[s.sensitivity][0]) })}
          </Tag>
          <Tag data-size="sm" data-color="neutral">
            {t('settings.editing', { version: s.version })}
          </Tag>
        </span>
      </div>
      <div className="panel-body">
        <Paragraph>{s.description}</Paragraph>
        <dl className="def-list">
          <dt>{t('settings.dtType')}</dt>
          <dd>{t(typeText[s.type])}</dd>
          <dt>{t('settings.dtAllowed')}</dt>
          <dd>{allowedText(s, t, f)}</dd>
          <dt>{t('settings.dtScope')}</dt>
          <dd>{scopeText(s, t)}</dd>
          {s.rule ? (
            <>
              <dt>{t('settings.dtRule')}</dt>
              <dd>{s.rule}</dd>
            </>
          ) : null}
        </dl>
        <div className="stack-sm">
          <span className="label-strong">{t('settings.valuePerLayer')}</span>
          <ol className="plain chain">
            {chain.map((c) => (
              <li key={c.layer} className={c.effective ? 'effective' : undefined}>
                <span>{c.layer}</span>
                <span className={c.value === undefined ? 'inherited' : undefined}>
                  {c.value === undefined ? t('settings.inherited') : formatValue(s, c.value, t, f)}
                </span>
              </li>
            ))}
          </ol>
        </div>
        {suggestion ? (
          <div className="suggest">
            <span className="label-strong">{t('settings.suggestedDefault')}</span>
            <span>
              {t('settings.suggestion', {
                n: suggestion.n,
                total: grid.tenants.length,
                value: formatValue(s, suggestion.value, t, f),
                platform: formatValue(s, s.platform, t, f),
              })}
            </span>
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => {
                setDraft(draftOf(s, suggestion.value));
                void runPreview(suggestion.value);
              }}
            >
              {t('settings.useAsNewDefault')}
            </Button>
          </div>
        ) : null}
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
                  setPreview(undefined);
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
          {canEdit && s.type === 'text' && s.multiline ? (
            <div className="field">
              <Label htmlFor="ed">{t('settings.value')}</Label>
              <Textarea
                id="ed"
                rows={8}
                value={draft}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(undefined);
                  setPreview(undefined);
                }}
              />
              {error ? <ValidationMessage>{error}</ValidationMessage> : null}
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
                setError(undefined);
                setPreview(undefined);
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
                      setPreview(undefined);
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
                  <FieldsetLegend>
                    {capitalised(t(riskLabel[level]))}
                    {s.floor?.[level] !== undefined
                      ? ` ${t('settings.floorInline', { floor: s.floor[level] ? t('settings.onLower') : t('settings.offLower') })}`
                      : ''}
                  </FieldsetLegend>
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
                          setError(undefined);
                          setPreview(undefined);
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
          {canEdit && (s.type === 'list' || s.type === 'json') ? (
            <div className="field">
              <Label htmlFor="ed">
                {s.type === 'list' ? t('settings.valueOnePerLine') : t('settings.valueJson')}
              </Label>
              <Textarea
                id="ed"
                rows={4}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setPreview(undefined);
                }}
              />
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
                onClick={() => void runPreview()}
              >
                {t('settings.previewButton')}
              </Button>
            </div>
          ) : null}
        </section>
        {preview && pv ? (
          <section aria-labelledby="pv-h" className="preview">
            <h3 id="pv-h">{t('settings.preview')}</h3>
            <div className="before-after">
              <span>
                <span className="meta">{t('settings.before')}</span>
                {t('settings.beforeValue', {
                  value: formatValue(s, s.platform, t, f),
                  version: s.version,
                })}
              </span>
              <span aria-hidden="true">→</span>
              <span>
                <span className="meta">{t('settings.after')}</span>
                {formatValue(s, preview.value, t, f)}
              </span>
            </div>
            {pv.groups.map((g) => (
              <div key={g.title} className="stack-sm">
                <span className="name-line">
                  <Tag data-size="sm" data-color={g.color}>
                    {String(g.items.length)}
                  </Tag>
                  {g.title}
                </span>
                <ul>
                  {(g.items.length ? g.items : [t('settings.none')]).map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
            {pv.blocked ? (
              <Alert data-color="danger" data-size="sm">
                {pv.blocked}
              </Alert>
            ) : null}
            <div className="field">
              <Label htmlFor="grunn">{t('common.reason')}</Label>
              <Paragraph data-size="sm" className="meta">
                {t('settings.savedToAudit')}
              </Paragraph>
              <Textarea
                id="grunn"
                rows={2}
                value={reason}
                aria-invalid={reasonError ? true : undefined}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(undefined);
                }}
              />
              {reasonError ? <ValidationMessage>{reasonError}</ValidationMessage> : null}
            </div>
            <div className="actions-row">
              <Button
                aria-disabled={pv.blocked ? true : undefined}
                loading={busy}
                onClick={() => void save()}
              >
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
                    <strong>
                      v{h.version} · {formatValue(s, h.value, t, f)}
                    </strong>
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
        {mine.length ? (
          <section aria-labelledby="log-h" className="stack-sm">
            <h3 id="log-h">{t('settings.changesHere')}</h3>
            <ul className="plain">
              {mine.map((l) => (
                <li key={`${l.when}-${l.what}`}>
                  <strong>{l.when}</strong> · {l.what}
                  <span className="meta"> «{l.reason}»</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </SidePanel>
  );
};

const Cell = ({
  s,
  value,
  applicable,
  effective,
  inherited,
  pinned,
}: {
  s: GridSetting;
  value: unknown;
  applicable: boolean;
  effective: boolean;
  inherited: string;
  pinned?: string;
}) => {
  const t = useT();
  const f = useFormat();
  if (!applicable) return <TableCell className="cell-na">{t('settings.cannotSet')}</TableCell>;
  if (pinned)
    return (
      <TableCell className="cell-pinned">
        <span className="two-line">
          <span>{pinned}</span>
          <span className="meta">{t('settings.pinnedLower')}</span>
          <VisuallyHidden>{t('settings.applies')}</VisuallyHidden>
        </span>
      </TableCell>
    );
  if (value === undefined || value === null)
    return (
      <TableCell className="cell-inherited">
        <span className="two-line">
          <span>{inherited}</span>
          <span className="meta">{t('settings.inherited')}</span>
        </span>
      </TableCell>
    );
  return (
    <TableCell className={effective ? 'cell-effective' : undefined}>
      <span className="two-line">
        <span>{formatValue(s, value, t, f)}</span>
        {s.type === 'secret' && value === 'set' ? (
          <span className="meta">{t('settings.replaceInPanel')}</span>
        ) : null}
        {effective ? <VisuallyHidden>{t('settings.applies')}</VisuallyHidden> : null}
      </span>
    </TableCell>
  );
};

const Grid = ({
  api,
  grid,
  log,
  onSaved,
}: {
  api: ApiClient;
  grid: SettingsGrid;
  log: LogEntry[];
  onSaved: (entry: LogEntry, flash: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [mode, setMode] = useState<Mode>('one');
  const [tenant, setTenant] = useState(grid.tenants[0] ?? '');
  const tenantServices = grid.services.filter((s) => s.tenant === tenant);
  const [service, setService] = useState(tenantServices[0]?.name ?? '');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const [open, setOpen] = useState<string | undefined>();
  const selection = { tenant, service };
  const close = useCallback(() => setOpen(undefined), []);
  const tenantName = useTenantNames(api);

  useEffect(() => {
    setService(grid.services.find((s) => s.tenant === tenant)?.name ?? '');
  }, [grid.services, tenant]);

  const categories = [...new Set(grid.settings.map((s) => s.category))];
  const q = query.trim().toLowerCase();
  const overridden = (s: GridSetting) =>
    mode === 'all'
      ? Object.keys(s.tenants).length > 0
      : s.tenants[tenant] !== undefined ||
        s.services[serviceKey(selection)] !== undefined ||
        Boolean(s.pins?.[serviceKey(selection)]);
  const rows = grid.settings.filter(
    (s) =>
      (category === 'all' || s.category === category) &&
      (!q || `${s.label} ${s.key} ${s.description}`.toLowerCase().includes(q)) &&
      (!onlyOverridden || overridden(s)),
  );
  const serviceRisk = grid.services.find((s) => s.tenant === tenant && s.name === service)?.risk;
  const effText = (s: GridSetting, e: Effective) =>
    isRiskValue(e.value) && serviceRisk
      ? t('settings.effRisk', {
          state: e.value[serviceRisk] ? t('settings.on') : t('settings.off'),
          level: t(riskLabel[serviceRisk]),
        })
      : formatValue(s, e.value, t, f);
  const platformSub = grid.platformDate
    ? t('settings.platformVersionDated', { version: grid.platformVersion, date: grid.platformDate })
    : t('settings.platformVersion', { version: grid.platformVersion });
  const columns =
    mode === 'all'
      ? [
          {
            label: t('settings.layerPlatform'),
            sub: platformSub,
          },
          ...grid.tenants.map((org) => ({ label: tenantName(org), sub: '' })),
        ]
      : [
          {
            label: t('settings.layerPlatform'),
            sub: platformSub,
          },
          {
            label: tenant ? tenantName(tenant) : t('settings.layerTenant'),
            sub: t('settings.layerTenant'),
          },
          { label: service || t('settings.layerService'), sub: t('settings.layerService') },
        ];
  const current = grid.settings.find((s) => s.key === open);

  return (
    <div className="stack">
      <div className="toolbar">
        {mode === 'one' && grid.tenants.length ? (
          <>
            <div className="field">
              <Label htmlFor="grid-tenant">{t('settings.layerTenant')}</Label>
              <Select id="grid-tenant" value={tenant} onChange={(e) => setTenant(e.target.value)}>
                {grid.tenants.map((org) => (
                  <Select.Option key={org} value={org}>
                    {tenantName(org)}
                  </Select.Option>
                ))}
              </Select>
            </div>
            {tenantServices.length ? (
              <div className="field">
                <Label htmlFor="mal">{t('settings.layerService')}</Label>
                <Select id="mal" value={service} onChange={(e) => setService(e.target.value)}>
                  {tenantServices.map((s) => (
                    <Select.Option key={s.name} value={s.name}>
                      {s.name}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            ) : null}
          </>
        ) : null}
        <Fieldset>
          <FieldsetLegend>{t('settings.view')}</FieldsetLegend>
          <div className="chips">
            <Chip.Radio name="opmode" checked={mode === 'one'} onChange={() => setMode('one')}>
              {t('settings.oneTenant')}
            </Chip.Radio>
            <Chip.Radio name="opmode" checked={mode === 'all'} onChange={() => setMode('all')}>
              {t('common.allTenants')}
            </Chip.Radio>
          </div>
        </Fieldset>
      </div>
      {!grid.tenants.length ? (
        <Alert data-color="info" data-size="sm">
          {t('settings.onlyDefaults')}
        </Alert>
      ) : null}
      <div className="filters">
        <Textfield
          className="search-field"
          label={t('settings.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Fieldset>
          <FieldsetLegend>{t('settings.category')}</FieldsetLegend>
          <div className="chips">
            {['all', ...categories].map((c) => (
              <Chip.Radio
                key={c}
                name="kat"
                checked={category === c}
                onChange={() => setCategory(c)}
              >
                {c === 'all' ? t('settings.categoryAll') : c}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <Switch
          label={mode === 'all' ? t('settings.onlyOverriddenAll') : t('settings.onlyOverriddenOne')}
          checked={onlyOverridden}
          onChange={() => setOnlyOverridden((v) => !v)}
        />
      </div>
      <div className="legend-row">
        <span aria-live="polite">
          {t('settings.showing', { shown: rows.length, total: grid.settings.length })}
        </span>
        <span className="legend-item">
          <span className="swatch effective" aria-hidden="true" />
          {t('settings.effectiveValue')}
        </span>
        <span className="legend-item">
          <span className="inherited-sample">8</span> {t('settings.inheritedHelp')}
        </span>
      </div>
      <TableRegion label={t('settings.tableLabel')}>
        <Table
          data-size="sm"
          className={mode === 'all' ? 'settings-grid wide-1700' : 'settings-grid wide-820'}
        >
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col" className="sticky-col">
                {t('settings.colSetting')}
              </TableHeaderCell>
              {columns.map((c) => (
                <TableHeaderCell scope="col" key={c.label}>
                  <span className="two-line">
                    <span>{c.label}</span>
                    {c.sub ? <span className="meta">{c.sub}</span> : null}
                  </span>
                </TableHeaderCell>
              ))}
              {mode === 'one' ? (
                <TableHeaderCell scope="col">{t('settings.colApplies')}</TableHeaderCell>
              ) : null}
            </TableRow>
          </TableHead>
          {categories
            .map((cat) => ({ cat, items: rows.filter((s) => s.category === cat) }))
            .filter((g) => g.items.length)
            .map(({ cat, items }) => (
              <TableBody key={cat}>
                <TableRow className="group-row">
                  <TableHeaderCell
                    scope="rowgroup"
                    colSpan={columns.length + (mode === 'one' ? 2 : 1)}
                  >
                    {cat} <span className="meta">({items.length})</span>
                  </TableHeaderCell>
                </TableRow>
                {items.map((s) => {
                  const e = effectiveOf(s, selection, s.version, t);
                  const sens = sensitivityLabel[s.sensitivity];
                  const suggestion = suggestionOf(s, grid.tenants);
                  const tenantValue = s.scope.includes('tenant') ? s.tenants[tenant] : undefined;
                  return (
                    <TableRow key={s.key} className={open === s.key ? 'selected' : undefined}>
                      <TableHeaderCell scope="row" className="sticky-col row-head">
                        <span className="two-line">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setOpen(s.key)}
                          >
                            {s.label}
                          </button>
                          <span className="meta">{s.key}</span>
                          <span className="name-line">
                            {s.sensitivity !== 'low' ? (
                              <Tag data-size="sm" data-color={sens[1]}>
                                {t(sens[0])}
                              </Tag>
                            ) : null}
                            {suggestion ? (
                              <Tag data-size="sm" data-color="info">
                                {t('settings.suggestedDefault')}
                              </Tag>
                            ) : null}
                          </span>
                        </span>
                      </TableHeaderCell>
                      {mode === 'all' ? (
                        <>
                          <Cell
                            s={s}
                            value={s.platform}
                            applicable
                            effective={false}
                            inherited=""
                          />
                          {grid.tenants.map((org) => (
                            <Cell
                              key={org}
                              s={s}
                              value={s.tenants[org]}
                              applicable={s.scope.includes('tenant')}
                              effective={false}
                              inherited={formatValue(s, s.platform, t, f)}
                            />
                          ))}
                        </>
                      ) : (
                        <>
                          <Cell
                            s={s}
                            value={s.platform}
                            applicable
                            effective={e.layer === 'P'}
                            inherited="–"
                          />
                          <Cell
                            s={s}
                            value={tenantValue}
                            applicable={s.scope.includes('tenant')}
                            effective={e.layer === 'V'}
                            inherited={formatValue(s, s.platform, t, f)}
                          />
                          <Cell
                            s={s}
                            value={
                              s.scope.includes('service')
                                ? s.services[serviceKey(selection)]
                                : undefined
                            }
                            applicable={s.scope.includes('service')}
                            effective={e.layer === 'T'}
                            inherited={formatValue(s, tenantValue ?? s.platform, t, f)}
                            {...(e.layer === 'pin'
                              ? { pinned: formatValue(s, e.value, t, f) }
                              : {})}
                          />
                          <TableCell>
                            <span className="two-line">
                              <span className="label-strong">{effText(s, e)}</span>
                              <Tag data-size="sm" data-color={e.color}>
                                {e.source}
                              </Tag>
                            </span>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            ))}
        </Table>
      </TableRegion>
      {rows.length === 0 ? (
        <Paragraph>
          {t('settings.noMatch')}{' '}
          <Button
            variant="tertiary"
            data-size="sm"
            onClick={() => {
              setQuery('');
              setCategory('all');
              setOnlyOverridden(false);
            }}
          >
            {t('settings.reset')}
          </Button>
        </Paragraph>
      ) : null}
      <Paragraph data-size="sm" className="meta">
        {t('settings.footnote')}
      </Paragraph>
      {current ? (
        <Panel
          key={current.key}
          api={api}
          grid={grid}
          setting={current}
          selection={selection}
          mode={mode}
          log={log}
          onClose={close}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
};

export const Settings = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      if (api.hasSettingsGrid) {
        try {
          return await api.settingsGrid(signal);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      const [catalog, defaults, overrides] = await Promise.all([
        api.settingsCatalog(signal),
        api.defaults(signal),
        api.settingOverrides(signal).catch(() => undefined),
      ]);
      return gridFromCatalog(catalog, defaults, overrides, tRef.current);
    },
    [api],
  );
  const [tab, setTab] = useState('grid');
  const [log, setLog] = useState<LogEntry[]>([]);
  const flash = useFlash();
  const [grid, setGrid] = useState<SettingsGrid | undefined>();

  useEffect(() => {
    if (state.status === 'ready') setGrid(state.data);
  }, [state]);

  return (
    <>
      <nav aria-label={t('settings.breadcrumbs')} className="crumbs">
        <a href="#/tenants">{t('shell.title')}</a>
        <span aria-hidden="true">/</span>
        <span>{t('shell.pageSettings')}</span>
      </nav>
      <div className="page-header">
        <Heading level={1} data-size="md">
          {t('settings.title')}
        </Heading>
        <p className="intro">{t('settings.intro')}</p>
      </div>
      <Tabs
        value={tab}
        onChange={(v) => {
          setTab(v);
          flash.clear();
        }}
      >
        <TabsList>
          <TabsTab value="grid">{t('shell.pageSettings')}</TabsTab>
          <TabsTab value="transfer">{t('settings.tabTransfer')}</TabsTab>
        </TabsList>
        <Flash message={flash.message} />
        <TabsPanel value="grid">
          {state.status === 'loading' ? (
            <Loading label={t('settings.loading')} />
          ) : state.status === 'error' ? (
            <ErrorState error={state.error} onRetry={retry} />
          ) : !grid || grid.settings.length === 0 ? (
            <EmptyState title={t('settings.emptyTitle')}>
              <Paragraph>{t('settings.emptyText')}</Paragraph>
            </EmptyState>
          ) : (
            <Grid
              api={api}
              grid={grid}
              log={log}
              onSaved={(entry, message) => {
                setLog((l) => [entry, ...l]);
                flash.show(message);
                retry();
              }}
            />
          )}
        </TabsPanel>
        <TabsPanel value="transfer">
          <Transfer api={api} grid={grid} onFlash={(text) => flash.show(text)} />
        </TabsPanel>
      </Tabs>
    </>
  );
};
