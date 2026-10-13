import {
  Alert,
  Button,
  Dialog,
  Field,
  Label,
  Paragraph,
  Select,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import type { ClientView } from '../../types';
import { ClientForm, draftOf, slugFrom, specOf, type ClientDraft } from '../service/ClientForm';
import { problemText } from '../service/ServiceKeys';
import { channelKeys } from '../service/snippets';
import { ItemList, type ItemRowData } from './ItemList';

type Flash = (text: string, color?: 'success' | 'info' | 'danger') => void;

const nameOf = (c: ClientView) => c.definition.metadata.name ?? c.definition.metadata.id;

const newDraft = (service: string): ClientDraft => ({
  ...draftOf(undefined, service),
  kind: 'browser',
  channels: ['openai', 'conversations', 'feedback'],
});

export const Frontends = ({
  api,
  tenant,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  onFlash: Flash;
}) => {
  const t = useT();
  const f = useFormat();
  const { has } = useRights();
  const canManage = has('manage-services');
  const [tick, setTick] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      const [view, overview] = await Promise.all([
        api.listClients(tenant, undefined, signal),
        api.overview(tenant, signal).catch(() => undefined),
      ]);
      return { clients: view.clients, services: overview?.services ?? [] };
    },
    [api, tenant, tick],
  );
  const [open, setOpen] = useState<string>();
  const [editing, setEditing] = useState<{ client?: ClientView; service: string }>();
  const [saveError, setSaveError] = useState('');
  const [removing, setRemoving] = useState<ClientView>();
  const [removeReason, setRemoveReason] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [busy, setBusy] = useState<string>();

  if (state.status === 'loading') return <Loading label={t('integFrontends.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { clients, services } = state.data;
  const serviceName = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  const reload = () => setTick((t) => t + 1);

  const save = async (draft: ClientDraft) => {
    if (!editing) return;
    const id = editing.client?.definition.metadata.id ?? slugFrom(draft.name);
    try {
      setSaveError('');
      await api.saveClient(
        tenant,
        id,
        { metadata: { name: draft.name.trim() }, spec: specOf(draft, editing.service) },
        draft.reason.trim(),
      );
      onFlash(
        t(editing.client ? 'integFrontends.changed' : 'integFrontends.registered', {
          name: draft.name.trim(),
        }),
      );
      setOpen(id);
      setEditing(undefined);
      reload();
    } catch (e) {
      setSaveError(problemText(e, t));
    }
  };

  const remove = async () => {
    if (!removing) return;
    const reasonError = reasonProblem(removeReason, t);
    if (reasonError) return setRemoveError(reasonError);
    try {
      await api.removeClient(tenant, removing.definition.metadata.id, removeReason.trim());
      onFlash(t('integrations.frontendRemoved', { name: nameOf(removing) }));
      setRemoving(undefined);
      reload();
    } catch (e) {
      setRemoveError(problemText(e, t));
    }
  };

  const testWebhook = async (client: ClientView) => {
    setBusy(client.definition.metadata.id);
    try {
      const delivery = await api.testWebhook(
        tenant,
        client.definition.metadata.id,
        t('integFrontends.testReason'),
      );
      onFlash(
        delivery.ok
          ? t('integFrontends.testDelivered')
          : t('integFrontends.testNotDelivered', {
              reason:
                delivery.error ??
                t('integFrontends.testStatus', { status: delivery.status ?? t('common.unknown') }),
            }),
        delivery.ok ? 'success' : 'danger',
      );
      reload();
    } catch (e) {
      onFlash(problemText(e, t), 'danger');
    } finally {
      setBusy(undefined);
    }
  };

  const items: ItemRowData[] = clients.map((c) => {
    const { metadata, spec } = c.definition;
    const name = nameOf(c);
    const last = c.deliveries[0];
    const webhookFails = Boolean(spec.webhook && last && !last.ok);
    const redirect = spec.oidc?.redirectUris.join(', ') ?? '';
    const testAction = {
      label: t('integFrontends.sendTest'),
      variant: 'secondary' as const,
      busy: busy === metadata.id,
      onClick: () => void testWebhook(c),
    };
    return {
      id: metadata.id,
      name,
      status: webhookFails ? 'Feiler' : 'Aktiv',
      sub: `${t(spec.kind === 'browser' ? 'integFrontends.kindBrowser' : 'integFrontends.kindServer')} · ${
        redirect || spec.url || serviceName(spec.service)
      }`,
      metaLabel: t('integFrontends.lastChanged'),
      meta: f.dateTime(c.updatedAt, 'medium'),
      ...(webhookFails && last
        ? {
            error: {
              what: t('integFrontends.lastNotDelivered'),
              why: t('integFrontends.lastNotDeliveredWhy', { url: spec.webhook?.url ?? '' }),
              code: last.error ?? String(last.status ?? t('common.unknown')),
              color: 'danger' as const,
              actions: canManage ? [{ ...testAction, variant: 'primary' as const }] : [],
            },
          }
        : {}),
      rows: [
        ...(spec.oidc
          ? [
              {
                k: t('integrations.clientId'),
                v: spec.oidc.clientId,
                copyLabel: t('integrations.copyClientId', { name }),
              },
              { k: t('integrations.redirectAfterLogin'), v: redirect },
            ]
          : []),
        {
          k: t('integFrontends.channels'),
          v: '',
          tags: spec.channels.map((ch) => t(channelKeys[ch])),
        },
        { k: t('integrations.canUse'), v: serviceName(spec.service) },
        {
          k: t('integrations.login'),
          v: spec.oidc ? 'Ansattporten' : t('integFrontends.loginApiKey'),
        },
        ...(spec.webhook
          ? [
              {
                k: t('integFrontends.notifications'),
                v: `${spec.webhook.url}${
                  last
                    ? ` · ${t('integFrontends.lastSent', {
                        at: f.dateTime(last.at, 'medium'),
                        result: t(last.ok ? 'integFrontends.delivered' : 'integFrontends.failed'),
                      })}`
                    : ` · ${t('integFrontends.notSentYet')}`
                }`,
              },
            ]
          : []),
      ],
      actions: canManage
        ? [
            {
              label: t('common.edit'),
              variant: 'secondary',
              onClick: () => {
                setSaveError('');
                setEditing({ client: c, service: spec.service });
              },
            },
            ...(spec.webhook && !webhookFails ? [testAction] : []),
            {
              label: t('common.remove'),
              variant: 'tertiary',
              onClick: () => {
                setRemoving(c);
                setRemoveReason('');
                setRemoveError('');
              },
            },
          ]
        : [],
    };
  });

  const firstService = services[0]?.id ?? '';

  return (
    <div className="stack-md">
      <div className="int-intro">
        <Paragraph className="meta int-intro-text">{t('integrations.introFrontends')}</Paragraph>
        {canManage ? (
          <Button
            variant="primary"
            onClick={() => {
              setSaveError('');
              setEditing({ service: firstService });
            }}
          >
            {t('integrations.addFrontend')}
          </Button>
        ) : (
          <span className="meta">{needsRight('manage-services', t)}</span>
        )}
      </div>
      <ItemList
        items={items}
        open={open}
        onToggle={(id) => setOpen(open === id ? undefined : id)}
        empty={{
          title: t('integrations.noFrontends'),
          text: t('integrations.noFrontendsText'),
        }}
      />
      {removing ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">
            {t('integFrontends.removeWarning', { name: nameOf(removing) })}
          </Paragraph>
          <Textfield
            className="int-field-md"
            data-size="sm"
            label={t('common.reason')}
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
              onClick={() => void remove()}
            >
              {t('integFrontends.removeFrontend')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setRemoving(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {editing ? (
        <Dialog
          open
          modal
          closeButton={t('common.close')}
          onClose={() => setEditing(undefined)}
          aria-labelledby="cf-h"
          className="int-dialog"
        >
          <div className="stack-dialog">
            <Paragraph data-size="sm" className="meta">
              {t('integFrontends.dialogIntro')}
            </Paragraph>
            {services.length ? (
              <Field>
                <Label htmlFor="fe-service">{t('integFrontends.whichService')}</Label>
                <Select
                  id="fe-service"
                  value={editing.service}
                  onChange={(e) => setEditing({ ...editing, service: e.target.value })}
                >
                  {services.map((s) => (
                    <Select.Option key={s.id} value={s.id}>
                      {s.name}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Alert data-color="info" data-size="sm">
                {t('integFrontends.noServices')}
              </Alert>
            )}
            <ClientForm
              key={editing.client?.definition.metadata.id ?? 'new'}
              initial={
                editing.client
                  ? draftOf(editing.client, editing.service)
                  : newDraft(editing.service)
              }
              isNew={!editing.client}
              saveError={saveError}
              onSave={(d) => void save(d)}
              onCancel={() => setEditing(undefined)}
            />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
};
