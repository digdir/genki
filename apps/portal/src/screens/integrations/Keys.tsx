import {
  Alert,
  Button,
  Checkbox,
  Details,
  Dialog,
  ErrorSummary,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
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

export type Expiry = '90' | '365' | 'never';

export const expiryInput = (expiry: Expiry): { expiresInDays?: number } =>
  expiry === 'never' ? {} : { expiresInDays: Number(expiry) };

interface NewSecret {
  value: string;
  name: string;
  expiresAt?: string | null;
  copied: boolean;
  askUncopied: boolean;
}

interface KeyForm {
  id?: string;
  name: string;
  mode: Mode;
  services: string[];
  datasets: string[];
  rate: string;
  reason: string;
  testRunner: boolean;
  expires: Expiry;
  tried: boolean;
}

const merge = (base: Choice[], extra: Choice[]) => [
  ...base,
  ...extra.filter((e) => !base.some((b) => b.value === e.value || b.label === e.label)),
];

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? error.problem?.errors?.map((e) => e.message).join(' ') || error.message
    : t('integConnections.wrong');

export const Keys = ({
  api,
  tenant,
  onFlash,
  live = false,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  live?: boolean;
  now?: () => Date;
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
  const [askDiscard, setAskDiscard] = useState(false);
  const [secret, setSecret] = useState<NewSecret | undefined>();
  const [confirming, setConfirming] = useState<{ kind: 'revoke' | 'rotate'; id: string }>();
  const [busy, setBusy] = useState(false);
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
      last: known.last ?? (k.lastUsedAt ? f.dateTime(k.lastUsedAt, 'medium') : undefined),
      neverUsed: k.lastUsedAt === null,
      created:
        known.created ??
        (known.origin === 'new'
          ? t('integKeys.createdToday')
          : known.origin === 'rotated'
            ? t('integKeys.rotatedToday')
            : k.createdAt
              ? k.createdByName
                ? t('integKeys.createdBy', {
                    date: formatDate(k.createdAt, f),
                    who: k.createdByName,
                  })
                : formatDate(k.createdAt, f)
              : t('integKeys.unknownDate')),
    };
    return { key: k, mode, services, datasets, extra };
  };

  const errorsFor = (draft: KeyForm) => {
    const e: Record<string, string> = {};
    const name = draft.name.trim();
    if (!name) e['nk-navn'] = t('integKeys.nameProblem');
    else if (
      !draft.id &&
      state.data.access.keys.some(
        (k) => !k.revokedAt && k.name.trim().toLowerCase() === name.toLowerCase(),
      )
    )
      e['nk-navn'] = t('integKeys.nameTaken', { name });
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
        {
          name: form.name.trim(),
          datasets,
          agents: services,
          callsPerMinute: rate,
          ...(form.testRunner
            ? { testRunner: true, expiresInDays: 90 }
            : expiryInput(form.expires)),
        },
        form.reason.trim(),
      );
      setExtras((all) => ({
        ...all,
        [result.apiKey.id]: { rate, origin: 'new' },
      }));
      setSecret({
        value: result.key,
        name: form.name.trim(),
        expiresAt: result.apiKey.expiresAt,
        copied: false,
        askUncopied: false,
      });
      setForm(undefined);
      retry();
    } catch (e) {
      setSaveError(problemText(e, t));
    }
  };

  const formDirty = (draft: KeyForm) =>
    !draft.id &&
    (draft.name.trim() !== '' ||
      draft.reason.trim() !== '' ||
      draft.services.length > 0 ||
      draft.datasets.length > 0);

  const tryCloseForm = () => {
    if (form && formDirty(form) && !askDiscard) setAskDiscard(true);
    else {
      setAskDiscard(false);
      setForm(undefined);
      setSaveError('');
    }
  };

  const tryCloseSecret = () => {
    if (secret && !secret.copied && !secret.askUncopied)
      setSecret({ ...secret, askUncopied: true });
    else setSecret(undefined);
  };

  const revoke = async (k: ApiKeyView) => {
    const reasonError = reasonProblem(revokeReason, t);
    if (reasonError) {
      setRevokeError(reasonError);
      return;
    }
    setBusy(true);
    try {
      await api.revokeApiKey(tenant, k.id, revokeReason.trim());
      setConfirming(undefined);
      setRevokeReason('');
      onFlash(t('integKeys.revoked', { name: k.name }));
      retry();
    } catch (e) {
      setRevokeError(problemText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (v: ReturnType<typeof view>) => {
    const k = v.key;
    setBusy(true);
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
      setConfirming(undefined);
      setSecret({ value: result.key, name: k.name, copied: false, askUncopied: false });
      onFlash(t('integKeys.rotated', { name: k.name }), 'info');
      retry();
    } catch (e) {
      setRevokeError(problemText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const errs = form ? errorsFor(form) : {};
  const shown = form?.tried ? errs : {};
  const views = state.data.access.keys.map(view);
  const active = views.filter((v) => !v.key.revokedAt);
  const revokedKeys = views.filter((v) => v.key.revokedAt);
  const target = confirming ? views.find((v) => v.key.id === confirming.id) : undefined;

  const openCreate = () => {
    if (!canManage) return;
    setSecret(undefined);
    setSaveError('');
    setAskDiscard(false);
    setForm({
      name: '',
      mode: 'utvalgte',
      services: [],
      datasets: [],
      rate: String(defaultKeyCallsPerMinute),
      reason: '',
      testRunner: false,
      expires: '365',
      tried: false,
    });
  };

  const keyRow = (v: ReturnType<typeof view>) => {
    const k = v.key;
    const isActive = !k.revokedAt;
    return (
      <li key={k.id} className={isActive ? undefined : 'revoked'}>
        <div className="int-key-head">
          <span className="int-row-main">
            <span className="row-wrap">
              <span className="int-row-name">{k.name}</span>
              <Tag data-size="sm" data-color={isActive ? 'success' : 'neutral'}>
                {t(isActive ? 'integrations.statusActive' : 'integKeys.revokedStatus')}
              </Tag>
              {k.testRunner ? (
                <Tag data-size="sm" data-color="warning">
                  {t('integKeys.testRunnerTag')}
                </Tag>
              ) : null}
            </span>
            <span className="meta">
              {t('integKeys.prefixCreated', {
                prefix: k.prefix ?? 'gk',
                created: v.extra.created,
              })}
            </span>
            {isActive && k.expiresAt ? (
              <span className="meta">{t('devKeys.expiresOn', { date: f.date(k.expiresAt) })}</span>
            ) : null}
            {!isActive || k.modelsInLockdown === undefined ? null : (
              <span className="meta">
                {t(k.modelsInLockdown ? 'integKeys.modelsAllowed' : 'integKeys.modelsRefused')}
              </span>
            )}
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
              {v.extra.last
                ? t('integKeys.rateLastUsed', { rate: f.number(v.extra.rate), last: v.extra.last })
                : v.extra.neverUsed
                  ? t('integKeys.rateNotUsed', { rate: f.number(v.extra.rate) })
                  : t('integKeys.rateOnly', { rate: f.number(v.extra.rate) })}
            </span>
          </span>
        </div>
        {isActive ? (
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
                    testRunner: k.testRunner === true,
                    expires: '365',
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
              onClick={() => {
                if (!canManage) return;
                setRevokeError('');
                setConfirming({ kind: 'rotate', id: k.id });
              }}
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
                setConfirming({ kind: 'revoke', id: k.id });
                setRevokeReason('');
                setRevokeError('');
              }}
            >
              {t('integKeys.revoke')}
            </Button>
            {canManage ? null : <span className="meta">{needsRight('manage-services', t)}</span>}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="stack-md">
      <div className="int-intro">
        <Paragraph className="meta int-intro-text">{t('integKeys.intro')}</Paragraph>
        <Button variant="primary" {...locked} onClick={openCreate}>
          {t('integKeys.create')}
        </Button>
        {canManage ? null : (
          <span id={hintId} className="meta">
            {needsRight('manage-services', t)}
          </span>
        )}
      </div>
      {views.length === 0 ? (
        <div className="int-empty">
          <span className="int-empty-title">{t('integKeys.none')}</span>
          <span className="meta">{t('integKeys.noneText')}</span>
          {canManage ? (
            <div>
              <Button variant="secondary" data-size="sm" onClick={openCreate}>
                {t('integKeys.create')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <section aria-labelledby="keys-active-h" className="stack-sm">
            <Heading level={3} data-size="2xs" id="keys-active-h">
              {t('integKeys.inUse', { count: active.length })}
            </Heading>
            <ul className="int-keys" aria-label={t('integKeys.listLabel')}>
              {active.map(keyRow)}
            </ul>
          </section>
          {revokedKeys.length ? (
            <Details>
              <Details.Summary>
                {t('integKeys.revokedGroup', { count: revokedKeys.length })}
              </Details.Summary>
              <Details.Content>
                <ul className="int-keys" aria-label={t('integKeys.revokedListLabel')}>
                  {revokedKeys.map(keyRow)}
                </ul>
              </Details.Content>
            </Details>
          ) : null}
        </>
      )}
      {form ? (
        <Dialog
          open
          modal
          closeButton={false}
          onCancel={(e) => {
            e.preventDefault();
            tryCloseForm();
          }}
          aria-labelledby="nk-h"
          className="int-dialog"
        >
          <div className="stack-dialog stack-sm">
            <div className="int-dialog-head">
              <Heading level={2} data-size="xs" id="nk-h">
                {form.id ? t('integKeys.editFor', { name: form.name }) : t('integKeys.newKey')}
              </Heading>
              <Button variant="tertiary" data-size="sm" onClick={tryCloseForm}>
                {t('common.close')}
              </Button>
            </div>
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
            {form.id || form.testRunner ? null : (
              <Field className="int-field-md">
                <Label htmlFor="nk-expires">{t('devKeys.expires')}</Label>
                <Select
                  id="nk-expires"
                  value={form.expires}
                  onChange={(e) => setForm({ ...form, expires: e.target.value as Expiry })}
                >
                  {(['90', '365', 'never'] as const).map((value) => (
                    <Select.Option key={value} value={value}>
                      {value === 'never'
                        ? t('devKeys.never')
                        : t(value === '90' ? 'devKeys.in90' : 'devKeys.inYear', {
                            date: f.date(new Date(now().getTime() + Number(value) * 86_400_000)),
                          })}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            )}
            {!form.id && state.data.access.testRunnerKeys ? (
              <Checkbox
                label={t('integKeys.testRunner')}
                description={t('integKeys.testRunnerHelp')}
                checked={form.testRunner}
                onChange={() => setForm({ ...form, testRunner: !form.testRunner })}
              />
            ) : null}
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
            {saveError ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {saveError}
              </Alert>
            ) : null}
            {askDiscard ? (
              <Alert data-color="warning" data-size="sm" role="alert">
                {t('integKeys.discardAsk')}
                <div className="actions">
                  <Button data-size="sm" variant="secondary" onClick={() => setAskDiscard(false)}>
                    {t('integKeys.goBack')}
                  </Button>
                  <Button data-size="sm" variant="primary" onClick={tryCloseForm}>
                    {t('integKeys.discard')}
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="actions">
                <Button variant="primary" onClick={() => void save()}>
                  {form.id ? t('common.save') : t('integKeys.createKey')}
                </Button>
                <Button variant="secondary" onClick={tryCloseForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      ) : null}
      {secret ? (
        <Dialog
          open
          modal
          closeButton={false}
          onCancel={(e) => {
            e.preventDefault();
            tryCloseSecret();
          }}
          aria-labelledby="nk-secret-h"
          className="int-dialog"
        >
          <div className="stack-dialog stack-sm">
            <Heading level={2} data-size="xs" id="nk-secret-h">
              {t('integKeys.madeFor', { name: secret.name })}
            </Heading>
            <Paragraph>{t('integKeys.copyNowText')}</Paragraph>
            <dl className="dev-facts">
              <div>
                <dt>{t('integrations.name')}</dt>
                <dd>{secret.name}</dd>
              </div>
              <div>
                <dt>{t('devKeys.expires')}</dt>
                <dd>{secret.expiresAt ? f.date(secret.expiresAt) : t('devKeys.never')}</dd>
              </div>
            </dl>
            <div className="actions">
              <code className="int-secret" aria-label={t('integKeys.newKeyLabel')}>
                {secret.value}
              </code>
              <CopyButton
                text={secret.value}
                onCopied={() =>
                  setSecret((x) => (x ? { ...x, copied: true, askUncopied: false } : x))
                }
              />
            </div>
            {secret.askUncopied ? (
              <Alert data-color="warning" data-size="sm" role="alert">
                {t('integKeys.uncopiedAsk')}
                <div className="actions">
                  <Button
                    data-size="sm"
                    variant="secondary"
                    onClick={() => setSecret({ ...secret, askUncopied: false })}
                  >
                    {t('integKeys.backToCopy')}
                  </Button>
                  <Button data-size="sm" variant="primary" onClick={tryCloseSecret}>
                    {t('integKeys.closeUncopied')}
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="actions">
                <Button variant="primary" onClick={tryCloseSecret}>
                  {t('integKeys.iSavedIt')}
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      ) : null}
      {confirming && target ? (
        <Dialog
          open
          modal
          closeButton={t('common.close')}
          onClose={() => setConfirming(undefined)}
          aria-labelledby="nk-confirm-h"
          className="int-dialog"
        >
          <div className="stack-dialog stack-sm">
            <Heading level={2} data-size="xs" id="nk-confirm-h">
              {t(confirming.kind === 'revoke' ? 'integKeys.revokeTitle' : 'integKeys.rotateTitle', {
                name: target.key.name,
              })}
            </Heading>
            <Paragraph>
              {confirming.kind === 'revoke'
                ? t('integKeys.revokeWarning', { name: target.key.name })
                : t('integKeys.rotateWarning', { name: target.key.name })}
            </Paragraph>
            {confirming.kind === 'revoke' ? (
              <Textfield
                id={`revoke-${target.key.id}`}
                className="int-field-md"
                label={t('common.reason')}
                value={revokeReason}
                error={revokeError || undefined}
                onChange={(e) => {
                  setRevokeReason(e.target.value);
                  setRevokeError('');
                }}
              />
            ) : revokeError ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {revokeError}
              </Alert>
            ) : null}
            <div className="actions">
              <Button
                variant="primary"
                {...(confirming.kind === 'revoke' ? { 'data-color': 'danger' } : {})}
                loading={busy}
                onClick={() =>
                  !busy && void (confirming.kind === 'revoke' ? revoke(target.key) : rotate(target))
                }
              >
                {t(confirming.kind === 'revoke' ? 'integKeys.revokeKey' : 'integKeys.rotateKey')}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
};
