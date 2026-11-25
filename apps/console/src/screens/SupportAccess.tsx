import {
  Alert,
  Button,
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
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { navigate, useAsync } from '../hooks';
import { definitionKindLabels, definitionKindParams } from '../definition-kinds';
import { useT, type T } from '../i18n';
import { settingLabels } from '../setting-labels';
import { shapeFromSchema } from '../settings-model';
import { EmptyState, ErrorState, Loading } from '../states';
import { SupportDialog } from '../support-dialog';
import type { AuditEntry, EffectiveSettings, SettingInfo, TenantKey } from '../types';
import { Flash, formatDay, formatWhen, NotDecided, PageHeader, TableRegion, useFlash } from '../ui';
import { actionKey } from './Audit';

interface Org {
  tenant: string;
  name: string;
}

export interface Change {
  key: string;
  label: string;
  from: string;
  to: string;
  value: unknown;
}

type Field = {
  key: string;
  label: string;
  category: string;
  description?: string;
  locked?: string;
} & (
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

const fieldOf = (
  info: SettingInfo,
  current: unknown,
  locked: string | undefined,
  t: T,
): Field | undefined => {
  const named = settingLabels[info.key];
  const base = {
    key: info.key,
    label: named ? t(named.label) : info.key,
    category: named ? t(named.cat) : info.category,
    description: named?.desc ? t(named.desc) : info.description,
    ...(locked === undefined ? {} : { locked }),
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

const matches = (f: Field, needle: string) =>
  !needle || [f.key, f.label, f.description ?? ''].some((x) => x.toLowerCase().includes(needle));

const SettingsTab = ({
  api,
  org,
  focus,
  onSaved,
}: {
  api: ApiClient;
  org: Org;
  focus?: string | undefined;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    async (signal) => {
      const [catalog, effective] = await Promise.all([
        api.settingsCatalog(signal),
        api.tenantSettings(org.tenant, signal),
      ]);
      return { catalog, effective };
    },
    [api, org.tenant],
  );
  const [stored, setSaved] = useState<EffectiveSettings | undefined>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState('');
  const focused = useRef(false);
  const saved = stored ?? (state.status === 'ready' ? state.data.effective : undefined);

  const fields =
    state.status === 'ready' && saved
      ? state.data.catalog
          .filter((s) => s.sensitivity === 'normal' && s.settableAt.includes('tenant'))
          .flatMap((s) => {
            const f = fieldOf(s, saved[s.key]?.value ?? s.default, saved[s.key]?.locked, t);
            return f ? [f] : [];
          })
      : [];
  const valueOf = (key: string) => saved?.[key]?.value;
  const changes: Change[] = fields.flatMap((f) => {
    if (f.locked !== undefined || !(f.key in draft)) return [];
    const value = parse(f, draft[f.key] ?? '');
    if (show(value, t) === show(valueOf(f.key), t)) return [];
    return [
      { key: f.key, label: f.label, from: show(valueOf(f.key), t), to: show(value, t), value },
    ];
  });
  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready || !focus || focused.current) return;
    const target = document.getElementById(`setting-${focus}`);
    if (!target) return;
    focused.current = true;
    target.scrollIntoView?.({ block: 'center' });
    target.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, [ready, focus]);

  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingSettings')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const renderField = (f: Field) => {
    const current = f.key in draft ? (draft[f.key] ?? '') : show(valueOf(f.key), t);
    const set = (v: string) => setDraft((d) => ({ ...d, [f.key]: v }));
    if (f.locked !== undefined)
      return (
        <Textfield
          className="narrow"
          label={f.label}
          description={t('supportAccess.lockedBy', { reason: f.locked })}
          value={show(valueOf(f.key), t)}
          readOnly
        />
      );
    if (f.type === 'bool')
      return (
        <Switch
          label={f.label}
          description={f.description}
          checked={(f.key in draft ? draft[f.key] : String(valueOf(f.key))) === 'true'}
          onChange={(e) => set(String(e.target.checked))}
        />
      );
    if (f.type === 'enum')
      return (
        <div className="field narrow">
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
        className="narrow"
        label={f.label}
        description={f.description}
        inputMode={f.type === 'text' ? undefined : 'decimal'}
        value={current === t('supportAccess.notSet') ? '' : current}
        onChange={(e) => set(e.target.value)}
      />
    );
  };
  const first = changes[0];
  const needle = query.trim().toLowerCase();
  const shown = fields.filter((f) => matches(f, needle));
  const groups = [...new Set(shown.map((f) => f.category))].map((category) => ({
    category,
    items: shown.filter((f) => f.category === category),
  }));
  return (
    <Frame path={t('supportAccess.settingsPath')} tenant={org.name}>
      <Paragraph data-size="sm" className="meta">
        {t('supportAccess.tenantLevel', { tenant: org.name })}
      </Paragraph>
      {fields.length === 0 ? (
        <Paragraph>{t('supportAccess.noneSettable')}</Paragraph>
      ) : (
        <Textfield
          className="search-field"
          label={t('supportAccess.searchSettings')}
          description={t('supportAccess.searchSettingsHelp')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {fields.length > 0 && shown.length === 0 ? (
        <Paragraph>{t('supportAccess.noSettingMatch')}</Paragraph>
      ) : null}
      {groups.map(({ category, items }, i) => (
        <section key={category} className="stack-sm" aria-labelledby={`setting-group-${i}`}>
          <Heading level={3} data-size="2xs" id={`setting-group-${i}`}>
            {category}
          </Heading>
          {items.map((f) => (
            <div key={f.key} id={`setting-${f.key}`}>
              {renderField(f)}
            </div>
          ))}
        </section>
      ))}
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
        title={t('supportAccess.changeTitle', { tenant: org.name })}
        hint={t('supportAccess.reasonHint')}
        sees={t('supportAccess.seesChange', { tenant: org.name })}
        cta={t('supportAccess.saveAsDigdir')}
        api={{
          method: 'PUT',
          path: `/tenants/${org.tenant}/settings/${first?.key ?? '{key}'}`,
          body: () => ({ value: first?.value }),
        }}
        onClose={() => setConfirming(false)}
        onConfirm={async (reason) => {
          for (const c of changes) await api.setTenantSetting(org.tenant, c.key, c.value, reason);
          setSaved(
            Object.fromEntries(
              Object.entries(saved ?? {}).map(([k, v]) => {
                const c = changes.find((x) => x.key === k);
                return [k, c ? { ...v, value: c.value } : v];
              }),
            ),
          );
          setDraft({});
          onSaved(tRef.current('supportAccess.savedAsDigdir', { tenant: org.name }));
        }}
      >
        <ChangeList changes={changes} />
        <Paragraph data-size="sm">{t('supportAccess.affectsAll', { tenant: org.name })}</Paragraph>
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

const DraftsTab = ({ api, org }: { api: ApiClient; org: Org }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => api.tenantDefinitions(org.tenant, signal),
    [api, org.tenant],
  );
  return (
    <Frame path={t('supportAccess.servicesPath')} tenant={org.name}>
      <Paragraph data-size="sm" className="tag-line">
        {t('supportAccess.onlyTenantPublishes', { tenant: org.name })} <NotDecided />
        {t('supportAccess.operatorsPublish')}
      </Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('supportAccess.loadingServices')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <Paragraph>{t('supportAccess.noServices', { tenant: org.name })}</Paragraph>
      ) : (
        <ul className="plain row-list">
          {state.data.map((d) => (
            <li key={`${d.kind}/${d.id}`}>
              <span className="two-line grow">
                <a
                  href={`#/tenants/services?tenant=${org.tenant}&kind=${definitionKindParams[d.kind]}&id=${encodeURIComponent(d.id)}`}
                >
                  {d.name}
                </a>
                <span className="meta">
                  {d.publishedAt
                    ? t('supportAccess.publishedVersionOn', {
                        kind: t(definitionKindLabels[d.kind]),
                        version: d.latestVersion,
                        date: formatDay(d.publishedAt, f),
                      })
                    : t('supportAccess.publishedVersion', {
                        kind: t(definitionKindLabels[d.kind]),
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
  org,
  onSaved,
}: {
  api: ApiClient;
  org: Org;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync(
    (signal) => api.tenantKeys(org.tenant, signal),
    [api, org.tenant],
  );
  const [keys, setKeys] = useState<TenantKey[]>([]);
  const [revoking, setRevoking] = useState<TenantKey | undefined>();
  useEffect(() => {
    if (state.status === 'ready') setKeys(state.data);
  }, [state]);
  return (
    <Frame path={t('supportAccess.keysPath')} tenant={org.name}>
      <Alert data-color="info" data-size="sm">
        {t('supportAccess.keysNote')}
      </Alert>
      {state.status === 'loading' ? (
        <Loading label={t('supportAccess.loadingKeys')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : keys.length === 0 ? (
        <Paragraph>{t('supportAccess.noKeys', { tenant: org.name })}</Paragraph>
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
        lead={t('supportAccess.revokeLead', { tenant: org.name })}
        hint={t('supportAccess.reasonHint')}
        sees={t('supportAccess.seesChange', { tenant: org.name })}
        cta={t('supportAccess.revoke')}
        danger
        api={{
          method: 'POST',
          path: `/tenants/${org.tenant}/api-keys/${revoking?.id ?? ''}/revoke`,
        }}
        onClose={() => setRevoking(undefined)}
        onConfirm={async (reason) => {
          if (!revoking) return;
          const done = await api.revokeTenantKey(org.tenant, revoking.id, reason);
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
              tenant: org.name,
            }),
          );
        }}
      />
    </Frame>
  );
};

const LogTab = ({ api, org }: { api: ApiClient; org: Org }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.audit(org.tenant, signal), [api, org.tenant]);
  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingLog')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const latest = [...state.data].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const labelOf = (e: AuditEntry) => {
    const key = actionKey[e.action];
    return key ? t(key) : (e.actionLabel ?? e.action);
  };
  return (
    <Frame path={t('supportAccess.logPath', { tenant: org.name })} tenant={org.name}>
      {latest.length === 0 ? (
        <Paragraph>{t('supportAccess.noEntries')}</Paragraph>
      ) : (
        <ol className="plain log-rows">
          {latest.map((e) => (
            <li key={e.task}>
              <span className="meta">{formatWhen(e.at, f, t)}</span>
              <span className="two-line">
                <span className="label-strong">
                  {labelOf(e)}
                  {e.target ? `: ${e.target}` : ''}
                </span>
                <span className="meta">
                  {e.actorName ?? e.actor} · {e.reason}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Frame>
  );
};

const portalTabs = ['settings', 'drafts', 'keys', 'log'];

const Portal = ({
  api,
  org,
  initialTab,
  focus,
  onSaved,
}: {
  api: ApiClient;
  org: Org;
  initialTab?: string | undefined;
  focus?: string | undefined;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const [tab, setTab] = useState(
    initialTab && portalTabs.includes(initialTab) ? initialTab : 'settings',
  );
  return (
    <section className="stack" aria-labelledby="portal-h">
      <Heading level={2} data-size="xs" id="portal-h">
        {t('supportAccess.portalTitle', { tenant: org.name })}
      </Heading>
      <Tabs value={tab} onChange={setTab}>
        <TabsList aria-label={t('supportAccess.tabsLabel')}>
          <TabsTab value="settings">{t('supportAccess.tabSettings')}</TabsTab>
          <TabsTab value="drafts">{t('supportAccess.tabDrafts')}</TabsTab>
          <TabsTab value="keys">{t('supportAccess.tabKeys')}</TabsTab>
          <TabsTab value="log">{t('supportAccess.tabLog')}</TabsTab>
        </TabsList>
        <TabsPanel value="settings">
          <SettingsTab api={api} org={org} focus={focus} onSaved={onSaved} />
        </TabsPanel>
        <TabsPanel value="drafts">
          {tab === 'drafts' ? <DraftsTab api={api} org={org} /> : null}
        </TabsPanel>
        <TabsPanel value="keys">
          {tab === 'keys' ? <KeysTab api={api} org={org} onSaved={onSaved} /> : null}
        </TabsPanel>
        <TabsPanel value="log">{tab === 'log' ? <LogTab api={api} org={org} /> : null}</TabsPanel>
      </Tabs>
    </section>
  );
};

export const SupportAccess = ({
  api,
  tenant,
  tab,
  setting,
}: {
  api: ApiClient;
  tenant?: string | undefined;
  tab?: string | undefined;
  setting?: string | undefined;
}) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.listTenants(signal), [api]);
  const flash = useFlash();

  if (state.status === 'loading') return <Loading label={t('supportAccess.loadingTenants')} />;
  if (state.status === 'error')
    return (
      <>
        <PageHeader eyebrow={t('supportAccess.eyebrow')} title={t('supportAccess.title')} />
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const usable = state.data.filter((x) => x.status !== 'onboarding');
  const chosen = usable.find((x) => x.orgNumber === tenant) ?? usable[0];

  return (
    <>
      <PageHeader
        eyebrow={t('supportAccess.eyebrow')}
        title={t('supportAccess.title')}
        intro={t('supportAccess.intro')}
      />
      <Flash message={flash.message} />
      {chosen ? (
        <>
          <div className="field narrow">
            <Label htmlFor="org-pick">{t('supportAccess.tenant')}</Label>
            <Select
              id="org-pick"
              value={chosen.orgNumber}
              onChange={(e) => navigate('/support-access', { tenant: e.target.value })}
            >
              {usable.map((x) => (
                <Select.Option key={x.orgNumber} value={x.orgNumber}>
                  {x.name}
                </Select.Option>
              ))}
            </Select>
          </div>
          <Portal
            key={chosen.orgNumber}
            api={api}
            org={{ tenant: chosen.orgNumber, name: chosen.name }}
            {...(chosen.orgNumber === tenant ? { initialTab: tab, focus: setting } : {})}
            onSaved={(text) => flash.show(text)}
          />
        </>
      ) : (
        <EmptyState title={t('supportAccess.noTenants')} />
      )}
    </>
  );
};
