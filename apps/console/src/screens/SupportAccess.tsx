import {
  Alert,
  Button,
  Chip,
  Details,
  DetailsContent,
  DetailsSummary,
  ErrorSummary,
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
} from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { ApiClient } from '../api';
import { ApiCall } from '../api-call';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import { settingLabels } from '../setting-labels';
import { shapeFromSchema } from '../settings-model';
import { EmptyState, ErrorState, Loading } from '../states';
import { reasonError, SupportDialog } from '../support-dialog';
import { useSupport, type ActiveSupport } from '../support';
import type {
  AuditEntry,
  EffectiveSettings,
  SettingInfo,
  SupportSessionRow,
  Tenant,
  TenantKey,
} from '../types';
import { Flash, formatDay, formatWhen, NotDecided, PageHeader, TableRegion, useFlash } from '../ui';

export interface Change {
  key: string;
  label: string;
  from: string;
  to: string;
  value: unknown;
}

type Field = { key: string; label: string; description?: string } & (
  | { type: 'int' | 'float'; min?: number; max?: number }
  | { type: 'bool' }
  | { type: 'text' }
  | { type: 'enum'; options: { value: string; label: string }[] }
);

const show = (value: unknown, t: T) =>
  value === true
    ? t('supportAccess.yes')
    : value === false
      ? t('supportAccess.no')
      : value == null
        ? t('supportAccess.notSet')
        : String(value);

const fieldOf = (info: SettingInfo, current: unknown, t: T): Field | undefined => {
  const named = settingLabels[info.key];
  const base = {
    key: info.key,
    label: named ? t(named.label) : info.key,
    description: named?.desc ? t(named.desc) : info.description,
  };
  const shape = shapeFromSchema(info.schema, t);
  if (shape?.type === 'enum') return { ...base, type: 'enum', options: shape.options ?? [] };
  if (shape?.type === 'int' || shape?.type === 'float')
    return {
      ...base,
      type: shape.type,
      ...(shape.min === undefined ? {} : { min: shape.min }),
      ...(shape.max === undefined ? {} : { max: shape.max }),
    };
  if (shape?.type === 'bool') return { ...base, type: 'bool' };
  if (shape?.type === 'text') return { ...base, type: 'text' };
  if (shape) return undefined;
  if (typeof current === 'number')
    return { ...base, type: Number.isInteger(current) ? 'int' : 'float' };
  if (typeof current === 'boolean') return { ...base, type: 'bool' };
  if (typeof current === 'string') return { ...base, type: 'text' };
  return undefined;
};

const parse = (field: Field, raw: string): unknown =>
  field.type === 'int' || field.type === 'float' ? Number(raw.replace(',', '.')) : raw;

const Frame = ({
  path,
  tenant,
  children,
}: {
  path: string;
  tenant: string;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <div className="support-frame">
      <div className="support-bar">
        <strong>{path}</strong>
        <span>{t('supportAccess.frameNote', { tenant })}</span>
      </div>
      <div className="support-body stack" role="region" aria-label={path}>
        {children}
      </div>
    </div>
  );
};

