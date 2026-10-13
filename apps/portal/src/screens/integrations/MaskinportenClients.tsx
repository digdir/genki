import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { MaskinportenClient } from '../../api/maskinporten';
import { scopes } from '../../data/integrations';
import { formatDate } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { ItemList, type ItemRowData } from './ItemList';
import { reasonProblem } from '../../components/ReasonField';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callScope = scopes[0]?.[0] ?? '';

interface Form {
  clientId: string;
  name: string;
  all: boolean;
  services: string[];
  reason: string;
  tried: boolean;
}

const emptyForm: Form = {
  clientId: '',
  name: '',
  all: true,
  services: [],
  reason: '',
  tried: false,
};

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? error.status === 409
      ? t('integMaskinporten.alreadyRegistered')
      : (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('integConnections.wrong');

export const MaskinportenClients = ({
  api,
  tenant,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const f = useFormat();
  const rights = useRights();
  const canManage = rights.has('manage-services');
  const [tick, setTick] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      if (!canManage) return { clients: [], services: [] };
      const [clients, overview] = await Promise.all([
        api.maskinporten.list(tenant, signal),
        api.overview(tenant, signal).catch(() => undefined),
      ]);
      return { clients, services: overview?.services ?? [] };
    },
    [api, tenant, tick, canManage],
  );
  const [open, setOpen] = useState<string>();
  const [form, setForm] = useState<Form>();
  const [saveError, setSaveError] = useState('');
  const [removing, setRemoving] = useState<MaskinportenClient>();
  const [removeReason, setRemoveReason] = useState('');
  const [removeError, setRemoveError] = useState('');

  if (state.status === 'loading') return <Loading label={t('integMaskinporten.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;

  const { clients, services } = state.data;
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  const reach = (c: MaskinportenClient) =>
    c.services.includes('*')
      ? t('integMaskinporten.allServices')
      : c.services.map(nameOf).join(', ');

  const errorsOf = (draft: Form) => ({
    clientId: uuid.test(draft.clientId.trim()) ? '' : t('integrations.clientIdProblem'),
    name: draft.name.trim() ? '' : t('integrations.systemNameProblem'),
    services: draft.all || draft.services.length ? '' : t('integHooks.servicesProblem'),
    reason: reasonProblem(draft.reason, t) ?? '',
  });

  const register = async () => {
    if (!form) return;
    const errors = errorsOf(form);
    if (Object.values(errors).some(Boolean)) {
      setForm({ ...form, tried: true });
      return;
    }
    setSaveError('');
    try {
      await api.maskinporten.register(
        tenant,
        {
          clientId: form.clientId.trim(),
          name: form.name.trim(),
          services: form.all ? ['*'] : form.services,
        },
        form.reason.trim(),
      );
      setOpen(form.clientId.trim());
      setForm(undefined);
      setTick((t) => t + 1);
      onFlash(t('integMaskinporten.registered', { name: form.name.trim() }));
    } catch (error) {
      setSaveError(problemText(error, t));
    }
  };

  const remove = async () => {
    if (!removing) return;
    const reasonError = reasonProblem(removeReason, t);
    if (reasonError) {
      setRemoveError(reasonError);
      return;
    }
    try {
      await api.maskinporten.remove(tenant, removing.clientId, removeReason.trim());
      onFlash(t('integMaskinporten.removed', { name: removing.name }));
      setRemoving(undefined);
      setTick((t) => t + 1);
    } catch (error) {
      setRemoveError(problemText(error, t));
    }
  };

  const items: ItemRowData[] = clients.map((c) => ({
    id: c.clientId,
    name: c.name,
    status: 'Aktiv',
    sub: t('integMaskinporten.canCallSub', { reach: reach(c) }),
    metaLabel: t('integMaskinporten.registeredLabel'),
    meta: formatDate(c.createdAt, f),
    rows: [
      {
        k: t('integrations.clientId'),
        v: c.clientId,
        copyLabel: t('integrations.copyClientId', { name: c.name }),
      },
      { k: t('integMaskinporten.canCall'), v: reach(c) },
      { k: t('integMaskinporten.scope'), v: '', tags: [callScope] },
    ],
    actions: canManage
      ? [
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
  }));

  const errors = form ? errorsOf(form) : undefined;
  const shown = (key: keyof NonNullable<typeof errors>) =>
    form?.tried && errors?.[key] ? errors[key] : undefined;

  return (
    <section aria-labelledby="mp-h" className="stack-md">
      <div className="int-intro">
        <div className="stack-xs int-intro-text">
          <Heading level={2} data-size="xs" id="mp-h">
            {t('integMaskinporten.heading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {t('integMaskinporten.intro', { scope: callScope })}
          </Paragraph>
        </div>
        {canManage ? (
          <Button
            variant="primary"
            onClick={() => {
              setSaveError('');
              setForm(emptyForm);
            }}
          >
            {t('integMaskinporten.register')}
          </Button>
        ) : (
          <span className="meta">{needsRight('manage-services', t)}</span>
        )}
      </div>
      {canManage ? (
        <ItemList
          items={items}
          open={open}
          onToggle={(id) => setOpen(open === id ? undefined : id)}
          empty={{
            title: t('integMaskinporten.none'),
            text: t('integMaskinporten.noneText'),
          }}
        />
      ) : null}
      {removing ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">
            {t('integMaskinporten.removeWarning', { name: removing.name })}
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
              {t('integMaskinporten.removeClient')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setRemoving(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {form ? (
        <Dialog
          open
          modal
          closeButton={t('common.close')}
          onClose={() => setForm(undefined)}
          aria-labelledby="mp-dlg-h"
          className="int-dialog"
        >
          <div className="stack-dialog">
            <Heading level={2} data-size="xs" id="mp-dlg-h">
              {t('integMaskinporten.register')}
            </Heading>
            <Paragraph data-size="sm" className="meta">
              {t('integMaskinporten.dialogIntro', { scope: callScope })}
            </Paragraph>
            <Textfield
              label={t('integrations.clientIdMaskinporten')}
              value={form.clientId}
              error={shown('clientId')}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
            <Textfield
              label={t('integrations.systemName')}
              value={form.name}
              error={shown('name')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Fieldset>
              <Fieldset.Legend>{t('integMaskinporten.whichServices')}</Fieldset.Legend>
              <Radio
                name="mp-reach"
                label={t('integMaskinporten.allServices')}
                description={t('integMaskinporten.allServicesHelp')}
                checked={form.all}
                onChange={() => setForm({ ...form, all: true })}
              />
              <Radio
                name="mp-reach"
                label={t('integMaskinporten.onlySelected')}
                checked={!form.all}
                onChange={() => setForm({ ...form, all: false })}
              />
            </Fieldset>
            {form.all ? null : (
              <Fieldset>
                <Fieldset.Legend>{t('integKeys.services')}</Fieldset.Legend>
                {services.length === 0 ? (
                  <Paragraph data-size="sm">{t('integMaskinporten.noServices')}</Paragraph>
                ) : null}
                {services.map((s) => (
                  <Checkbox
                    key={s.id}
                    label={s.name}
                    checked={form.services.includes(s.id)}
                    onChange={() =>
                      setForm({
                        ...form,
                        services: form.services.includes(s.id)
                          ? form.services.filter((x) => x !== s.id)
                          : [...form.services, s.id],
                      })
                    }
                  />
                ))}
                {shown('services') ? (
                  <ValidationMessage>{shown('services')}</ValidationMessage>
                ) : null}
              </Fieldset>
            )}
            <Textfield
              label={t('common.reason')}
              description={t('integrations.reasonRequired')}
              value={form.reason}
              error={shown('reason')}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
            {saveError ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {saveError}
              </Alert>
            ) : null}
            <div className="actions">
              <Button variant="primary" onClick={() => void register()}>
                {t('integrations.register')}
              </Button>
              <Button variant="secondary" onClick={() => setForm(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
};
