import {
  Alert,
  Button,
  Checkbox,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Select,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { Fragment, useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import type { Format } from '@genai/i18n';
import { clock, sameDay, shortDay } from './dev-format';
import { dayMs } from './overview-model';
import { ErrorState, Loading } from '../../states';
import type { ClientView, ServiceKeyView } from '../../types';
import { OverridePicker, overrideGroups, overrideLabel } from './OverridePicker';
import { reasonProblem } from '../../components/ReasonField';

export const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? error.problem?.errors?.map((e) => e.message).join(' ') || error.message
    : t('serviceKeys.wrong');

const unusedAfterDays = 60;

const listText = (t: T, items: string[]) =>
  items.length > 1
    ? t('serviceDev.and', {
        first: items.slice(0, -1).join(', '),
        last: items.at(-1) ?? '',
      })
    : (items[0] ?? '');

export interface Revocation {
  at: string;
  who?: string | undefined;
  reason: string;
}

export const keyRevocations = (
  rows: {
    action: string;
    target: string;
    at: string;
    actorName?: string;
    reason: string;
    outcome: string;
  }[],
  tenant: string,
) =>
  new Map(
    rows
      .filter((r) => r.action === 'platform.apikeys.revoke' && r.outcome === 'applied')
      .map((r): [string, Revocation] => [
        r.target.replace(`api-key:${tenant}/`, ''),
        { at: r.at, who: r.actorName, reason: r.reason },
      ]),
  );

const rootOf = (k: ServiceKeyView, keys: ServiceKeyView[]) => {
  let at = k;
  for (let hops = 0; hops < keys.length && at.rotatedFrom; hops += 1) {
    const before = keys.find((x) => x.id === at.rotatedFrom);
    if (!before) break;
    at = before;
  }
  return at;
};

const unusedFor = (k: ServiceKeyView, now: Date) => {
  const since = k.lastUsedAt ?? k.createdAt;
  return since ? Math.floor((now.getTime() - Date.parse(since)) / dayMs) : 0;
};

const lastUsedText = (k: ServiceKeyView, t: T, f: Format, now: Date) =>
  !k.lastUsedAt
    ? t('serviceDev.neverUsed')
    : sameDay(k.lastUsedAt, now)
      ? t('serviceDev.usedToday', { time: clock(k.lastUsedAt, f) })
      : shortDay(k.lastUsedAt, f);

export const ServiceKeys = ({
  api,
  tenant,
  service,
  clients,
  environments = [],
  onFlash,
  createRequest = 0,
  onKeys,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  clients: ClientView[];
  environments?: string[];
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
  createRequest?: number;
  onKeys?: (keys: ServiceKeyView[]) => void;
  now?: () => Date;
}) => {
  const t = useT();
  const f = useFormat();
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.listServiceKeys(tenant, service, signal),
    [api, tenant, service],
  );
  const [audit] = useAsync(
    async (signal) =>
      keyRevocations(
        (await api.auditPage(tenant, { limit: 500, offset: 0 }, signal).catch(() => undefined))
          ?.data ?? [],
        tenant,
      ),
    [api, tenant, round],
  );
  const revocations = audit.status === 'ready' ? audit.data : new Map<string, Revocation>();
  const [catalog] = useAsync((signal) => api.settingsCatalog(signal).catch(() => []), [api]);
  const groups = catalog.status === 'ready' ? overrideGroups(catalog.data) : [];
  const [form, setForm] = useState<
    | {
        name: string;
        client: string;
        reason: string;
        overrides: string[];
        environments: string[];
      }
    | undefined
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

  const startCreate = () => {
    setSecret(undefined);
    setFormError('');
    setForm({ name: '', client: '', reason: '', overrides: [], environments: [] });
  };

  useEffect(() => {
    if (createRequest > 0) startCreate();
  }, [createRequest]);

  useEffect(() => {
    if (state.status === 'ready') onKeys?.(state.data);
  }, [state]);

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
          ...(form.environments.length ? { environments: form.environments } : {}),
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
      setRound((r) => r + 1);
    } catch (e) {
      setRevokeError(problemText(e, t));
    }
  };

  return (
    <section aria-labelledby="fe-keys-h" className="stack-sm">
      <Heading level={3} data-size="xs" id="fe-keys-h">
        {t('serviceDev.keysHeading')}
      </Heading>
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
          {environments.length > 1 ? (
            <Fieldset data-size="sm">
              <Fieldset.Legend>{t('serviceKeys.environments')}</Fieldset.Legend>
              <Fieldset.Description>
                {t('serviceKeys.environmentsDescription')}
              </Fieldset.Description>
              {environments.map((name) => (
                <Checkbox
                  key={name}
                  label={name}
                  checked={form.environments.includes(name)}
                  onChange={() =>
                    setForm({
                      ...form,
                      environments: form.environments.includes(name)
                        ? form.environments.filter((e) => e !== name)
                        : [...form.environments, name],
                    })
                  }
                />
              ))}
            </Fieldset>
          ) : null}
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
      {state.status === 'loading' ? (
        <Loading label={t('serviceKeys.loading')} shape="list" onRetry={retry} />
      ) : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('serviceDev.keysEmpty')}
        </Paragraph>
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <div tabIndex={0} role="region" aria-labelledby="fe-keys-h" className="scroll-x">
          <Table data-size="sm" className="dv-keys">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('serviceDev.colKey')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('serviceDev.colAllowed')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('serviceDev.colLastUsed')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">
                  <span className="visually-hidden">{t('serviceDev.colActions')}</span>
                </Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {state.data
                .filter((k) => !state.data.some((x) => x.rotatedFrom === k.id))
                .map((k) => {
                  const active = !k.revokedAt;
                  const client = clientName(k.client);
                  const today = now();
                  const days = unusedFor(k, today);
                  const unused = active && days >= unusedAfterDays;
                  const root = rootOf(k, state.data);
                  const revocation = revocations.get(k.id);
                  const madeBy = root.createdByName ?? k.createdByName;
                  const made = root.createdAt
                    ? madeBy
                      ? t('serviceDev.keyMade', { when: shortDay(root.createdAt, f), who: madeBy })
                      : t('serviceDev.keyMadeAt', { when: shortDay(root.createdAt, f) })
                    : '';
                  const revokedText = k.revokedAt
                    ? revocation?.who
                      ? t('serviceDev.keyRevokedBy', {
                          when: shortDay(revocation.at, f),
                          who: revocation.who,
                        })
                      : t('serviceDev.keyRevokedAt', { when: shortDay(k.revokedAt, f) })
                    : '';
                  const meta = active
                    ? [
                        made,
                        k.rotatedFrom && k.createdAt
                          ? t('serviceDev.keyRotated', { when: shortDay(k.createdAt, f) })
                          : '',
                        unused ? t('serviceDev.keyUnused', { days }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : revocation?.reason
                      ? t('serviceDev.withReason', { text: revokedText, reason: revocation.reason })
                      : revokedText;
                  const environmentChip = k.environments?.length
                    ? t('serviceDev.chipEnvironment', { list: listText(t, k.environments) })
                    : t('serviceDev.chipAllEnvironments');
                  const overridesChip = k.allowedOverrides.length
                    ? t('serviceDev.chipOverrides', {
                        list: k.allowedOverrides
                          .map((o) => overrideLabel(t, groups, o).replace(/\.$/, '').toLowerCase())
                          .join(', '),
                      })
                    : t('serviceDev.chipNoOverrides');
                  const lockdownChip =
                    k.modelsInLockdown === undefined
                      ? []
                      : [
                          k.modelsInLockdown
                            ? t('serviceDev.chipLockdownModels')
                            : t('serviceDev.chipNoLockdownModels'),
                        ];
                  const chips = !active
                    ? [environmentChip]
                    : client
                      ? [
                          t('serviceDev.chipFrontend', { name: client }),
                          environmentChip,
                          overridesChip,
                          ...lockdownChip,
                        ]
                      : [
                          environmentChip,
                          t('serviceDev.chipAllChannels'),
                          overridesChip,
                          ...lockdownChip,
                        ];
                  return (
                    <Fragment key={k.id}>
                      <Table.Row className={active ? undefined : 'revoked'}>
                        <Table.Cell>
                          <span className="row-wrap dv-key-name">
                            <strong>{k.name}</strong>
                            <Tag
                              data-size="sm"
                              data-color={!active ? 'neutral' : unused ? 'warning' : 'success'}
                            >
                              {active ? t('serviceDev.keyActive') : t('serviceDev.keyRevoked')}
                            </Tag>
                          </span>
                          <span className="meta">{meta}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <span
                            className="tag-row"
                            role="list"
                            aria-label={t('serviceDev.colAllowed')}
                          >
                            {chips.map((c) => (
                              <Tag key={c} role="listitem" data-size="sm" data-color="neutral">
                                {c}
                              </Tag>
                            ))}
                          </span>
                        </Table.Cell>
                        <Table.Cell className="nowrap">{lastUsedText(k, t, f, today)}</Table.Cell>
                        <Table.Cell>
                          {active && confirming !== k.id && rotating?.id !== k.id ? (
                            <span className="actions nowrap">
                              <Button
                                variant="tertiary"
                                data-size="sm"
                                aria-label={t('serviceKeys.rotateLabel', { name: k.name })}
                                onClick={() =>
                                  setRotating({ id: k.id, overrides: [...k.allowedOverrides] })
                                }
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
                            </span>
                          ) : null}
                        </Table.Cell>
                      </Table.Row>
                      {rotating?.id === k.id || confirming === k.id ? (
                        <Table.Row>
                          <Table.Cell colSpan={4}>
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
                                  <Button
                                    variant="primary"
                                    data-size="sm"
                                    onClick={() => void rotate(k)}
                                  >
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
                            ) : (
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
                            )}
                          </Table.Cell>
                        </Table.Row>
                      ) : null}
                    </Fragment>
                  );
                })}
            </Table.Body>
          </Table>
        </div>
      ) : null}
    </section>
  );
};
