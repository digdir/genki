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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../api';
import { useT, type PlainKey, type T } from '../i18n';
import { navigate, useAsync } from '../hooks';
import { ErrorState, Loading } from '../states';
import { settingLabels } from '../setting-labels';
import { optionLabel } from '../settings-model';
import { useSupport } from '../support';
import type { EffectiveSetting, EffectiveSettings, TaskTimeline, Tenant } from '../types';
import { formatWhen, isMissing, PageHeader, pseudonym, TableRegion, VisuallyHidden } from '../ui';

type Kind = 'run' | 'service';

type Color = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

const stepType: Record<string, [PlainKey, Color]> = {
  trigger: ['diagnostics.stepTrigger', 'neutral'],
  audit: ['diagnostics.stepAudit', 'info'],
  guard: ['diagnostics.stepGuard', 'warning'],
  plan: ['diagnostics.stepPlan', 'neutral'],
  search: ['diagnostics.stepSearch', 'neutral'],
  read: ['diagnostics.stepRead', 'neutral'],
  tool: ['diagnostics.stepTool', 'neutral'],
  model: ['diagnostics.stepModel', 'neutral'],
  approval: ['diagnostics.stepApproval', 'warning'],
  document: ['diagnostics.stepDocument', 'neutral'],
  result: ['diagnostics.stepResult', 'success'],
  error: ['diagnostics.stepError', 'danger'],
};

const runStatus: Record<TaskTimeline['status'], [PlainKey, Color]> = {
  running: ['diagnostics.statusRunning', 'info'],
  interrupted: ['diagnostics.statusInterrupted', 'warning'],
  completed: ['diagnostics.statusCompleted', 'success'],
  failed: ['diagnostics.statusFailed', 'danger'],
  cancelled: ['diagnostics.statusCancelled', 'neutral'],
};

const legend: [PlainKey, 'neutral' | 'warning' | 'accent'][] = [
  ['diagnostics.inherited', 'neutral'],
  ['diagnostics.overriddenByTenant', 'warning'],
  ['diagnostics.setOnService', 'accent'],
  ['diagnostics.setOnDataset', 'accent'],
  ['diagnostics.pinnedOld', 'warning'],
];

const show = (v: unknown, t: T) =>
  v === undefined || v === null
    ? undefined
    : typeof v === 'string'
      ? optionLabel(v, t)
      : typeof v === 'boolean'
        ? v
          ? t('diagnostics.on')
          : t('diagnostics.off')
        : JSON.stringify(v);

const sourceOf = (s: EffectiveSetting, t: T): [string, 'neutral' | 'warning' | 'accent'] => {
  if (s.source === 'tenant') return [t('diagnostics.overriddenByTenant'), 'warning'];
  if (s.source === 'service' || s.source === 'call')
    return [t('diagnostics.setOnService'), 'accent'];
  if (s.source === 'dataset') return [t('diagnostics.setOnDataset'), 'accent'];
  if (s.source === 'pin')
    return [t('diagnostics.pinned', { version: s.pinnedVersion ?? '?' }), 'warning'];
  return [t('diagnostics.inheritedVersion', { version: s.defaultVersion }), 'neutral'];
};

const settingName = (s: EffectiveSetting, t: T) => {
  const named = settingLabels[s.key];
  if (named) return t(named.label);
  return s.label && s.label !== s.key ? s.label : undefined;
};

const layerValue = (s: EffectiveSetting, layers: string[], t: T) => {
  if (layers.includes(s.source)) return { value: show(s.value, t), effective: true };
  const o = s.overridden.find((x) => layers.includes(x.layer));
  return { value: show(o?.value, t), effective: false };
};

const LayerCell = ({
  value,
  effective,
  inherited,
  note,
}: {
  value: string | undefined;
  effective: boolean;
  inherited: string;
  note?: string;
}) => {
  const t = useT();
  return value === undefined ? (
    <TableCell className="cell-inherited">
      <span className="two-line">
        <span>{inherited}</span>
        <span className="meta">{t('diagnostics.inheritedShort')}</span>
      </span>
    </TableCell>
  ) : (
    <TableCell className={effective ? (note ? 'cell-pinned' : 'cell-effective') : undefined}>
      <span className="two-line">
        <span>{value}</span>
        {note ? <span className="meta">{note}</span> : null}
        {effective ? <VisuallyHidden>{t('diagnostics.applies')}</VisuallyHidden> : null}
      </span>
    </TableCell>
  );
};

