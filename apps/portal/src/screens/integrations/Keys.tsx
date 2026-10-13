import {
  Alert,
  Button,
  Checkbox,
  ErrorSummary,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { type ComponentRef, useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import {
  defaultKeyCallsPerMinute,
  keyDatasetChoices,
  keyExtras,
  keyServiceChoices,
  type Choice,
  type KeyExtras,
} from '../../data/integrations';
import { formatDate } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import type { ApiKeyView } from '../../types';
import { reasonProblem } from '../../components/ReasonField';

type Mode = 'alle' | 'utvalgte';

interface KeyForm {
  id?: string;
  name: string;
  mode: Mode;
  services: string[];
  datasets: string[];
  rate: string;
  reason: string;
  tried: boolean;
}

const merge = (base: Choice[], extra: Choice[]) => [
  ...base,
  ...extra.filter((e) => !base.some((b) => b.value === e.value || b.label === e.label)),
];

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('integConnections.wrong');

export const Keys = ({
  api,
  tenant,
  onFlash,
  live = false,
}: {
  api: ApiClient;
  tenant: string;
  live?: boolean;
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const f = useFormat();
  const canManage = useRights().has('manage-services');
  const hintId = useId();
  const locked = canManage ? {} : { 'aria-disabled': true as const, 'aria-describedby': hintId };
  const [state, retry] = useAsync(
    async (signal) => {
      const [access, datasets] = await Promise.all([
        api.access(tenant, signal),
        api.listDatasets(signal).catch(() => []),
      ]);
      return { access, datasets };
    },
    [api, tenant],
  );
  const [form, setForm] = useState<KeyForm | undefined>();
  const [secret, setSecret] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [edits, setEdits] = useState<
    Record<string, { mode: Mode; services: string[]; datasets: string[] }>
  >({});
  const [extras, setExtras] = useState<Record<string, KeyExtras>>(live ? {} : keyExtras);
  const [saveError, setSaveError] = useState('');
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);

  if (state.status === 'loading') return <Loading label={t('integKeys.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;

  const serviceChoices = merge(
    live ? [] : keyServiceChoices,
    state.data.access.services.map((s) => ({ value: s.publicName, label: s.name })),
  );
  const datasetChoices = merge(
    live ? [] : keyDatasetChoices,
    state.data.datasets.map((d) => ({ value: d.id, label: d.name })),
  );
  const labelOf = (choices: Choice[], value: string) =>
    choices.find((c) => c.value === value)?.label ?? value;

  const view = (k: ApiKeyView) => {
    const edit = edits[k.id];
    const services = edit ? edit.services : k.agents;
    const datasets = edit ? edit.datasets : k.datasets;
    const mode: Mode = edit
      ? edit.mode
      : services.length + datasets.length === 0
        ? 'alle'
        : 'utvalgte';
    const known = extras[k.id] ?? { rate: defaultKeyCallsPerMinute };
    const rate = k.callsPerMinute ?? known.rate;
    const extra = {
      rate,
      last: known.last ?? t('integKeys.notUsedYet'),
      created:
        known.created ??
        (known.origin === 'new'
          ? t('integKeys.createdToday')
          : known.origin === 'rotated'
            ? t('integKeys.rotatedToday')
            : k.createdAt
              ? formatDate(k.createdAt, f)
              : t('integKeys.unknownDate')),
    };
    return { key: k, mode, services, datasets, extra };
  };

  const errorsFor = (draft: KeyForm) => {
    const e: Record<string, string> = {};
    if (!draft.name.trim()) e['nk-navn'] = t('integKeys.nameProblem');
    if (draft.mode === 'utvalgte' && !draft.services.length && !draft.datasets.length)
      e['nk-utvalg'] = t('integKeys.selectionProblem');
    const r = Number(draft.rate.replace(/\s/g, ''));
    if (!(Number.isInteger(r) && r >= 1 && r <= 6000)) e['nk-grense'] = t('integKeys.rateProblem');
    const reasonError = reasonProblem(draft.reason, t);
    if (!draft.id && reasonError) e['nk-grunn'] = reasonError;
    return e;
  };

  const save = async () => {
    if (!form) return;
    const errs = errorsFor(form);
    if (Object.keys(errs).length) {
      setForm({ ...form, tried: true });
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    const rate = Number(form.rate.replace(/\s/g, ''));
    const services = form.mode === 'alle' ? [] : form.services;
    const datasets = form.mode === 'alle' ? [] : form.datasets;
    if (form.id) {
      const id = form.id;
      setEdits((all) => ({ ...all, [id]: { mode: form.mode, services, datasets } }));
      setExtras((all) => ({
        ...all,
        [id]: { ...(all[id] ?? {}), rate },
      }));
      onFlash(t('integKeys.accessChanged', { name: form.name }));
      setForm(undefined);
      return;
    }
    try {
      setSaveError('');
      const result = await api.createApiKey(
        tenant,
        { name: form.name.trim(), datasets, agents: services, callsPerMinute: rate },
        form.reason.trim(),
      );
      setExtras((all) => ({
        ...all,
        [result.apiKey.id]: { rate, origin: 'new' },
      }));
      setSecret(result.key);
      setForm(undefined);
      retry();
    } catch (e) {
      setSaveError(problemText(e, t));
    }
  };

  const revoke = async (k: ApiKeyView) => {
    const reasonError = reasonProblem(revokeReason, t);
    if (reasonError) {
      setRevokeError(reasonError);
      return;
    }
    try {
      await api.revokeApiKey(tenant, k.id, revokeReason.trim());
      setConfirming(undefined);
      setRevokeReason('');
      onFlash(t('integKeys.revoked', { name: k.name }));
      retry();
    } catch (e) {
      setRevokeError(problemText(e, t));
    }
  };

  const rotate = async (v: ReturnType<typeof view>) => {
    const k = v.key;
    try {
      const result = await api.createApiKey(
        tenant,
        { name: k.name, datasets: v.datasets, agents: v.services, callsPerMinute: v.extra.rate },
        t('integKeys.rotateReason', { name: k.name }),
      );
      await api.revokeApiKey(tenant, k.id, t('integKeys.replacedReason', { id: result.apiKey.id }));
      setExtras((all) => ({
        ...all,
        [result.apiKey.id]: { rate: v.extra.rate, origin: 'rotated' },
      }));
      setSecret(result.key);
      onFlash(t('integKeys.rotated', { name: k.name }), 'info');
      retry();
    } catch (e) {
      onFlash(problemText(e, t), 'danger');
    }
  };

  const errs = form ? errorsFor(form) : {};
  const shown = form?.tried ? errs : {};
  const views = state.data.access.keys.map(view);

  return (
    <div className="stack-md">
      <div className="int-intro">
        <Paragraph className="meta int-intro-text">{t('integKeys.intro')}</Paragraph>
        <Button
          variant="primary"
          {...locked}
          onClick={() => {
            if (!canManage) return;
            setSecret(undefined);
            setForm({
              name: '',
              mode: 'utvalgte',
              services: [],
              datasets: [],
              rate: String(defaultKeyCallsPerMinute),
              reason: '',
              tried: false,
            });
          }}
        >
          {t('integKeys.create')}
        </Button>
        {canManage ? null : (
          <span id={hintId} className="meta">
            {needsRight('manage-services', t)}
          </span>
        )}
      </div>
      {secret ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('integKeys.copyNow')}
          </Heading>
          <Paragraph>{t('integKeys.copyNowText')}</Paragraph>
          <div className="actions">
            <code className="int-secret" aria-label={t('integKeys.newKeyLabel')}>
              {secret}
            </code>
            <CopyButton text={secret} />
            <Button variant="tertiary" data-size="sm" onClick={() => setSecret(undefined)}>
              {t('integKeys.iSavedIt')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {form ? (
        <section aria-labelledby="nk-h" className="int-form">
          <Heading level={2} data-size="xs" id="nk-h">
            {form.id ? t('integKeys.editFor', { name: form.name }) : t('integKeys.newKey')}
          </Heading>
          {Object.keys(shown).length ? (
            <ErrorSummary ref={summary} tabIndex={-1}>
              <ErrorSummary.Heading>{t('integrations.fixThese')}</ErrorSummary.Heading>
              <ErrorSummary.List>
                {Object.entries(shown).map(([href, text]) => (
                  <ErrorSummary.Item key={href}>
                    <ErrorSummary.Link href={`#${href}`}>{text}</ErrorSummary.Link>
                  </ErrorSummary.Item>
                ))}
              </ErrorSummary.List>
            </ErrorSummary>
          ) : null}
          {saveError ? (
            <Alert data-color="danger" data-size="sm">
              {saveError}
            </Alert>
          ) : null}
          {form.id ? (
            <Textfield
              id="nk-navn"
              className="int-field-md"
              label={t('integrations.name')}
              value={form.name}
              readOnly
            />
          ) : (
            <Textfield
              id="nk-navn"
              className="int-field-md"
              label={t('integrations.name')}
              description={t('integKeys.nameHelp')}
              value={form.name}
              error={shown['nk-navn']}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
          <Fieldset>
            <Fieldset.Legend>{t('integKeys.access')}</Fieldset.Legend>
            <Radio
              name="nk-mode"
              label={t('integKeys.allBoth')}
              description={t('integKeys.allBothHelp')}
              checked={form.mode === 'alle'}
              onChange={() => setForm({ ...form, mode: 'alle' })}
            />
            <Radio
              name="nk-mode"
              label={t('integKeys.onlySelected')}
              description={t('integKeys.onlySelectedHelp')}
              checked={form.mode === 'utvalgte'}
              onChange={() => setForm({ ...form, mode: 'utvalgte' })}
            />
          </Fieldset>
          {form.mode === 'utvalgte' ? (
            <div id="nk-utvalg" tabIndex={-1} className="int-pickers">
              {(
                [
                  [t('integKeys.services'), 'services', serviceChoices],
                  [t('integKeys.datasets'), 'datasets', datasetChoices],
                ] as const
              ).map(([legend, key, choices]) => (
                <Fieldset key={key} data-size="sm">
                  <Fieldset.Legend>{legend}</Fieldset.Legend>
                  {choices.map((c) => (
                    <Checkbox
                      key={c.value}
                      label={c.label}
                      checked={form[key].includes(c.value)}
                      onChange={() =>
                        setForm({
                          ...form,
                          [key]: form[key].includes(c.value)
                            ? form[key].filter((x) => x !== c.value)
                            : [...form[key], c.value],
                        })
                      }
                    />
                  ))}
                </Fieldset>
              ))}
              {shown['nk-utvalg'] ? (
                <ValidationMessage>{shown['nk-utvalg']}</ValidationMessage>
              ) : null}
            </div>
          ) : null}
          <Textfield
            id="nk-grense"
            className="int-field-sm"
            label={t('integKeys.rate')}
            description={t('integKeys.rateHelp')}
            inputMode="numeric"
            value={form.rate}
            error={shown['nk-grense']}
            onChange={(e) => setForm({ ...form, rate: e.target.value })}
          />
          {form.id ? null : (
            <Textfield
              id="nk-grunn"
              className="int-field-md"
              label={t('common.reason')}
              description={t('integrations.reasonRequired')}
              value={form.reason}
              error={shown['nk-grunn']}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          )}
          <div className="actions">
            <Button variant="primary" onClick={() => void save()}>
              {form.id ? t('common.save') : t('integKeys.createKey')}
            </Button>
            <Button variant="secondary" onClick={() => setForm(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        </section>
      ) : null}
      {views.length === 0 ? (
        <div className="int-empty">
          <span className="int-empty-title">{t('integKeys.none')}</span>
          <span className="meta">{t('integKeys.noneText')}</span>
        </div>
      ) : (
        <ul className="int-keys" aria-label={t('integKeys.listLabel')}>
          {views.map((v) => {
            const k = v.key;
            const active = !k.revokedAt;
            const isConfirming = confirming === k.id;
            return (
              <li key={k.id} className={active ? undefined : 'revoked'}>
                <div className="int-key-head">
                  <span className="int-row-main">
                    <span className="row-wrap">
                      <span className="int-row-name">{k.name}</span>
                      <Tag data-size="sm" data-color={active ? 'success' : 'neutral'}>
                        {t(active ? 'integrations.statusActive' : 'integKeys.revokedStatus')}
                      </Tag>
                    </span>
                    <span className="meta">
                      {t('integKeys.prefixCreated', {
                        prefix: k.prefix ?? 'gk',
                        created: v.extra.created,
                      })}
                    </span>
                  </span>
                  <span className="int-row-meta">
                    <span>
                      {v.mode === 'alle'
                        ? t('integKeys.allBoth')
                        : [
                            ...v.services.map((s) => labelOf(serviceChoices, s)),
                            ...v.datasets.map((d) => labelOf(datasetChoices, d)),
                          ].join(', ')}
                    </span>
                    <span className="meta">
                      {t('integKeys.rateLastUsed', {
                        rate: f.number(v.extra.rate),
                        last: v.extra.last,
                      })}
                    </span>
                  </span>
                </div>
                {active && !isConfirming ? (
                  <div className="actions">
                    {live ? null : (
                      <Button
                        variant="secondary"
                        data-size="sm"
                        {...locked}
                        onClick={() =>
                          canManage &&
                          setForm({
                            id: k.id,
                            name: k.name,
                            mode: v.mode,
                            services: [...v.services],
                            datasets: [...v.datasets],
                            rate: String(v.extra.rate),
                            reason: '',
                            tried: false,
                          })
                        }
                      >
                        {t('integKeys.editAccess')}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      data-size="sm"
                      {...locked}
                      onClick={() => canManage && void rotate(v)}
                    >
                      {t('integKeys.rotate')}
                    </Button>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      data-color="danger"
                      {...locked}
                      onClick={() => {
                        if (!canManage) return;
                        setConfirming(k.id);
                        setRevokeReason('');
                        setRevokeError('');
                      }}
                    >
                      {t('integKeys.revoke')}
                    </Button>
                    {canManage ? null : (
                      <span className="meta">{needsRight('manage-services', t)}</span>
                    )}
                  </div>
                ) : null}
                {isConfirming ? (
                  <Alert data-color="danger" data-size="sm">
                    <Paragraph data-size="sm">
                      {t('integKeys.revokeWarning', { name: k.name })}
                    </Paragraph>
                    <Textfield
                      id={`revoke-${k.id}`}
                      className="int-field-md"
                      data-size="sm"
                      label={t('common.reason')}
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
                        {t('integKeys.revokeKey')}
                      </Button>
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setConfirming(undefined)}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </Alert>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
