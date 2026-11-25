import { ExternalLinkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import { ErrorState, Loading } from '../../states';
import { useRights } from '../../Shell';
import type {
  ClientChannel,
  ClientSpec,
  ClientView,
  ClientsView,
  ServiceKeyView,
} from '../../types';
import { BackLink } from '../../components/BackLink';
import { clock, placeName } from './dev-format';
import { servicePath } from './sections';
import { ClientForm, draftOf, slugFrom, specOf, type ClientDraft } from './ClientForm';
import { problemText, ServiceKeys } from './ServiceKeys';
import { ServiceAddress } from './ServiceAddress';
import {
  browserSnippet,
  channelKeys,
  channelOrder,
  defaultApiBase,
  serverSnippet,
} from './snippets';
import './channels.css';
import { reasonProblem } from '../../components/ReasonField';
import { hostsToStore, SecretHostsProblem } from '../../secret-hosts';
import './sections.css';

type Flash = { text: string; color: 'success' | 'info' | 'danger' };

const randomSecret = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const apiReferenceHash = '#/developer/api/reference';

const endpointChannels: [ClientChannel, PlainKey][] = [
  ['rest', 'serviceDev.endpointRest'],
  ['openai', 'serviceDev.endpointOpenai'],
  ['mcp', 'serviceDev.endpointMcp'],
];

const Endpoints = ({
  view,
  model,
  apiBase,
}: {
  view: ClientsView;
  model: string;
  apiBase: string;
}) => {
  const t = useT();
  return (
    <section aria-labelledby="fe-endpoints-h" className="stack-sm dv-panel">
      <div className="row-between">
        <Heading level={3} data-size="2xs" id="fe-endpoints-h">
          {t('serviceDev.endpoints')}
        </Heading>
        <Link href={apiReferenceHash}>{t('serviceDev.apiReference')}</Link>
      </div>
      <dl className="dv-endpoints">
        {endpointChannels.map(([c, label]) => {
          const posts = (view.endpoints[c] ?? []).filter((e) => e.startsWith('POST '));
          const shown = posts.length ? posts : (view.endpoints[c] ?? []);
          if (shown.length === 0) return null;
          return (
            <div key={c}>
              <dt>{t(label)}</dt>
              <dd>
                {shown.map((e) => (
                  <code key={e}>
                    {e.endsWith('/chat/completions')
                      ? t('serviceDev.openaiModel', { endpoint: e, model })
                      : e}
                  </code>
                ))}
              </dd>
            </div>
          );
        })}
      </dl>
      <details className="dv-frontend-details">
        <summary>{t('serviceDev.allEndpoints')}</summary>
        <Paragraph data-size="sm" className="meta">
          {t.rich('serviceChannels.endpointsIntro', {
            apiBase,
            code: (c) => <code>{c}</code>,
          })}
        </Paragraph>
        <dl className="dv-endpoints">
          {channelOrder.map((c) =>
            view.endpoints[c]?.length ? (
              <div key={c}>
                <dt>{t(channelKeys[c])}</dt>
                <dd>
                  {view.endpoints[c].map((e) => (
                    <code key={e}>{e}</code>
                  ))}
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      </details>
    </section>
  );
};

const hostOf = (spec: ClientSpec) => {
  const address = spec.url ?? spec.allowedOrigins[0];
  if (!address) return undefined;
  try {
    return new URL(address).host;
  } catch {
    return undefined;
  }
};

const frontendLine = (
  client: ClientView,
  keys: ServiceKeyView[],
  t: T,
  clockOf: (iso: string) => string,
) => {
  const { spec, metadata } = client.definition;
  const names = spec.channels
    .filter((c) => c !== 'openai' || spec.channels.length === 1)
    .map((c, i) => {
      const name = t(channelKeys[c]);
      return i === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
    });
  const channels =
    names.length > 1
      ? t('serviceDev.and', { first: names.slice(0, -1).join(', '), last: names.at(-1) ?? '' })
      : (names[0] ?? '');
  const bound = keys.filter((k) => !k.revokedAt && k.client === metadata.id).length;
  const host = spec.kind === 'browser' ? hostOf(spec) : undefined;
  const last = client.deliveries[0];
  return [
    channels,
    host ? t('serviceDev.frontendFrom', { host }) : '',
    spec.webhook ? t('serviceDev.frontendWebhook') : '',
    spec.webhook && last
      ? t('serviceDev.lastDelivery', {
          time: clockOf(last.at),
          result: last.ok ? t('serviceDev.deliveryOk') : t('serviceDev.deliveryFailed'),
        })
      : '',
    bound ? t('serviceDev.frontendKeys', { count: bound }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
};

const ClientCard = ({
  client,
  view,
  apiBase,
  model,
  busy,
  onEdit,
  onRemove,
  onTestWebhook,
  onNewSecret,
}: {
  client: ClientView;
  view: ClientsView;
  apiBase: string;
  model: string;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onTestWebhook: () => void;
  onNewSecret: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const { metadata, spec } = client.definition;
  const name = metadata.name ?? metadata.id;
  const last = client.deliveries[0];
  const snippet =
    spec.kind === 'browser'
      ? browserSnippet(apiBase, model, spec, view.oidc)
      : serverSnippet(apiBase, model, spec.channels);
  return (
    <div className="fe-card stack-sm">
      <div className="fe-head">
        <span className="stack-xs">
          <span className="row-wrap">
            <Heading level={2} data-size="md">
              {name}
            </Heading>
            <Tag data-size="sm" data-color="accent">
              {spec.kind === 'browser'
                ? t('serviceChannels.kindBrowser')
                : t('serviceChannels.kindServer')}
            </Tag>
          </span>
          {spec.environments?.length ? (
            <span className="meta">
              {t('serviceChannels.environmentsLine', {
                list: spec.environments.map((name) => placeName(t, name)).join(', '),
              })}
            </span>
          ) : null}
          {spec.url ? (
            <Link href={spec.url} target="_blank" rel="noopener">
              {spec.url}
              <Icon icon={ExternalLinkIcon} size={16} />
              <span className="visually-hidden">{t('serviceChannels.newTab')}</span>
            </Link>
          ) : null}
        </span>
        <div className="actions">
          <Button
            variant="secondary"
            data-size="sm"
            aria-label={t('serviceChannels.editLabel', { name })}
            onClick={onEdit}
          >
            {t('serviceChannels.edit')}
          </Button>
          <Button
            variant="tertiary"
            data-size="sm"
            data-color="danger"
            aria-label={t('serviceChannels.removeLabel', { name })}
            onClick={onRemove}
          >
            {t('serviceChannels.remove')}
          </Button>
        </div>
      </div>
      <dl className="fe-facts">
        <div>
          <dt>{t('serviceChannels.channels')}</dt>
          <dd className="row-wrap">
            {spec.channels.map((c: ClientChannel) => (
              <Tag key={c} data-size="sm" data-color="neutral">
                {t(channelKeys[c])}
              </Tag>
            ))}
          </dd>
        </div>
        <div>
          <dt>{t('serviceChannels.origins')}</dt>
          <dd>
            {spec.allowedOrigins.length
              ? spec.allowedOrigins.join(', ')
              : t('serviceChannels.none')}
          </dd>
        </div>
        {spec.oidc ? (
          <>
            <div>
              <dt>{t('serviceChannels.clientId')}</dt>
              <dd className="row-wrap">
                <code>{spec.oidc.clientId}</code>
                <CopyButton
                  text={spec.oidc.clientId}
                  ariaLabel={t('serviceChannels.copyClientId', { name })}
                />
              </dd>
            </div>
            <div>
              <dt>{t('serviceChannels.redirects')}</dt>
              <dd>{spec.oidc.redirectUris.join(', ')}</dd>
            </div>
            <div>
              <dt>{t('serviceChannels.login')}</dt>
              <dd>{t('serviceChannels.loginValue')}</dd>
            </div>
          </>
        ) : null}
        {spec.webhook ? (
          <div>
            <dt>{t('serviceChannels.notifications')}</dt>
            <dd className="stack-xs">
              <span>{spec.webhook.url}</span>
              <span className="meta">
                {t.rich('serviceChannels.signedWith', {
                  secret: spec.webhook.secret,
                  code: (c) => <code>{c}</code>,
                })}
                {last
                  ? t('serviceChannels.lastSent', {
                      when: f.dateTime(last.at, 'medium'),
                      result: last.ok
                        ? t('serviceChannels.delivered')
                        : t('serviceChannels.failedWith', {
                            reason: String(
                              last.error ?? last.status ?? t('serviceChannels.unknown'),
                            ),
                          }),
                    })
                  : t('serviceChannels.neverSent')}
              </span>
              <span className="actions">
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-disabled={busy}
                  onClick={() => !busy && onTestWebhook()}
                >
                  {t('serviceChannels.sendTest')}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-disabled={busy}
                  onClick={() => !busy && onNewSecret()}
                >
                  {t('serviceChannels.newSecret')}
                </Button>
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      <details className="fe-snippet">
        <summary>{t('serviceChannels.connect')}</summary>
        <div className="stack-xs">
          <span className="row-wrap">
            <span className="meta">
              {spec.kind === 'browser'
                ? t('serviceChannels.connectBrowser')
                : t('serviceChannels.connectServer')}
            </span>
            <CopyButton text={snippet} ariaLabel={t('serviceChannels.copyExample', { name })} />
          </span>
          <pre>
            <code>{snippet}</code>
          </pre>
          <span className="meta">{t('serviceChannels.connectContract')}</span>
        </div>
      </details>
    </div>
  );
};

export const ServiceChannels = ({
  api,
  tenant,
  service,
  publicName,
  serviceName,
  apiBase = defaultApiBase,
  onFrontends,
  frontend,
  listHref = `#${servicePath(service, 'channels')}`,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  publicName?: string;
  serviceName?: string;
  apiBase?: string;
  onFrontends?: (names: string[]) => void;
  frontend?: string | undefined;
  listHref?: string;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const canManage = useRights().has('manage-services');
  const [createRequest, setCreateRequest] = useState(0);
  const [named] = useAsync(
    async (signal) =>
      serviceName === undefined
        ? ((
            (await api.getDefinition(tenant, 'Service', service, signal).catch(() => undefined))
              ?.latest.definition.metadata as { name?: string } | undefined
          )?.name ?? undefined)
        : serviceName,
    [api, tenant, service, serviceName],
  );
  const [keys, setKeys] = useState<ServiceKeyView[]>([]);
  const [state, retry] = useAsync(
    (signal) => api.listClients(tenant, service, signal),
    [api, tenant, service],
  );
  const [environments] = useAsync(
    async (signal) =>
      (
        await api.environments.list(tenant, service, signal).catch(() => undefined)
      )?.environments.map((e) => e.name) ?? [],
    [api, tenant, service],
  );
  const environmentNames = environments.status === 'ready' ? environments.data : [];
  useEffect(() => {
    if (state.status === 'ready')
      onFrontends?.(
        state.data.clients.map((c) => c.definition.metadata.name ?? c.definition.metadata.id),
      );
  }, [state]);
  const [editing, setEditing] = useState<{ client?: ClientView } | undefined>();
  const [saveError, setSaveError] = useState('');
  const [removing, setRemoving] = useState<ClientView>();
  const [removeReason, setRemoveReason] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [flash, setFlash] = useState<Flash>();
  const [newSecret, setNewSecret] = useState<{ name: string; value: string }>();
  const [busy, setBusy] = useState(false);
  const model = publicName || `${service}__default`;

  const notify = (text: string, color: Flash['color'] = 'success') => setFlash({ text, color });

  const save = async (draft: ClientDraft) => {
    const id = editing?.client?.definition.metadata.id ?? slugFrom(draft.name);
    try {
      setSaveError('');
      await api.saveClient(
        tenant,
        id,
        { metadata: { name: draft.name.trim() }, spec: specOf(draft, service) },
        draft.reason.trim(),
      );
      notify(
        editing?.client
          ? t('serviceChannels.changed', { name: draft.name.trim() })
          : t('serviceChannels.registered', { name: draft.name.trim() }),
      );
      setEditing(undefined);
      retry();
    } catch (e) {
      setSaveError(problemText(e, t));
    }
  };

  const remove = async (client: ClientView) => {
    const reasonError = reasonProblem(removeReason);
    if (reasonError) return setRemoveError(reasonError);
    try {
      await api.removeClient(tenant, client.definition.metadata.id, removeReason.trim());
      setRemoving(undefined);
      if (frontend) window.location.hash = listHref;
      notify(
        t('serviceChannels.removed', {
          name: client.definition.metadata.name ?? client.definition.metadata.id,
        }),
      );
      retry();
    } catch (e) {
      setRemoveError(problemText(e, t));
    }
  };

  const testWebhook = async (client: ClientView) => {
    setBusy(true);
    try {
      const delivery = await api.testWebhook(
        tenant,
        client.definition.metadata.id,
        t('serviceChannels.testReason'),
      );
      notify(
        delivery.ok
          ? t('serviceChannels.testDelivered')
          : t('serviceChannels.testFailed', {
              reason:
                delivery.error ??
                t('serviceChannels.answer', {
                  status: String(delivery.status ?? t('serviceChannels.unknown')),
                }),
            }),
        delivery.ok ? 'success' : 'danger',
      );
      retry();
    } catch (e) {
      notify(problemText(e, t), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const rollSecret = async (client: ClientView) => {
    const webhook = client.definition.spec.webhook;
    if (!webhook?.secret) return;
    const name = webhook.secret;
    setBusy(true);
    try {
      const value = randomSecret();
      const allowedHosts = await hostsToStore(api, tenant, name, new URL(webhook.url).origin, t);
      await api.setSecret(
        tenant,
        name,
        value,
        t('serviceChannels.secretReason', { id: client.definition.metadata.id }),
        allowedHosts,
      );
      setNewSecret({ name, value });
    } catch (e) {
      notify(e instanceof SecretHostsProblem ? e.message : problemText(e, t), 'danger');
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading')
    return <Loading label={t('serviceChannels.loading')} shape="list" onRetry={retry} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const view = state.data;

  const name = serviceName ?? (named.status === 'ready' ? named.data : undefined) ?? service;

  const secretAlert = newSecret ? (
    <Alert data-color="warning">
      <Heading level={4} data-size="2xs">
        {t('serviceChannels.copySecretNow')}
      </Heading>
      <Paragraph>{t('serviceChannels.secretOnce')}</Paragraph>
      <div className="actions">
        <code
          className="fe-secret"
          aria-label={t('serviceChannels.newValueFor', { name: newSecret.name })}
        >
          {newSecret.value}
        </code>
        <CopyButton text={newSecret.value} ariaLabel={t('serviceChannels.copySecret')} />
        <Button variant="tertiary" data-size="sm" onClick={() => setNewSecret(undefined)}>
          {t('serviceChannels.savedSecret')}
        </Button>
      </div>
    </Alert>
  ) : null;
  const editForm = editing ? (
    <ClientForm
      key={editing.client?.definition.metadata.id ?? 'ny'}
      initial={draftOf(editing.client, service)}
      isNew={!editing.client}
      environments={environmentNames}
      saveError={saveError}
      onSave={(d) => void save(d)}
      onCancel={() => setEditing(undefined)}
    />
  ) : null;
  const removeConfirm = removing ? (
    <Alert data-color="danger" data-size="sm">
      <Paragraph data-size="sm">
        {t('serviceChannels.removeWarning', {
          name: removing.definition.metadata.name ?? removing.definition.metadata.id,
        })}
      </Paragraph>
      <Textfield
        id="fe-remove-reason"
        className="fe-field-md"
        data-size="sm"
        label={t('serviceChannels.reason')}
        value={removeReason}
        error={removeError || undefined}
        onChange={(e) => {
          setRemoveReason(e.target.value);
          setRemoveError('');
        }}
      />
      <div className="actions">
        <Button
          variant="primary"
          data-color="danger"
          data-size="sm"
          onClick={() => void remove(removing)}
        >
          {t('serviceChannels.removeClient')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={() => setRemoving(undefined)}>
          {t('serviceChannels.cancel')}
        </Button>
      </div>
    </Alert>
  ) : null;

  const cardFor = (c: ClientView) => (
    <ClientCard
      client={c}
      view={view}
      apiBase={apiBase}
      model={model}
      busy={busy}
      onEdit={() => {
        setSaveError('');
        setEditing({ client: c });
      }}
      onRemove={() => {
        setRemoving(c);
        setRemoveReason('');
        setRemoveError('');
      }}
      onTestWebhook={() => void testWebhook(c)}
      onNewSecret={() => void rollSecret(c)}
    />
  );
  const flashAlert = flash ? (
    <Alert data-color={flash.color} data-size="sm" role="status">
      {flash.text}
    </Alert>
  ) : null;

  if (frontend) {
    const shown = view.clients.find((c) => c.definition.metadata.id === frontend);
    return (
      <div className="fe-channels stack">
        <BackLink label={t('service.sectionChannels')} href={listHref} />
        {flashAlert}
        {secretAlert}
        {editForm}
        {shown ? (
          cardFor(shown)
        ) : (
          <>
            <Heading level={2} data-size="md">
              {frontend}
            </Heading>
            <Paragraph>{t('serviceChannels.frontendMissing', { id: frontend })}</Paragraph>
          </>
        )}
        {removeConfirm}
      </div>
    );
  }

  return (
    <div className="fe-channels stack">
      <div className="dv-head">
        <div className="stack-xs">
          <Heading level={2} data-size="md">
            {t('service.sectionChannels')}
          </Heading>
          <Paragraph className="meta dv-lead">{t('serviceDev.keysLead', { name })}</Paragraph>
        </div>
        {canManage ? (
          <Button variant="primary" onClick={() => setCreateRequest((n) => n + 1)}>
            {t('serviceDev.createKey')}
          </Button>
        ) : null}
      </div>
      {flashAlert}
      <ServiceAddress api={api} tenant={tenant} service={service} canManage={canManage} />
      <ServiceKeys
        api={api}
        tenant={tenant}
        service={service}
        clients={view.clients}
        environments={environmentNames}
        onFlash={notify}
        createRequest={createRequest}
        onKeys={setKeys}
        now={now}
      />
      <div className="dv-columns">
        <section aria-labelledby="fe-clients-h" className="stack-sm dv-panel">
          <div className="row-between">
            <Heading level={3} data-size="2xs" id="fe-clients-h">
              {t('serviceDev.frontends')}
            </Heading>
            {canManage ? (
              <Link
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setSaveError('');
                  setEditing({});
                }}
              >
                {t('serviceDev.registerFrontend')}
              </Link>
            ) : null}
          </div>
          {secretAlert}
          {editForm}
          {view.clients.length === 0 ? (
            <Paragraph data-size="sm" className="meta">
              {t('serviceDev.noFrontendsYet')}
            </Paragraph>
          ) : (
            <ul className="dv-frontends" aria-label={t('serviceChannels.clientsLabel')}>
              {view.clients.map((c) => {
                const clientName = c.definition.metadata.name ?? c.definition.metadata.id;
                return (
                  <li key={c.definition.metadata.id}>
                    <strong>{clientName}</strong>
                    <span className="meta">{frontendLine(c, keys, t, (iso) => clock(iso, f))}</span>
                    <Link
                      href={`${listHref}/${encodeURIComponent(c.definition.metadata.id)}`}
                      aria-label={t('serviceDev.frontendDetails', { name: clientName })}
                    >
                      {t('serviceChannels.openFrontend')}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {removeConfirm}
        </section>
        <Endpoints view={view} model={model} apiBase={apiBase} />
      </div>
    </div>
  );
};
