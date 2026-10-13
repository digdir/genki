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
import { Icon, icons } from '../../components/Icon';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import { ErrorState, Loading } from '../../states';
import type { ClientChannel, ClientView, ClientsView } from '../../types';
import { ClientForm, draftOf, slugFrom, specOf, type ClientDraft } from './ClientForm';
import { problemText, ServiceKeys } from './ServiceKeys';
import {
  browserSnippet,
  channelKeys,
  channelOrder,
  defaultApiBase,
  serverSnippet,
} from './snippets';
import './channels.css';
import { reasonProblem } from '../../components/ReasonField';

type Flash = { text: string; color: 'success' | 'info' | 'danger' };

const randomSecret = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const Endpoints = ({ view, apiBase }: { view: ClientsView; apiBase: string }) => {
  const t = useT();
  return (
    <section aria-labelledby="fe-endpoints-h" className="stack-sm">
      <Heading level={3} data-size="2xs" id="fe-endpoints-h">
        {t('serviceChannels.endpoints')}
      </Heading>
      <Paragraph data-size="sm" className="meta">
        {t.rich('serviceChannels.endpointsIntro', {
          apiBase,
          code: (c) => <code>{c}</code>,
        })}
      </Paragraph>
      <dl className="fe-endpoints">
        {channelOrder.map((c) => (
          <div key={c} className="fe-endpoint">
            <dt>{t(channelKeys[c])}</dt>
            <dd>
              {(view.endpoints[c] ?? []).map((e) => (
                <code key={e}>{e}</code>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
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
    <li className="fe-card stack-sm">
      <div className="fe-head">
        <span className="stack-xs">
          <span className="row-wrap">
            <Heading level={4} data-size="2xs">
              {name}
            </Heading>
            <Tag data-size="sm" data-color="accent">
              {spec.kind === 'browser'
                ? t('serviceChannels.kindBrowser')
                : t('serviceChannels.kindServer')}
            </Tag>
          </span>
          {spec.url ? (
            <Link href={spec.url} target="_blank" rel="noopener">
              {spec.url}
              <Icon d={icons.external} size={16} />
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
    </li>
  );
};

export const ServiceChannels = ({
  api,
  tenant,
  service,
  publicName,
  apiBase = defaultApiBase,
  onFrontends,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  publicName?: string;
  apiBase?: string;
  onFrontends?: (names: string[]) => void;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    (signal) => api.listClients(tenant, service, signal),
    [api, tenant, service],
  );
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
  const model = publicName ?? `${service}__default`;

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
    const name = client.definition.spec.webhook?.secret;
    if (!name) return;
    setBusy(true);
    try {
      const value = randomSecret();
      await api.setSecret(
        tenant,
        name,
        value,
        t('serviceChannels.secretReason', { id: client.definition.metadata.id }),
      );
      setNewSecret({ name, value });
    } catch (e) {
      notify(problemText(e, t), 'danger');
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return <Loading label={t('serviceChannels.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const view = state.data;

  return (
    <div className="fe-channels stack">
      {flash ? (
        <Alert data-color={flash.color} data-size="sm" role="status">
          {flash.text}
        </Alert>
      ) : null}
      <Endpoints view={view} apiBase={apiBase} />
      <section aria-labelledby="fe-clients-h" className="stack-sm">
        <div className="fe-head">
          <div className="stack-xs">
            <Heading level={3} data-size="2xs" id="fe-clients-h">
              {t('serviceChannels.own')}
            </Heading>
            <Paragraph data-size="sm" className="meta">
              {t('serviceChannels.ownIntro')}
            </Paragraph>
          </div>
          <Button
            variant="primary"
            data-size="sm"
            onClick={() => {
              setSaveError('');
              setEditing({});
            }}
          >
            {t('serviceChannels.register')}
          </Button>
        </div>
        {newSecret ? (
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
        ) : null}
        {editing ? (
          <ClientForm
            key={editing.client?.definition.metadata.id ?? 'ny'}
            initial={draftOf(editing.client, service)}
            isNew={!editing.client}
            saveError={saveError}
            onSave={(d) => void save(d)}
            onCancel={() => setEditing(undefined)}
          />
        ) : null}
        {view.clients.length === 0 ? (
          <div className="fe-empty">
            <span className="fe-empty-title">{t('serviceChannels.emptyTitle')}</span>
            <span className="meta">{t('serviceChannels.emptyBody')}</span>
          </div>
        ) : (
          <ul className="fe-cards" aria-label={t('serviceChannels.clientsLabel')}>
            {view.clients.map((c) => (
              <ClientCard
                key={c.definition.metadata.id}
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
            ))}
          </ul>
        )}
        {removing ? (
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
        ) : null}
      </section>
      <ServiceKeys
        api={api}
        tenant={tenant}
        service={service}
        clients={view.clients}
        onFlash={notify}
      />
    </div>
  );
};
