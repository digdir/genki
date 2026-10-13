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
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { KeyPolicy, NewKeyPolicy } from '../../api/key-policies';
import { reasonProblem } from '../../components/ReasonField';
import { formatDate } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { ItemList, type ItemRowData } from './ItemList';

const allScopes = ['query', 'ingest', 'admin'];

interface Form {
  id?: string;
  name: string;
  scopes: string[];
  datasets: string;
  agents: string;
  modes: string;
  allowedConfigKeys: string;
  reason: string;
  tried: boolean;
}

const emptyForm: Form = {
  name: '',
  scopes: ['query'],
  datasets: '',
  agents: '',
  modes: '',
  allowedConfigKeys: '',
  reason: '',
  tried: false,
};

const lines = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('integConnections.wrong');

export const KeyPolicies = ({
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
  const canManage = useRights().has('manage-services');
  const [tick, setTick] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      const [policies, access] = await Promise.all([
        api.keyPolicies.list(tenant, signal),
        api.access(tenant, signal).catch(() => undefined),
      ]);
      return { policies, keys: (access?.keys ?? []).filter((k) => !k.service && !k.revokedAt) };
    },
    [api, tenant, tick],
  );
  const [open, setOpen] = useState<string>();
  const [form, setForm] = useState<Form>();
  const [saveError, setSaveError] = useState('');
  const [removing, setRemoving] = useState<KeyPolicy>();
  const [removeReason, setRemoveReason] = useState('');
  const [removeError, setRemoveError] = useState('');
  const [choosing, setChoosing] = useState<{ key: string; name: string; policy: string }>();
  const [chooseReason, setChooseReason] = useState('');
  const [chooseError, setChooseError] = useState('');

  if (state.status === 'loading') return <Loading label={t('integPolicies.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;

  const { policies, keys } = state.data;
  const nameOfPolicy = (id: string | undefined) => policies.find((p) => p.id === id)?.name;
  const policyOfKey = (id: string) => policies.find((p) => p.keyIds.includes(id))?.id;
  const refresh = () => setTick((n) => n + 1);

  const errorsOf = (draft: Form) => ({
    name: draft.name.trim() ? '' : t('integPolicies.nameProblem'),
    reason: reasonProblem(draft.reason, t) ?? '',
  });

  const save = async () => {
    if (!form) return;
    if (Object.values(errorsOf(form)).some(Boolean)) {
      setForm({ ...form, tried: true });
      return;
    }
    const body: NewKeyPolicy = {
      name: form.name.trim(),
      scopes: form.scopes,
      datasets: lines(form.datasets),
      agents: lines(form.agents),
      modes: lines(form.modes),
      allowedConfigKeys: lines(form.allowedConfigKeys),
    };
    setSaveError('');
    try {
      const saved = form.id
        ? await api.keyPolicies.update(tenant, form.id, body, form.reason.trim())
        : await api.keyPolicies.create(tenant, body, form.reason.trim());
      setOpen(saved.id);
      setForm(undefined);
      refresh();
      onFlash(t(form.id ? 'integPolicies.saved' : 'integPolicies.created', { name: body.name }));
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
      await api.keyPolicies.remove(tenant, removing.id, removeReason.trim());
      onFlash(t('integPolicies.removed', { name: removing.name }));
      setRemoving(undefined);
      refresh();
    } catch (error) {
      setRemoveError(problemText(error, t));
    }
  };

  const choose = async () => {
    if (!choosing) return;
    const reasonError = reasonProblem(chooseReason, t);
    if (reasonError) {
      setChooseError(reasonError);
      return;
    }
    try {
      await api.keyPolicies.attach(
        tenant,
        choosing.key,
        choosing.policy || undefined,
        chooseReason.trim(),
      );
      onFlash(t('integPolicies.keyChanged', { name: choosing.name }));
      setChoosing(undefined);
      refresh();
    } catch (error) {
      setChooseError(problemText(error, t));
    }
  };

  const none = t('integPolicies.none');
  const items: ItemRowData[] = policies.map((p) => ({
    id: p.id,
    name: p.name,
    status: 'Aktiv',
    sub: t('integPolicies.usedBySub', { count: p.keyIds.length }),
    metaLabel: t('integPolicies.createdLabel'),
    meta: formatDate(p.createdAt, f),
    rows: [
      { k: t('integPolicies.scopes'), v: '', tags: p.scopes },
      { k: t('integPolicies.datasets'), v: p.datasets.join(', ') || none },
      { k: t('integPolicies.agents'), v: p.agents.join(', ') || none },
      { k: t('integPolicies.modes'), v: p.modes.join(', ') || none },
      { k: t('integPolicies.configKeys'), v: p.allowedConfigKeys.join(', ') || none },
    ],
    actions: canManage
      ? [
          {
            label: t('common.edit'),
            variant: 'secondary',
            onClick: () => {
              setSaveError('');
              setForm({
                id: p.id,
                name: p.name,
                scopes: p.scopes,
                datasets: p.datasets.join(', '),
                agents: p.agents.join(', '),
                modes: p.modes.join(', '),
                allowedConfigKeys: p.allowedConfigKeys.join(', '),
                reason: '',
                tried: false,
              });
            },
          },
          {
            label: t('common.remove'),
            variant: 'tertiary',
            onClick: () => {
              setRemoving(p);
              setRemoveReason('');
              setRemoveError('');
            },
          },
        ]
      : [],
  }));

  const errors = form ? errorsOf(form) : undefined;
  const shown = (key: 'name' | 'reason') =>
    form?.tried && errors?.[key] ? errors[key] : undefined;
  const listField = (key: 'datasets' | 'agents' | 'modes' | 'allowedConfigKeys', label: string) =>
    form ? (
      <Textfield
        label={label}
        description={t('integPolicies.listHelp')}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    ) : null;

  return (
    <section aria-labelledby="kp-h" className="stack-md">
      <div className="int-intro">
        <div className="stack-xs int-intro-text">
          <Heading level={2} data-size="xs" id="kp-h">
            {t('integPolicies.heading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {t('integPolicies.intro')}
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
            {t('integPolicies.create')}
          </Button>
        ) : (
          <span className="meta">{needsRight('manage-services', t)}</span>
        )}
      </div>
      <ItemList
        items={items}
        open={open}
        onToggle={(id) => setOpen(open === id ? undefined : id)}
        empty={{ title: t('integPolicies.empty'), text: t('integPolicies.emptyText') }}
      />
      {keys.length ? (
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('integPolicies.keysHeading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {t('integPolicies.keysIntro')}
          </Paragraph>
          <ul className="plain-list">
            {keys.map((k) => (
              <li key={k.id} className="int-intro">
                <span>
                  {k.name}
                  <span className="meta"> · {nameOfPolicy(policyOfKey(k.id)) ?? none}</span>
                </span>
                {canManage ? (
                  <Button
                    variant="secondary"
                    data-size="sm"
                    aria-label={t('integPolicies.chooseFor', { name: k.name })}
                    onClick={() => {
                      setChoosing({ key: k.id, name: k.name, policy: policyOfKey(k.id) ?? '' });
                      setChooseReason('');
                      setChooseError('');
                    }}
                  >
                    {t('integPolicies.choose')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {removing ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">
            {removing.keyIds.length
              ? t('integPolicies.removeInUse', {
                  name: removing.name,
                  count: removing.keyIds.length,
                })
              : t('integPolicies.removeWarning', { name: removing.name })}
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
              {t('integPolicies.removePolicy')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setRemoving(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {choosing ? (
        <Dialog
          open
          modal
          closeButton={t('common.close')}
          onClose={() => setChoosing(undefined)}
          aria-labelledby="kp-choose-h"
          className="int-dialog"
        >
          <div className="stack-dialog">
            <Heading level={2} data-size="xs" id="kp-choose-h">
              {t('integPolicies.chooseFor', { name: choosing.name })}
            </Heading>
            <Fieldset>
              <Fieldset.Legend>{t('integPolicies.policy')}</Fieldset.Legend>
              <Radio
                name="kp-choice"
                label={none}
                checked={choosing.policy === ''}
                onChange={() => setChoosing({ ...choosing, policy: '' })}
              />
              {policies.map((p) => (
                <Radio
                  key={p.id}
                  name="kp-choice"
                  label={p.name}
                  checked={choosing.policy === p.id}
                  onChange={() => setChoosing({ ...choosing, policy: p.id })}
                />
              ))}
            </Fieldset>
            <Textfield
              label={t('common.reason')}
              description={t('integrations.reasonRequired')}
              value={chooseReason}
              error={chooseError || undefined}
              onChange={(e) => {
                setChooseReason(e.target.value);
                setChooseError('');
              }}
            />
            <div className="actions">
              <Button variant="primary" onClick={() => void choose()}>
                {t('integPolicies.apply')}
              </Button>
              <Button variant="secondary" onClick={() => setChoosing(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {form ? (
        <Dialog
          open
          modal
          closeButton={t('common.close')}
          onClose={() => setForm(undefined)}
          aria-labelledby="kp-dlg-h"
          className="int-dialog"
        >
          <div className="stack-dialog">
            <Heading level={2} data-size="xs" id="kp-dlg-h">
              {form.id ? t('integPolicies.edit') : t('integPolicies.create')}
            </Heading>
            <Textfield
              label={t('integPolicies.name')}
              value={form.name}
              error={shown('name')}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Fieldset>
              <Fieldset.Legend>{t('integPolicies.scopes')}</Fieldset.Legend>
              {allScopes.map((s) => (
                <Checkbox
                  key={s}
                  label={s}
                  checked={form.scopes.includes(s)}
                  onChange={() =>
                    setForm({
                      ...form,
                      scopes: form.scopes.includes(s)
                        ? form.scopes.filter((x) => x !== s)
                        : [...form.scopes, s],
                    })
                  }
                />
              ))}
            </Fieldset>
            {listField('datasets', t('integPolicies.datasets'))}
            {listField('agents', t('integPolicies.agents'))}
            {listField('modes', t('integPolicies.modes'))}
            {listField('allowedConfigKeys', t('integPolicies.configKeys'))}
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
              <Button variant="primary" onClick={() => void save()}>
                {t('common.save')}
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