const SettingsTab = ({
  api,
  session,
  onPending,
  onSaved,
}: {
  api: ApiClient;
  session: ActiveSupport;
  onPending: (changes: Change[]) => void;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, effective] = await Promise.all([
        api.settingsCatalog(signal),
        api.tenantSettings(session.tenant, session.id, signal),
      ]);
      return { catalog, effective };
    },
    [api, session.tenant, session.id],
  );
  const [stored, setSaved] = useState<EffectiveSettings | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const saved = stored ?? (state.status === 'ready' ? state.data.effective : undefined);

  const fields =
    state.status === 'ready' && saved
      ? state.data.catalog
          .filter((s) => s.sensitivity === 'normal' && s.settableAt.includes('tenant'))
          .flatMap((s) => {
            const f = fieldOf(s, saved[s.key]?.value ?? s.default, t);
            return f && !saved[s.key]?.locked ? [f] : [];
          })
      : [];
  const valueOf = (key: string) => saved?.[key]?.value;
  const changes: Change[] = fields.flatMap((f) => {
    if (!(f.key in draft)) return [];
    const value = parse(f, draft[f.key] ?? '');
    if (show(value, t) === show(valueOf(f.key), t)) return [];
    return [
      { key: f.key, label: f.label, from: show(valueOf(f.key), t), to: show(value, t), value },
    ];
  });
  const signature = JSON.stringify(changes);
  useEffect(() => onPending(changes), [signature]);

  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingSettings')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const first = changes[0];
  return (
    <Frame path={t('supportAccess.settingsPath')} tenant={session.tenantName}>
      <Paragraph data-size="sm" className="meta">
        {t('supportAccess.tenantLevel', { tenant: session.tenantName })}
      </Paragraph>
      {fields.length === 0 ? <Paragraph>{t('supportAccess.noneSettable')}</Paragraph> : null}
      {fields.map((f) => {
        const current = f.key in draft ? (draft[f.key] ?? '') : show(valueOf(f.key), t);
        const set = (v: string) => setDraft((d) => ({ ...d, [f.key]: v }));
        if (f.type === 'bool')
          return (
            <Switch
              key={f.key}
              label={f.label}
              description={f.description}
              checked={(f.key in draft ? draft[f.key] : String(valueOf(f.key))) === 'true'}
              onChange={(e) => set(String(e.target.checked))}
            />
          );
        if (f.type === 'enum')
          return (
            <div className="field narrow" key={f.key}>
              <Label htmlFor={`s-${f.key}`}>{f.label}</Label>
              <Select
                id={`s-${f.key}`}
                value={f.key in draft ? draft[f.key] : String(valueOf(f.key) ?? '')}
                onChange={(e) => set(e.target.value)}
              >
                {f.options.map((o) => (
                  <Select.Option key={o.value} value={o.value}>
                    {o.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
          );
        return (
          <Textfield
            key={f.key}
            className="narrow"
            label={f.label}
            description={f.description}
            inputMode={f.type === 'text' ? undefined : 'decimal'}
            value={current === t('supportAccess.notSet') ? '' : current}
            onChange={(e) => set(e.target.value)}
          />
        );
      })}
      <div className="actions-row">
        <Button
          aria-disabled={changes.length === 0 || undefined}
          onClick={() => changes.length && setConfirming(true)}
        >
          {t('supportAccess.save')}
        </Button>
        <span className="meta">
          {changes.length
            ? t('supportAccess.unsaved', { count: changes.length })
            : t('supportAccess.noChanges')}
        </span>
      </div>
      <SupportDialog
        open={confirming}
        title={t('supportAccess.changeTitle', { tenant: session.tenantName })}
        initialReason={session.reason}
        hint={t('supportAccess.hintFromSession')}
        sees={t('supportAccess.seesChange', { tenant: session.tenantName })}
        cta={t('supportAccess.saveAsDigdir')}
        api={{
          method: 'PUT',
          path: `/tenants/${session.tenant}/settings/${first?.key ?? '{key}'}`,
          body: () => ({ value: first?.value }),
        }}
        onClose={() => setConfirming(false)}
        onConfirm={async (reason) => {
          for (const c of changes)
            await api.setTenantSetting(session.tenant, c.key, c.value, reason, session.id);
          setSaved(
            Object.fromEntries(
              Object.entries(saved ?? {}).map(([k, v]) => {
                const c = changes.find((x) => x.key === k);
                return [k, c ? { ...v, value: c.value } : v];
              }),
            ),
          );
          setDraft({});
          onSaved(tRef.current('supportAccess.savedAsDigdir', { tenant: session.tenantName }));
        }}
      >
        <ChangeList changes={changes} />
        <Paragraph data-size="sm">
          {t('supportAccess.affectsAll', { tenant: session.tenantName })}
        </Paragraph>
      </SupportDialog>
    </Frame>
  );
};

export const ChangeList = ({ changes }: { changes: Change[] }) => (
  <ul className="plain change-list">
    {changes.map((c) => (
      <li key={c.key}>
        <span className="label-strong">{c.label}:</span>
        <span>
          <del>{c.from}</del> → <ins>{c.to}</ins>
        </span>
      </li>
    ))}
  </ul>
);

const DraftsTab = ({ api, session }: { api: ApiClient; session: ActiveSupport }) => {
  const t = useT();
  const f = useFormat();
  const kindLabel = (kind: string) =>
    kind === 'Service' ? t('supportAccess.kindService') : t('supportAccess.kindStepFlow');
  const [state, retry] = useAsync(
    (signal) => api.tenantDefinitions(session.tenant, signal),
    [api, session.tenant],
  );
  return (
    <Frame path={t('supportAccess.servicesPath')} tenant={session.tenantName}>
      <Paragraph data-size="sm" className="tag-line">
        {t('supportAccess.onlyTenantPublishes', { tenant: session.tenantName })} <NotDecided />
        {t('supportAccess.operatorsPublish')}
      </Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('supportAccess.loadingServices')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <Paragraph>{t('supportAccess.noServices', { tenant: session.tenantName })}</Paragraph>
      ) : (
        <ul className="plain row-list">
          {state.data.map((d) => (
            <li key={`${d.kind}/${d.id}`}>
              <span className="two-line grow">
                <a
                  href={`#/tenants/services?tenant=${session.tenant}&kind=${d.kind === 'Service' ? 'service' : 'step-flow'}&id=${encodeURIComponent(d.id)}`}
                >
                  {d.name}
                </a>
                <span className="meta">
                  {d.publishedAt
                    ? t('supportAccess.publishedVersionOn', {
                        kind: kindLabel(d.kind),
                        version: d.latestVersion,
                        date: formatDay(d.publishedAt, f),
                      })
                    : t('supportAccess.publishedVersion', {
                        kind: kindLabel(d.kind),
                        version: d.latestVersion,
                      })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
};

const KeysTab = ({
  api,
  session,
  onSaved,
}: {
  api: ApiClient;
  session: ActiveSupport;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    (signal) => api.tenantKeys(session.tenant, session.id, signal),
    [api, session.tenant, session.id],
  );
  const [keys, setKeys] = useState<TenantKey[]>([]);
  const [revoking, setRevoking] = useState<TenantKey | undefined>();
  useEffect(() => {
    if (state.status === 'ready') setKeys(state.data);
  }, [state]);
  return (
    <Frame path={t('supportAccess.keysPath')} tenant={session.tenantName}>
      <Alert data-color="info" data-size="sm">
        {t('supportAccess.keysNote')}
      </Alert>
      {state.status === 'loading' ? (
        <Loading label={t('supportAccess.loadingKeys')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : keys.length === 0 ? (
        <Paragraph>{t('supportAccess.noKeys', { tenant: session.tenantName })}</Paragraph>
      ) : (
        <TableRegion label={t('supportAccess.keysLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('supportAccess.colName')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('supportAccess.colCreated')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('supportAccess.colExpires')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('supportAccess.colStatus')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <span className="visually-hidden">{t('supportAccess.colAction')}</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableHeaderCell scope="row">{k.name || k.prefix || k.id}</TableHeaderCell>
                  <TableCell>
                    {k.createdAt ? formatDay(k.createdAt, f) : t('supportAccess.unknown')}
                  </TableCell>
                  <TableCell>
                    {k.expiresAt ? formatDay(k.expiresAt, f) : t('supportAccess.never')}
                  </TableCell>
                  <TableCell>
                    <Tag data-size="sm" data-color={k.revokedAt ? 'neutral' : 'success'}>
                      {k.revokedAt ? t('supportAccess.revoked') : t('supportAccess.active')}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    {k.revokedAt ? null : (
                      <Button
                        variant="secondary"
                        data-size="sm"
                        data-color="danger"
                        onClick={() => setRevoking(k)}
                      >
                        {t('supportAccess.revoke')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      <Heading level={3} data-size="2xs">
        {t('supportAccess.machineClients')}
      </Heading>
      <Alert data-color="info" data-size="sm">
        {t('supportAccess.machineNote')}
      </Alert>
      <SupportDialog
        open={Boolean(revoking)}
        title={t('supportAccess.revokeTitle', { name: revoking?.name ?? '' })}
        lead={t('supportAccess.revokeLead', { tenant: session.tenantName })}
        initialReason={session.reason}
        hint={t('supportAccess.hintFromSession')}
        sees={t('supportAccess.seesChange', { tenant: session.tenantName })}
        cta={t('supportAccess.revoke')}
        danger
        api={{
          method: 'POST',
          path: `/tenants/${session.tenant}/api-keys/${revoking?.id ?? ''}/revoke`,
        }}
        onClose={() => setRevoking(undefined)}
        onConfirm={async (reason) => {
          if (!revoking) return;
          const done = await api.revokeTenantKey(session.tenant, revoking.id, reason, session.id);
          setKeys((all) =>
            all.map((k) =>
              k.id === revoking.id
                ? { ...k, revokedAt: done?.revokedAt ?? new Date().toISOString() }
                : k,
            ),
          );
          onSaved(
            tRef.current('supportAccess.revokedDone', {
              name: revoking.name,
              tenant: session.tenantName,
            }),
          );
        }}
      />
    </Frame>
  );
};

const minutesBetween = (a: string, b: string) =>
  Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));

const windowOf = (s: SupportSessionRow, t: T, f: Format) =>
  t('supportAccess.window', {
    from: f.time(s.openedAt),
    to: f.time(s.endedAt ?? s.expiresAt),
  });

const operatorLabel = (s: { operatorName?: string; operator: string }) =>
  s.operatorName ?? s.operator.replace(/^operator:(entra:)?/, '');

const isSessionEvent = (e: AuditEntry) =>
  e.action.startsWith('platform.support.') ||
  (e.actionLabel ?? e.action).startsWith('Støttetilgang');

export const sessionGroups = (sessions: SupportSessionRow[], entries: AuditEntry[]) =>
  sessions.map((s) => {
    const from = new Date(s.openedAt).getTime();
    const to = new Date(s.endedAt ?? s.expiresAt).getTime();
    return {
      session: s,
      entries: entries
        .filter((e) => {
          const at = new Date(e.at).getTime();
          return (
            at >= from &&
            at <= to &&
            !isSessionEvent(e) &&
            (e.actor === s.operator ||
              (s.operatorName !== undefined && e.actorName === s.operatorName))
          );
        })
        .sort((a, b) => a.at.localeCompare(b.at)),
    };
  });

const LogTab = ({
  api,
  session,
  sessions,
}: {
  api: ApiClient;
  session: ActiveSupport;
  sessions: SupportSessionRow[];
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => api.audit(session.tenant, session.id, signal),
    [api, session.tenant, session.id],
  );
  const mine = sessions
    .filter((s) => s.tenant === session.tenant)
    .map((s) => (s.id === session.id ? { ...s, expiresAt: session.expiresAt } : s));
  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingLog')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const groups = sessionGroups(mine, state.data);
  const grouped = new Set(groups.flatMap((g) => g.entries.map((e) => e.task)));
  const others = state.data.filter((e) => !grouped.has(e.task)).slice(0, 10);
  return (
    <div className="stack">
      <Frame
        path={t('supportAccess.logPath', { tenant: session.tenantName })}
        tenant={session.tenantName}
      >
        {groups.length === 0 ? <Paragraph>{t('supportAccess.noSessions')}</Paragraph> : null}
        {groups.map(({ session: s, entries }) => (
          <Details key={s.id} defaultOpen={s.id === session.id}>
            <DetailsSummary>
              <span className="tag-line">
                <Tag data-size="sm" data-color="warning">
                  {t('supportAccess.supportTag')}
                </Tag>
                <span className="label-strong">
                  {t('supportAccess.openedPortal', { name: operatorLabel(s) })}
                </span>
                <span className="meta">
                  {t('supportAccess.sessionMeta', {
                    when: formatWhen(s.openedAt, f, t),
                    minutes: minutesBetween(s.openedAt, s.endedAt ?? s.expiresAt),
                    changes: t('supportAccess.changes', { count: entries.length }),
                  })}
                </span>
              </span>
            </DetailsSummary>
            <DetailsContent>
              <div className="stack-sm">
                <Paragraph data-size="sm">
                  <strong>{t('common.reason')}:</strong> {s.reason}
                </Paragraph>
                {entries.length === 0 ? (
                  <Paragraph data-size="sm" className="meta">
                    {t('supportAccess.noChangesInSession')}
                  </Paragraph>
                ) : (
                  <ol className="plain log-rows">
                    {entries.map((e) => (
                      <li key={e.task}>
                        <span className="meta">
                          {t('supportAccess.atTime', { time: f.time(e.at) })}
                        </span>
                        <span className="two-line">
                          <span className="tag-line">
                            <Tag data-size="sm" data-color="warning">
                              {t('supportAccess.digdirChange')}
                            </Tag>
                            <span className="label-strong">
                              {e.actionLabel ?? e.action}
                              {e.target ? `: ${e.target}` : ''}
                            </span>
                          </span>
                          <span className="meta">
                            {t('supportAccess.byActor', {
                              actor: e.actorName ?? operatorLabel(s),
                              reason: e.reason,
                            })}
                          </span>
                          <span className="meta">
                            {t('supportAccess.duringSupport', { window: windowOf(s, t, f) })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </DetailsContent>
          </Details>
        ))}
        {others.length ? (
          <ol className="plain log-rows">
            {others.map((e) => (
              <li key={e.task}>
                <span className="meta">{formatWhen(e.at, f, t)}</span>
                <span className="two-line">
                  <span className="label-strong">
                    {e.actionLabel ?? e.action}
                    {e.target ? `: ${e.target}` : ''}
                  </span>
                  <span className="meta">
                    {e.actorName ?? e.actor} · {e.reason}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </Frame>
    </div>
  );
};

const Portal = ({
  api,
  session,
  sessions,
  onPending,
  onSaved,
}: {
  api: ApiClient;
  session: ActiveSupport;
  sessions: SupportSessionRow[];
  onPending: (changes: Change[]) => void;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const [tab, setTab] = useState('settings');
  return (
    <section className="stack" aria-labelledby="portal-h">
      <Heading level={2} data-size="xs" id="portal-h">
        {t('supportAccess.portalTitle', { tenant: session.tenantName })}
      </Heading>
      <Tabs value={tab} onChange={setTab}>
        <TabsList aria-label={t('supportAccess.tabsLabel')}>
          <TabsTab value="settings">{t('supportAccess.tabSettings')}</TabsTab>
          <TabsTab value="drafts">{t('supportAccess.tabDrafts')}</TabsTab>
          <TabsTab value="keys">{t('supportAccess.tabKeys')}</TabsTab>
          <TabsTab value="log">{t('supportAccess.tabLog')}</TabsTab>
        </TabsList>
        <TabsPanel value="settings">
          <SettingsTab api={api} session={session} onPending={onPending} onSaved={onSaved} />
        </TabsPanel>
        <TabsPanel value="drafts">
          {tab === 'drafts' ? <DraftsTab api={api} session={session} /> : null}
        </TabsPanel>
        <TabsPanel value="keys">
          {tab === 'keys' ? <KeysTab api={api} session={session} onSaved={onSaved} /> : null}
        </TabsPanel>
        <TabsPanel value="log">
          {tab === 'log' ? <LogTab api={api} session={session} sessions={sessions} /> : null}
        </TabsPanel>
      </Tabs>
    </section>
  );
};

const StartForm = ({
  tenants,
  initial,
  onStart,
}: {
  tenants: Tenant[];
  initial?: string | undefined;
  onStart: (tenant: Tenant, reason: string, minutes: number) => Promise<void>;
}) => {
  const t = useT();
  const usable = tenants.filter((x) => x.status !== 'onboarding');
  const [tenant, setTenant] = useState(
    usable.find((x) => x.orgNumber === initial)?.orgNumber ?? usable[0]?.orgNumber ?? '',
  );
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(30);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const error = reasonError(t, reason);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = usable.find((x) => x.orgNumber === tenant);
    if (error || !chosen) {
      setTried(true);
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setBusy(true);
    try {
      await onStart(chosen, reason.trim(), minutes);
      setReason('');
      setTried(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card stack form-card"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="start-h"
      noValidate
    >
      <Heading level={2} data-size="sm" id="start-h">
        {t('supportAccess.startTitle')}
      </Heading>
      {tried && error ? (
        <ErrorSummary ref={summary} tabIndex={-1}>
          <ErrorSummary.Heading>{t('supportAccess.fixHeading')}</ErrorSummary.Heading>
          <ErrorSummary.List>
            <ErrorSummary.Item>
              <ErrorSummary.Link href="#s-grunn">{error}</ErrorSummary.Link>
            </ErrorSummary.Item>
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}
      <div className="field narrow">
        <Label htmlFor="s-virk">{t('supportAccess.tenant')}</Label>
        <Select id="s-virk" value={tenant} onChange={(e) => setTenant(e.target.value)}>
          {usable.map((x) => (
            <Select.Option key={x.orgNumber} value={x.orgNumber}>
              {x.name}
            </Select.Option>
          ))}
        </Select>
      </div>
      <div className="field">
        <Label htmlFor="s-grunn">{t('common.reason')}</Label>
        <Paragraph data-size="sm" className="meta" id="s-grunn-h">
          {t('supportAccess.reasonHelp')}
        </Paragraph>
        <Textarea
          id="s-grunn"
          rows={2}
          value={reason}
          aria-describedby="s-grunn-h"
          aria-invalid={tried && error ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Fieldset>
        <FieldsetLegend>{t('supportAccess.duration')}</FieldsetLegend>
        <div className="chips">
          {[15, 30, 60].map((m) => (
            <Chip.Radio
              key={m}
              name="varighet"
              checked={minutes === m}
              onChange={() => setMinutes(m)}
            >
              {t('supportAccess.minutes', { count: m })}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      <div className="tinted-block stack-sm">
        <Heading level={3} data-size="2xs">
          {t('supportAccess.grantsTitle')}
        </Heading>
        <ul>
          <li>{t('supportAccess.grant1')}</li>
          <li>{t('supportAccess.grant2')}</li>
          <li>{t('supportAccess.grant3')}</li>
          <li>{t('supportAccess.grant4')}</li>
          <li>{t('supportAccess.grant5')}</li>
        </ul>
      </div>
      <ApiCall
        method="POST"
        path="/support-sessions"
        body={{ tenant, reason: reason.trim(), minutes }}
      />
      <div>
        <Button type="submit" loading={busy}>
          {t('supportAccess.startTitle')}
        </Button>
      </div>
    </form>
  );
};

export const SupportAccess = ({ api, tenant }: { api: ApiClient; tenant?: string | undefined }) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const [tenants, sessions] = await Promise.all([
        api.listTenants(signal),
        api.supportSessions(signal),
      ]);
      return { tenants, sessions };
    },
    [api],
  );
  const support = useSupport();
  const flash = useFlash();
  const pending = useRef<Change[]>([]);
  const [lost, setLost] = useState<{ tenant: string; at: string; changes: Change[] }>();

  useEffect(() => {
    const expired = support.expired;
    if (!expired || !pending.current.length) return;
    setLost({ tenant: expired.tenantName, at: expired.expiresAt, changes: pending.current });
    pending.current = [];
  }, [support.expired]);

  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingSessions')} />;
  if (state.status === 'error')
    return (
      <>
        <PageHeader eyebrow={t('supportAccess.eyebrow')} title={t('supportAccess.title')} />
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const nameOf = (org: string) => state.data.tenants.find((x) => x.orgNumber === org)?.name ?? org;
  const notice = support.notice;

  return (
    <>
      <PageHeader
        eyebrow={t('supportAccess.eyebrow')}
        title={t('supportAccess.title')}
        intro={t('supportAccess.intro')}
      />
      <Flash message={flash.message ?? (notice && !lost ? { text: notice } : undefined)} />
      {lost && !support.session ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('supportAccess.lostTitle')}
          </Heading>
          <Paragraph>
            {t('supportAccess.lostText', { tenant: lost.tenant, time: f.time(lost.at) })}
          </Paragraph>
          <ChangeList changes={lost.changes} />
          <Button data-size="sm" onClick={() => setLost(undefined)}>
            {t('supportAccess.newSession')}
          </Button>
        </Alert>
      ) : support.session ? (
        <Portal
          key={support.session.id}
          api={api}
          session={support.session}
          sessions={state.data.sessions}
          onPending={(changes) => {
            pending.current = changes;
          }}
          onSaved={(text) => flash.show(text)}
        />
      ) : (
        <StartForm
          tenants={state.data.tenants}
          initial={tenant}
          onStart={async (chosen, reason, minutes) => {
            try {
              await support.start(chosen.orgNumber, chosen.name, reason, minutes);
              setLost(undefined);
              flash.show(tRef.current('supportAccess.started', { name: chosen.name }));
              retry();
            } catch {
              flash.show(tRef.current('supportAccess.startFailed'), 'danger');
            }
          }}
        />
      )}
      {support.session ? null : (
        <section className="stack" aria-labelledby="okter-h">
          <Heading level={2} data-size="xs" id="okter-h">
            {t('supportAccess.recent')}
          </Heading>
          {state.data.sessions.length === 0 ? (
            <EmptyState title={t('supportAccess.noneYet')} />
          ) : (
            <ul className="plain row-list">
              {state.data.sessions.map((s) => (
                <li key={s.id}>
                  <span className="when meta">{formatWhen(s.openedAt, f, t)}</span>
                  <span className="grow2">
                    <strong>{operatorLabel(s)}</strong>
                    {t('supportAccess.inTenant', { tenant: nameOf(s.tenant), reason: s.reason })}
                  </span>
                  <span className="row-actions">
                    {s.status === 'active'
                      ? t('supportAccess.statusActive', { time: f.time(s.expiresAt) })
                      : s.status === 'ended'
                        ? t('supportAccess.statusEnded', { time: f.time(s.endedAt ?? s.expiresAt) })
                        : t('supportAccess.statusExpired', { time: f.time(s.expiresAt) })}
                    {s.status === 'active' ? (
                      <Button
                        variant="tertiary"
                        data-size="sm"
                        aria-label={t('supportAccess.endListedFor', { tenant: nameOf(s.tenant) })}
                        onClick={() => {
                          void api
                            .endSupportSession(s.id, tRef.current('support.endedEarlyReason'))
                            .then(
                              () => retry(),
                              () => flash.show(tRef.current('supportAccess.endFailed'), 'danger'),
                            );
                        }}
                      >
                        {t('supportAccess.endListed')}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
};