const Resolved = ({
  settings,
  service,
  tenant,
}: {
  settings: EffectiveSettings;
  service: string;
  tenant: string;
}) => {
  const t = useT();
  const rows = Object.values(settings);
  const version = rows[0]?.defaultVersion;
  return (
    <div className="stack">
      <div className="name-line">
        <Heading level={2} data-size="sm">
          {service}
        </Heading>
        <span className="meta">{tenant}</span>
      </div>
      <Paragraph data-size="sm" className="meta">
        {t.rich('diagnostics.gridNote', { link: (c) => <a href="#/settings">{c}</a> })}
      </Paragraph>
      <ul aria-label={t('diagnostics.legend')} className="plain name-line">
        {legend.map(([label, color]) => (
          <li key={label}>
            <Tag data-size="sm" data-color={color}>
              {t(label)}
            </Tag>
          </li>
        ))}
      </ul>
      <TableRegion label={t('diagnostics.settings')}>
        <Table data-size="sm" className="settings-grid wide-820">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('diagnostics.colSetting')}</TableHeaderCell>
              <TableHeaderCell scope="col">
                {version
                  ? t('diagnostics.colPlatformVersion', { version })
                  : t('diagnostics.colPlatform')}
              </TableHeaderCell>
              <TableHeaderCell scope="col">{t('diagnostics.colTenant')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('diagnostics.colService')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('diagnostics.colApplies')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((s) => {
              const platform = layerValue(s, ['platform', 'default'], t);
              const ten = layerValue(s, ['tenant'], t);
              const svc = layerValue(s, ['service', 'call', 'dataset'], t);
              const pinned = s.source === 'pin';
              const [src, color] = sourceOf(s, t);
              const name = settingName(s, t);
              return (
                <TableRow key={s.key}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>{name ?? s.key}</span>
                      {name ? null : <span className="meta">{s.key}</span>}
                    </span>
                  </TableHeaderCell>
                  <LayerCell value={platform.value} effective={platform.effective} inherited="–" />
                  <LayerCell
                    value={ten.value}
                    effective={ten.effective}
                    inherited={platform.value ?? '–'}
                  />
                  {pinned ? (
                    <LayerCell
                      value={show(s.value, t)}
                      effective
                      inherited=""
                      note={t('diagnostics.pinnedNote', { version: s.pinnedVersion ?? '?' })}
                    />
                  ) : (
                    <LayerCell
                      value={svc.value}
                      effective={svc.effective}
                      inherited={ten.value ?? platform.value ?? '–'}
                    />
                  )}
                  <TableCell>
                    <span className="two-line">
                      <span className="label-strong">{show(s.value, t) ?? '–'}</span>
                      <Tag data-size="sm" data-color={color}>
                        {src}
                      </Tag>
                      {s.note ? <span className="meta">{s.note}</span> : null}
                      {s.locked ? (
                        <span className="meta">
                          {t('diagnostics.locked', { reason: s.locked })}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableRegion>
    </div>
  );
};

const Run = ({
  run,
  tenant,
  onService,
}: {
  run: TaskTimeline;
  tenant: Tenant;
  onService: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [label, color] = runStatus[run.status];
  const who = run.callerPseudonym ?? pseudonym(`${run.service}:${run.caller}`);
  return (
    <div className="stack">
      <div className="name-line">
        <Heading level={2} data-size="sm">
          {run.id}
        </Heading>
        <Tag data-color={color}>{t(label)}</Tag>
        <span className="meta">
          {tenant.name} · {run.serviceName ?? run.service}
          {run.version ? t('diagnostics.runMeta', { version: run.version }) : ''} ·{' '}
          {formatWhen(run.startedAt, f, t)} ·{' '}
          {t('diagnostics.runEmployee', { tenant: tenant.name, who })}
        </span>
      </div>
      <Button variant="secondary" data-size="sm" className="align-start" onClick={onService}>
        {t('diagnostics.showServiceSettings')}
      </Button>
      <ol className="plain step-rows">
        {run.steps.map((s) => {
          const known = stepType[s.type];
          return (
            <li key={s.id} className={s.type === 'audit' ? 'audit' : known ? undefined : 'unknown'}>
              <span className="step-tag">
                <Tag data-size="sm" data-color={known?.[1] ?? 'neutral'}>
                  {known ? t(known[0]) : t('diagnostics.stepUnknown', { type: s.type })}
                </Tag>
              </span>
              <span className="two-line grow">
                <span className="label-strong">{s.title}</span>
                <span className="meta">{s.summary}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export const Diagnostics = ({
  api,
  tenant: initialTenant,
  kind: initialKind,
}: {
  api: ApiClient;
  tenant?: string | undefined;
  kind: Kind;
}) => {
  const t = useT();
  const [tenants, retry] = useAsync((signal) => api.listTenants(signal), [api]);
  const support = useSupport();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [tenant, setTenant] = useState(initialTenant ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [missingQuery, setMissingQuery] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'run'; run: TaskTimeline }
    | { kind: 'service'; settings: EffectiveSettings; service: string }
    | { kind: 'none'; reason: 'run' | 'service' | 'failed'; query: string }
    | { kind: 'session' }
    | undefined
  >();

  if (tenants.status === 'loading') return <Loading label={t('diagnostics.loadingTenants')} />;
  if (tenants.status === 'error') return <ErrorState error={tenants.error} onRetry={retry} />;
  const list = tenants.data;
  const selected = list.find((x) => x.orgNumber === (tenant || list[0]?.orgNumber));

  const look = async (lookKind: Kind, q: string) => {
    if (!selected) return;
    const session = support.sessionFor(selected.orgNumber);
    if (!session) {
      setResult({ kind: 'session' });
      return;
    }
    setBusy(true);
    try {
      if (lookKind === 'run') {
        setResult({ kind: 'run', run: await api.timeline(selected.orgNumber, q, session.id) });
      } else {
        const service = q.replace(/__.*$/, '');
        setResult({
          kind: 'service',
          service: q,
          settings: await api.effective(selected.orgNumber, service, session.id),
        });
      }
    } catch (error) {
      if (isMissing(error)) setResult({ kind: 'none', reason: lookKind, query: q });
      else setResult({ kind: 'none', reason: 'failed', query: q });
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMissingQuery(!query.trim());
    if (query.trim()) void look(kind, query.trim());
  };

  return (
    <>
      <PageHeader title={t('diagnostics.title')} intro={t('diagnostics.intro')} />
      <form className="lookup" onSubmit={submit}>
        <Fieldset>
          <FieldsetLegend>{t('diagnostics.lookup')}</FieldsetLegend>
          <div className="chips">
            {(
              [
                ['run', t('diagnostics.kindRun')],
                ['service', t('diagnostics.kindService')],
              ] as const
            ).map(([value, label]) => (
              <Chip.Radio
                key={value}
                name="dtype"
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                  setQuery('');
                  setMissingQuery(false);
                  setResult(undefined);
                }}
              >
                {label}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <div className="field">
          <Label htmlFor="d-tenant">{t('diagnostics.tenant')}</Label>
          <Select
            id="d-tenant"
            value={selected?.orgNumber ?? ''}
            onChange={(e) => {
              setTenant(e.target.value);
              setResult(undefined);
            }}
          >
            {list.map((x) => (
              <Select.Option key={x.orgNumber} value={x.orgNumber}>
                {x.name}
              </Select.Option>
            ))}
          </Select>
        </div>
        <Textfield
          className="grow"
          id="d-q"
          label={kind === 'run' ? t('diagnostics.runId') : t('diagnostics.serviceName')}
          placeholder={
            kind === 'run' ? t('diagnostics.runPlaceholder') : t('diagnostics.servicePlaceholder')
          }
          value={query}
          error={
            missingQuery
              ? kind === 'run'
                ? t('diagnostics.missingRunId')
                : t('diagnostics.missingServiceName')
              : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim()) setMissingQuery(false);
          }}
        />
        <Button type="submit" loading={busy}>
          {t('diagnostics.lookup')}
        </Button>
      </form>
      {result?.kind === 'session' && selected ? (
        <Alert data-color="info">
          <Paragraph>{t('diagnostics.needsSession', { tenant: selected.name })}</Paragraph>
          <Button
            data-size="sm"
            variant="secondary"
            onClick={() => navigate('/support-access', { tenant: selected.orgNumber })}
          >
            {t('diagnostics.startSession')}
          </Button>
        </Alert>
      ) : null}
      {result?.kind === 'none' ? (
        <Alert data-color="info">
          <Paragraph>
            {result.reason === 'run'
              ? t('diagnostics.notFoundRun', { query: result.query })
              : result.reason === 'service'
                ? t('diagnostics.notFoundService', { query: result.query })
                : t('diagnostics.lookupFailed')}
          </Paragraph>
        </Alert>
      ) : null}
      {result?.kind === 'run' && selected ? (
        <Run
          run={result.run}
          tenant={selected}
          onService={() => {
            const name = `${result.run.service}__default`;
            setKind('service');
            setQuery(name);
            void look('service', name);
          }}
        />
      ) : null}
      {result?.kind === 'service' && selected ? (
        <Resolved settings={result.settings} service={result.service} tenant={selected.name} />
      ) : null}
    </>
  );
};
