import {
  Alert,
  Button,
  Checkbox,
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
import { useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useT, type T } from '../../i18n';
import { navigate, splitRoute, useAsync, useHashRoute } from '../../hooks';
import { EmptyState, ErrorState, Loading } from '../../states';
import type { ConfigEntry, Tenant, ValidationProblem } from '../../types';
import { Flash, formatWhen, TableRegion, useFlash } from '../../ui';
import { formatOrgNumber } from '../Tenants';
import { reasonProblem } from '../../reason';

export interface RegistryPaths {
  list: string;
  item: (id: string) => string;
  history: (id: string) => string;
  create?: string;
}

export interface TenantView {
  id: string;
  name: string;
  onPlatformView: () => void;
}

interface Props {
  api: ApiClient;
  label: string;
  paths: RegistryPaths;
  tenant?: TenantView | undefined;
  template: Record<string, unknown>;
  mandatory?: boolean;
  describe?: (entry: ConfigEntry) => string;
  detail?: (entry: ConfigEntry) => ReactNode;
  filter?: (entry: ConfigEntry) => boolean;
}

const who = (actor?: string) =>
  actor ? actor.replace(/^(operator|employee):(entra:|ansattporten:|[^:]+:)?/, '') : '–';

export const localId = (entry: ConfigEntry) =>
  entry.scope && entry.scope !== 'platform' && entry.id.startsWith(`${entry.scope}/`)
    ? entry.id.slice(entry.scope.length + 1)
    : entry.id;

const editableIn = (entry: ConfigEntry, tenant: TenantView | undefined) =>
  tenant ? (entry.editable ?? entry.scope === tenant.id) : true;

const ownerOf = (entry: ConfigEntry, tenant: TenantView | undefined, t: T) =>
  !entry.scope || entry.scope === 'platform'
    ? t('config.platform')
    : entry.scope === tenant?.id
      ? tenant.name
      : entry.scope;

export interface ConfigScope {
  path: string;
  tab: string;
  tenant: string | undefined;
  tenants: Tenant[];
  view: TenantView | undefined;
  go: (tenant: string | undefined, tab?: string) => void;
}

export const useConfigScope = (api: ApiClient, path: string, tab: string): ConfigScope => {
  const { params } = splitRoute(useHashRoute());
  const tenant = params.has('tenant') ? (params.get('tenant') ?? '') : undefined;
  const [state] = useAsync((signal) => api.listTenants(signal), [api]);
  const tenants = state.status === 'ready' ? state.data : [];
  const go = (next: string | undefined, nextTab = tab) =>
    navigate(path, next === undefined ? { tab: nextTab } : { tab: nextTab, tenant: next });
  const view = tenant
    ? {
        id: tenant,
        name: tenants.find((t) => t.orgNumber === tenant)?.name ?? formatOrgNumber(tenant),
        onPlatformView: () => go(undefined),
      }
    : undefined;
  return { path, tab, tenant, tenants, view, go };
};

export const scopeEyebrow = (scope: ConfigScope) =>
  scope.view ? `${scope.view.name} · ${formatOrgNumber(scope.view.id)}` : undefined;

export const ScopeBar = ({ scope }: { scope: ConfigScope }) => {
  const t = useT();
  const { tenant, tenants, view, go } = scope;
  return (
    <div className="stack-sm">
      <div className="toolbar">
        <Fieldset>
          <FieldsetLegend>{t('config.scopeView')}</FieldsetLegend>
          <div className="chips">
            <Chip.Radio
              name="config-scope"
              checked={tenant === undefined}
              onChange={() => go(undefined)}
            >
              {t('config.scopePlatform')}
            </Chip.Radio>
            <Chip.Radio
              name="config-scope"
              checked={tenant !== undefined}
              onChange={() => go(tenant || (tenants[0]?.orgNumber ?? ''))}
            >
              {t('config.scopeOneTenant')}
            </Chip.Radio>
          </div>
        </Fieldset>
        {tenant !== undefined ? (
          <div className="field">
            <Label htmlFor="config-tenant">{t('config.tenant')}</Label>
            <Select id="config-tenant" value={tenant} onChange={(e) => go(e.target.value)}>
              {tenant ? null : <Select.Option value="">{t('config.chooseTenant')}</Select.Option>}
              {tenant && !tenants.some((t) => t.orgNumber === tenant) ? (
                <Select.Option value={tenant}>{formatOrgNumber(tenant)}</Select.Option>
              ) : null}
              {tenants.map((t) => (
                <Select.Option key={t.orgNumber} value={t.orgNumber}>
                  {t.name} ({formatOrgNumber(t.orgNumber)})
                </Select.Option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      {view ? (
        <Alert data-color="info" data-size="sm">
          {t('config.editingFor', { name: view.name })}
        </Alert>
      ) : null}
    </div>
  );
};

export const refusedWithoutSupport = (
  api: ApiClient,
  tenant: TenantView | undefined,
  error: unknown,
) =>
  tenant !== undefined &&
  !api.supportHeld(tenant.id) &&
  error instanceof ApiError &&
  (error.status === 404 || error.status === 403);

export const SupportNeeded = ({ tenant }: { tenant: TenantView }) => {
  const t = useT();
  return (
    <EmptyState title={t('config.supportNeededTitle')}>
      <Paragraph>{t('config.supportNeededText', { name: tenant.name })}</Paragraph>
      <Button
        variant="secondary"
        data-size="sm"
        onClick={() => navigate('/support-access', { tenant: tenant.id })}
      >
        {t('config.supportNeededAction')}
      </Button>
    </EmptyState>
  );
};

const problemText = (error: unknown, t: T) => {
  const errors =
    error instanceof ApiError
      ? (error.problem as ValidationProblem | undefined)?.errors
      : undefined;
  return errors?.length
    ? errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('. ')
    : t('config.noAnswer');
};

const History = ({ api, path }: { api: ApiClient; path: string }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.configHistory(path, signal), [api, path]);
  if (state.status === 'loading') return <Loading label={t('config.loadingVersions')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (state.data.length === 0) return <Paragraph data-size="sm">{t('config.noChanges')}</Paragraph>;
  return (
    <ol className="plain config-history">
      {[...state.data].reverse().map((v) => (
        <li key={v.version}>
          <span className="label-strong">{t('config.version', { version: v.version })}</span>
          {v.deleted ? (
            <Tag data-size="sm" data-color="danger">
              {t('config.deleted')}
            </Tag>
          ) : null}{' '}
          <span className="meta">
            {formatWhen(v.at, f, t)} · {who(v.by)}
            {v.reason ? ` · ${v.reason}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
};

const Editor = ({
  api,
  paths,
  entry,
  template,
  mandatory,
  detail,
  tenant,
  onSaved,
  onCancel,
}: {
  api: ApiClient;
  paths: RegistryPaths;
  entry: ConfigEntry | undefined;
  template: Record<string, unknown>;
  mandatory: boolean;
  detail?: ((entry: ConfigEntry) => ReactNode) | undefined;
  tenant: TenantView | undefined;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [id, setId] = useState('');
  const [text, setText] = useState(JSON.stringify(entry?.spec ?? template, null, 2));
  const [required, setRequired] = useState(entry?.mandatory ?? false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = entry ? localId(entry) : id.trim();
  const readOnly = entry ? !editableIn(entry, tenant) : false;
  const logged = tenant
    ? t('config.loggedAtTenant', { name: tenant.name })
    : t('config.loggedInAudit');

  const save = async () => {
    const next: Record<string, string> = {};
    let spec: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      spec = parsed as Record<string, unknown>;
    } catch {
      next.spec = t('config.invalidJson');
    }
    if (!entry && !/^[a-z0-9][a-z0-9._/-]*$/.test(target)) next.id = t('config.invalidId');
    const reasonError = reasonProblem(t, reason);
    if (reasonError) next.reason = reasonError;
    setErrors(next);
    if (Object.keys(next).length || !spec) return;
    setBusy(true);
    setFailed(undefined);
    setConflict(false);
    try {
      const body = mandatory ? { ...spec, mandatory: required } : spec;
      if (!entry && paths.create)
        await api.configSave(paths.create, { ...body, id: target }, { reason, method: 'POST' });
      else
        await api.configSave(paths.item(target), body, {
          reason,
          ifVersion: entry?.version,
        });
      onSaved(t('config.saved', { id: target, logged }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else setFailed(problemText(error, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    const reasonError = reasonProblem(t, reason);
    if (reasonError) {
      setErrors({ reason: reasonError });
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await api.configDelete(paths.item(target), reason);
      onSaved(t('config.removed', { id: target, logged }));
    } catch (error) {
      setFailed(problemText(error, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="config-editor-h">
      <Heading level={3} data-size="xs" id="config-editor-h">
        {entry
          ? t('config.titleExisting', {
              action: readOnly ? t('config.view') : t('config.change'),
              id: target,
            })
          : t('config.titleNew')}
      </Heading>
      {entry ? (
        <Paragraph data-size="sm" className="meta">
          {t('config.version', { version: entry.version })}
          {entry.scope ? ` · ${ownerOf(entry, tenant, t)}` : ''}
          {entry.origin === 'seed' ? t('config.fromConfigFile') : ''}
        </Paragraph>
      ) : (
        <Textfield
          label={t('config.idLabel')}
          value={id}
          onChange={(e) => setId(e.target.value)}
          error={errors.id}
        />
      )}
      <Textfield
        label={t('config.contentLabel')}
        multiline
        rows={14}
        className="config-json"
        value={text}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        error={errors.spec}
      />
      {readOnly ? <Paragraph data-size="sm">{t('config.platformOwned')}</Paragraph> : null}
      {mandatory && !readOnly ? (
        <Checkbox
          label={t('config.requiredLabel')}
          description={t('config.requiredHint')}
          checked={required}
          onChange={() => setRequired((v) => !v)}
        />
      ) : null}
      {readOnly ? null : (
        <Textfield
          label={t('common.reason')}
          description={t('config.reasonHint')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
      )}
      {conflict ? (
        <Alert data-color="warning" data-size="sm" role="alert">
          {t('config.conflict')}
        </Alert>
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      <div className="actions-row">
        {readOnly ? (
          <Button data-size="sm" variant="secondary" onClick={tenant?.onPlatformView}>
            {t('config.changeInPlatform')}
          </Button>
        ) : (
          <Button data-size="sm" loading={busy} onClick={() => !busy && void save()}>
            {entry ? t('config.saveVersion') : t('config.create')}
          </Button>
        )}
        {entry && !entry.builtin && !readOnly ? (
          <Button
            variant="tertiary"
            data-color="danger"
            data-size="sm"
            onClick={() => !busy && void remove()}
          >
            {t('config.delete')}
          </Button>
        ) : null}
        <Button variant="secondary" data-size="sm" onClick={onCancel}>
          {t('common.close')}
        </Button>
      </div>
      {entry && detail && !readOnly ? detail(entry) : null}
      {entry && !readOnly ? (
        <div className="stack-sm">
          <Heading level={4} data-size="2xs">
            {t('config.versions')}
          </Heading>
          <History api={api} path={paths.history(target)} />
        </div>
      ) : null}
    </section>
  );
};

export const Registry = ({
  api,
  label,
  paths,
  template,
  mandatory = false,
  describe,
  detail,
  filter,
  tenant,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.configList(paths.list, signal),
    [api, paths.list, round],
  );
  const [open, setOpen] = useState<string | 'new'>();
  const flash = useFlash();
  if (state.status === 'loading')
    return <Loading label={t('config.loading', { label: label.toLowerCase() })} />;
  if (state.status === 'error')
    return refusedWithoutSupport(api, tenant, state.error) && tenant ? (
      <SupportNeeded tenant={tenant} />
    ) : (
      <ErrorState error={state.error} onRetry={retry} />
    );
  const rows = state.data.data.filter(filter ?? (() => true));
  const selected = rows.find((r) => `${r.scope ?? ''}/${r.id}` === open);
  return (
    <div className="stack">
      <Flash message={flash.message} />
      <div className="card-head">
        <span className="meta">{t('config.entries', { count: rows.length })}</span>
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => {
            flash.clear();
            setOpen('new');
          }}
        >
          {t('config.new')}
        </Button>
      </div>
      {open === 'new' ? (
        <Editor
          api={api}
          paths={paths}
          entry={undefined}
          template={template}
          mandatory={mandatory}
          tenant={tenant}
          onCancel={() => setOpen(undefined)}
          onSaved={(message) => {
            flash.show(message);
            setOpen(undefined);
            setRound((r) => r + 1);
          }}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t('config.none', { label: label.toLowerCase() })} />
      ) : (
        <TableRegion label={label}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('config.colId')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  {tenant ? t('config.colOwner') : t('config.colApplies')}
                </TableHeaderCell>
                <TableHeaderCell scope="col">{t('config.colVersion')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('config.colChanged')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <span className="visually-hidden">{t('config.colActions')}</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.scope ?? ''}/${r.id}`}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>
                        {tenant ? localId(r) : r.id}{' '}
                        {r.mandatory ? (
                          <Tag data-size="sm" data-color="warning">
                            {t('config.required')}
                          </Tag>
                        ) : null}
                        {r.builtin ? (
                          <Tag data-size="sm" data-color="neutral">
                            {t('config.builtin')}
                          </Tag>
                        ) : null}
                      </span>
                      {describe ? <span className="meta">{describe(r)}</span> : null}
                    </span>
                  </TableHeaderCell>
                  <TableCell>{ownerOf(r, tenant, t)}</TableCell>
                  <TableCell>{r.version}</TableCell>
                  <TableCell className="sm">
                    {r.at
                      ? `${formatWhen(r.at, f, t)} · ${who(r.by)}`
                      : t('config.fromConfigFileCell')}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      onClick={() => {
                        flash.clear();
                        setOpen(`${r.scope ?? ''}/${r.id}`);
                      }}
                    >
                      {editableIn(r, tenant) ? t('config.open') : t('config.show')}
                      <span className="visually-hidden">{r.id}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {selected ? (
        <Editor
          key={`${selected.id}@${selected.version}`}
          api={api}
          paths={paths}
          entry={selected}
          template={template}
          mandatory={mandatory}
          tenant={tenant}
          detail={detail}
          onCancel={() => setOpen(undefined)}
          onSaved={(message) => {
            flash.show(message);
            setOpen(undefined);
            setRound((r) => r + 1);
          }}
        />
      ) : null}
    </div>
  );
};
