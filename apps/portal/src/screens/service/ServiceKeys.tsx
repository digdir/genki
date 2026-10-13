import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import { ErrorState, Loading } from '../../states';
import type { ClientView, ServiceKeyView } from '../../types';
import { OverridePicker, overrideGroups, overrideLabel } from './OverridePicker';
import { reasonProblem } from '../../components/ReasonField';

export const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('serviceKeys.wrong');

export const ServiceKeys = ({
  api,
  tenant,
  service,
  clients,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  clients: ClientView[];
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    (signal) => api.listServiceKeys(tenant, service, signal),
    [api, tenant, service],
  );
  const [catalog] = useAsync((signal) => api.settingsCatalog(signal).catch(() => []), [api]);
  const groups = catalog.status === 'ready' ? overrideGroups(catalog.data) : [];
  const [form, setForm] = useState<
    { name: string; client: string; reason: string; overrides: string[] } | undefined
  >();
  const [rotating, setRotating] = useState<{ id: string; overrides: string[] }>();
  const [formError, setFormError] = useState('');
  const [secret, setSecret] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState('');

  const clientName = (id: string | null) =>
    id
      ? (clients.find((c) => c.definition.metadata.id === id)?.definition.metadata.name ?? id)
      : undefined;

  const create = async () => {
    if (!form) return;
    if (!form.name.trim()) return setFormError(t('serviceKeys.nameRequired'));
    const reasonError = reasonProblem(form.reason);
    if (reasonError) return setFormError(reasonError);
    try {
      const result = await api.createServiceKey(
        tenant,
        service,
        {
          name: form.name.trim(),
          ...(form.client ? { client: form.client } : {}),
          allowedOverrides: form.overrides,
        },
        form.reason.trim(),
      );
      setSecret(result.key);
      setForm(undefined);
      retry();
    } catch (e) {
      setFormError(problemText(e, t));
    }
  };

  const rotate = async (k: ServiceKeyView) => {
    try {
      const result = await api.rotateApiKey(
        tenant,
        k.id,
        t('serviceKeys.rotateReason', { name: k.name }),
        rotating?.overrides ?? k.allowedOverrides,
      );
      setRotating(undefined);
      setSecret(result.key);
      onFlash(t('serviceKeys.oldStops', { name: k.name }), 'info');
      retry();
    } catch (e) {
      onFlash(problemText(e, t), 'danger');
    }
  };

  const revoke = async (k: ServiceKeyView) => {
    const revokeError = reasonProblem(revokeReason);
    if (revokeError) return setRevokeError(revokeError);
    try {
      await api.revokeApiKey(tenant, k.id, revokeReason.trim());
      setConfirming(undefined);
      onFlash(t('serviceKeys.revoked', { name: k.name }));
      retry();
    } catch (e) {
      setRevokeError(problemText(e, t));
    }
  };

  return (
    <section aria-labelledby="fe-keys-h" className="stack-sm">
      <div className="fe-head">
        <div className="stack-xs">
          <Heading level={3} data-size="2xs" id="fe-keys-h">
            {t('serviceKeys.heading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {t('serviceKeys.intro')}
          </Paragraph>
        </div>
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => {
            setSecret(undefined);
            setFormError('');
            setForm({ name: '', client: '', reason: '', overrides: [] });
          }}
        >
          {t('serviceKeys.create')}
        </Button>
      </div>
      {secret ? (
        <Alert data-color="warning">
          <Heading level={4} data-size="2xs">
            {t('serviceKeys.copyNow')}
          </Heading>
          <Paragraph>{t('serviceKeys.once')}</Paragraph>
          <div className="actions">
            <code className="fe-secret" aria-label={t('serviceKeys.newKey')}>
              {secret}
            </code>
            <CopyButton text={secret} ariaLabel={t('serviceKeys.copyNewKey')} />
            <Button variant="tertiary" data-size="sm" onClick={() => setSecret(undefined)}>
              {t('serviceKeys.saved')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {form ? (
        <div className="fe-form stack-sm" role="group" aria-labelledby="fe-key-form-h">
          <Heading level={4} data-size="2xs" id="fe-key-form-h">
            {t('serviceKeys.formHeading')}
          </Heading>
          {formError ? (
            <Alert data-color="danger" data-size="sm">
              {formError}
            </Alert>
          ) : null}
          <Textfield
            id="fe-key-name"
            className="fe-field-md"
            label={t('serviceKeys.name')}
            description={t('serviceKeys.nameDescription')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Field className="fe-field-md">
            <Label htmlFor="fe-key-client">{t('serviceKeys.client')}</Label>
            <Select
              id="fe-key-client"
              value={form.client}
              onChange={(e) => setForm({ ...form, client: e.target.value })}
            >
              <Select.Option value="">{t('serviceKeys.noClient')}</Select.Option>
              {clients.map((c) => (
                <Select.Option key={c.definition.metadata.id} value={c.definition.metadata.id}>
                  {c.definition.metadata.name ?? c.definition.metadata.id}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <OverridePicker
            id="fe-key-overrides"
            groups={groups}
            value={form.overrides}
            onChange={(overrides) => setForm({ ...form, overrides })}
          />
          <Textfield
            id="fe-key-reason"
            className="fe-field-md"
            label={t('serviceKeys.reason')}
            description={t('serviceKeys.reasonDescription')}
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
          <div className="actions">
            <Button variant="primary" data-size="sm" onClick={() => void create()}>
              {t('serviceKeys.createKey')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setForm(undefined)}>
              {t('serviceKeys.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {state.status === 'loading' ? <Loading label={t('serviceKeys.loading')} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <div className="fe-empty">
          <span className="fe-empty-title">{t('serviceKeys.emptyTitle')}</span>
          <span className="meta">{t('serviceKeys.emptyBody')}</span>
        </div>
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <ul className="fe-list" aria-label={t('serviceKeys.listLabel')}>
          {state.data.map((k) => {
            const active = !k.revokedAt;
            const client = clientName(k.client);
            return (
              <li key={k.id} className={active ? undefined : 'revoked'}>
                <div className="fe-row">
                  <span className="stack-xs">
                    <span className="row-wrap">
                      <strong>{k.name}</strong>
                      <Tag data-size="sm" data-color={active ? 'success' : 'neutral'}>
                        {active ? t('serviceKeys.active') : t('serviceKeys.revokedTag')}
                      </Tag>
                    </span>
                    <span className="meta">
                      {k.prefix ?? 'gp'}…{k.lastFour ?? ''}
                      {t('serviceKeys.created', {
                        when: k.createdAt
                          ? f.date(k.createdAt, 'medium')
                          : t('serviceKeys.unknownDate'),
                      })}
                      {k.rotatedFrom ? t('serviceKeys.rotated') : ''}
                    </span>
                  </span>
                  <span className="stack-xs fe-row-meta">
                    <span>
                      {client
                        ? t('serviceKeys.clientLine', { client })
                        : t('serviceKeys.allChannels')}
                    </span>
                    <span className="meta">
                      {t('serviceKeys.lastUsed', {
                        when: k.lastUsedAt
                          ? f.dateTime(k.lastUsedAt, 'medium')
                          : t('serviceKeys.never'),
                      })}
                    </span>
                    <span className="meta">
                      {k.allowedOverrides.length
                        ? t('serviceKeys.canOverride', {
                            list: k.allowedOverrides
                              .map((o) => overrideLabel(t, groups, o))
                              .join(', '),
                          })
                        : t('serviceKeys.cannotOverride')}
                    </span>
                  </span>
                </div>
                {rotating?.id === k.id ? (
                  <div
                    className="fe-form stack-sm"
                    role="group"
                    aria-label={t('serviceKeys.rotateLabel', { name: k.name })}
                  >
                    <Paragraph data-size="sm">
                      {t('serviceKeys.rotateWarning', { name: k.name })}
                    </Paragraph>
                    <OverridePicker
                      id={`fe-rotate-overrides-${k.id}`}
                      groups={groups}
                      value={rotating.overrides}
                      onChange={(overrides) => setRotating({ id: k.id, overrides })}
                    />
                    <div className="actions">
                      <Button variant="primary" data-size="sm" onClick={() => void rotate(k)}>
                        {t('serviceKeys.newKeyButton')}
                      </Button>
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setRotating(undefined)}
                      >
                        {t('serviceKeys.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {active && confirming !== k.id && rotating?.id !== k.id ? (
                  <div className="actions">
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-label={t('serviceKeys.rotateLabel', { name: k.name })}
                      onClick={() => setRotating({ id: k.id, overrides: [...k.allowedOverrides] })}
                    >
                      {t('serviceKeys.rotate')}
                    </Button>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      data-color="danger"
                      aria-label={t('serviceKeys.revokeLabel', { name: k.name })}
                      onClick={() => {
                        setConfirming(k.id);
                        setRevokeReason('');
                        setRevokeError('');
                      }}
                    >
                      {t('serviceKeys.revoke')}
                    </Button>
                  </div>
                ) : null}
                {confirming === k.id ? (
                  <Alert data-color="danger" data-size="sm">
                    <Paragraph data-size="sm">
                      {t('serviceKeys.revokeWarning', { name: k.name })}
                    </Paragraph>
                    <Textfield
                      id={`fe-revoke-${k.id}`}
                      className="fe-field-md"
                      data-size="sm"
                      label={t('serviceKeys.reason')}
                      value={revokeReason}
                      error={revokeError || undefined}
                      onChange={(e) => {
                        setRevokeReason(e.target.value);
                        setRevokeError('');
                      }}
                    />
                    <div className="actions">
                      <Button
                        variant="primary"
                        data-color="danger"
                        data-size="sm"
                        onClick={() => void revoke(k)}
                      >
                        {t('serviceKeys.revokeKey')}
                      </Button>
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setConfirming(undefined)}
                      >
                        {t('serviceKeys.cancel')}
                      </Button>
                    </div>
                  </Alert>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};
