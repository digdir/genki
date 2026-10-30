import {
  Alert,
  Button,
  Checkbox,
  Details,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Spinner,
  Switch,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { createFormat, type Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { Hook, HookPoint, HookSpec, HookTrial } from '../../api/hooks';
import { Crumbs } from '../../components/Crumbs';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { needsRight, rightLabel, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { ApiCallButton } from '../buildingblocks/common';

export const pointKeys: Record<HookPoint, PlainKey> = {
  before_model: 'integHooks.pointBeforeModel',
  after_model: 'integHooks.pointAfterModel',
  before_tool: 'integHooks.pointBeforeTool',
  after_tool: 'integHooks.pointAfterTool',
  task_completed: 'integHooks.pointTaskCompleted',
  on_publish: 'integHooks.pointOnPublish',
  before_search: 'integHooks.pointBeforeSearch',
  after_search: 'integHooks.pointAfterSearch',
  on_feedback: 'integHooks.pointOnFeedback',
};

const effectKeys: Record<HookSpec['mode'], PlainKey> = {
  observe: 'integHooks.effectObserve',
  annotate: 'integHooks.effectAnnotate',
  enforce: 'integHooks.effectEnforce',
};

const effectOptions: [HookSpec['mode'], PlainKey, PlainKey][] = [
  ['observe', 'integHooks.optObserve', 'integHooks.optObserveHelp'],
  ['annotate', 'integHooks.optAnnotate', 'integHooks.optAnnotateHelp'],
  ['enforce', 'integHooks.optEnforce', 'integHooks.optEnforceHelp'],
];

const failureOptions: [HookSpec['failure'], PlainKey, PlainKey][] = [
  ['open', 'integHooks.failOpen', 'integHooks.failOpenHelp'],
  ['closed', 'integHooks.failClosed', 'integHooks.failClosedHelp'],
];

const failureKeys: Record<HookSpec['failure'], PlainKey> = {
  open: 'integHooks.failOpenShort',
  closed: 'integHooks.failClosedShort',
};

const refusable = (point: HookPoint) => point !== 'task_completed' && point !== 'on_feedback';

export const hooksHref = '#/developer/hooks';

export const hookHref = (id?: string) => `#/developer/hooks/${id ? encodeURIComponent(id) : 'new'}`;

const nbFormat = createFormat('nb');

export const durationText = (ms: number, f: Format = nbFormat) =>
  ms < 1000 ? `${ms} ms` : `${f.number(ms / 1000)} s`;

interface Form {
  id: string;
  existing: boolean;
  name: string;
  point: HookPoint;
  mode: HookSpec['mode'];
  failure: HookSpec['failure'];
  enabled: boolean;
  kind: 'builtin' | 'webhook';
  builtin: string;
  terms: string;
  chars: string;
  labels: string;
  url: string;
  secret: string;
  timeoutMs: string;
  order: string;
  services: string[] | undefined;
  reason: string;
  tried: boolean;
}

const emptyForm = (builtin: string): Form => ({
  id: '',
  existing: false,
  name: '',
  point: 'before_model',
  mode: 'observe',
  failure: 'open',
  enabled: true,
  kind: 'webhook',
  builtin,
  terms: '',
  chars: '4000',
  labels: '',
  url: '',
  secret: '',
  timeoutMs: '800',
  order: '1',
  services: undefined,
  reason: '',
  tried: false,
});

const formOf = (h: Hook): Form => ({
  ...emptyForm(h.handler.kind === 'builtin' ? h.handler.id : 'block-terms'),
  id: h.id,
  existing: true,
  name: h.name,
  point: h.point,
  mode: h.mode,
  failure: h.failure,
  enabled: h.enabled,
  kind: h.handler.kind,
  ...(h.handler.kind === 'webhook'
    ? { url: h.handler.url, secret: h.handler.secret }
    : {
        terms: ((h.handler.config.terms as string[] | undefined) ?? []).join(', '),
        chars: String(h.handler.config.chars ?? '4000'),
        labels: Object.entries((h.handler.config.labels as Record<string, string>) ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      }),
  timeoutMs: String(h.timeoutMs),
  order: String(h.order),
  services: h.services,
});

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const configOf = (f: Form): Record<string, unknown> => {
  if (f.builtin === 'block-terms')
    return {
      terms: f.terms
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
  if (f.builtin === 'max-length') return { chars: Number(f.chars) };
  if (f.builtin === 'tag')
    return {
      labels: Object.fromEntries(
        f.labels
          .split('\n')
          .map((l) => l.split('='))
          .filter(([k, v]) => k?.trim() && v?.trim())
          .map(([k, v]) => [k?.trim() ?? '', v?.trim() ?? '']),
      ),
    };
  return {};
};

const specOf = (f: Form): HookSpec => ({
  name: f.name.trim(),
  point: f.point,
  mode: f.mode,
  failure: f.mode === 'enforce' ? f.failure : 'open',
  timeoutMs: Number(f.timeoutMs),
  order: Number(f.order),
  enabled: f.enabled,
  ...(f.services ? { services: f.services } : {}),
  handler:
    f.kind === 'webhook'
      ? { kind: 'webhook', url: f.url.trim(), secret: f.secret.trim() }
      : { kind: 'builtin', id: f.builtin, config: configOf(f) },
});

const specOfHook = (h: Hook): HookSpec => ({
  name: h.name,
  point: h.point,
  mode: h.mode,
  failure: h.failure,
  timeoutMs: h.timeoutMs,
  order: h.order,
  enabled: h.enabled,
  ...(h.services ? { services: h.services } : {}),
  handler: h.handler,
});

const errorsOf = (f: Form, t: T) => ({
  name: f.name.trim() ? '' : t('integHooks.nameProblem'),
  terms:
    f.kind === 'builtin' && f.builtin === 'block-terms' && !f.terms.trim()
      ? t('integHooks.termsProblem')
      : '',
  chars:
    f.kind === 'builtin' && f.builtin === 'max-length' && !(Number(f.chars) > 0)
      ? t('integHooks.charsProblem')
      : '',
  url:
    f.kind === 'webhook' && !/^https:\/\/\S+$/.test(f.url.trim()) ? t('integHooks.urlProblem') : '',
  secret:
    f.kind === 'webhook' && !/^[a-z0-9][a-z0-9._-]*$/.test(f.secret.trim())
      ? t('integHooks.secretProblem')
      : '',
  timeoutMs:
    Number(f.timeoutMs) >= 50 && Number(f.timeoutMs) <= 10_000
      ? ''
      : t('integHooks.timeoutProblem'),
  services: f.services && f.services.length === 0 ? t('integHooks.servicesProblem') : '',
  reason: reasonProblem(f.reason, t) ?? '',
});

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('integConnections.wrong');

export const Hooks = ({
  api,
  tenant,
  tenantName,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const f = useFormat();
  const rights = useRights();
  const canManage = rights.has('manage-services');
  const [state, retry] = useAsync((signal) => api.hooks.list(tenant, signal), [api, tenant]);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  if (state.status === 'loading') return <Loading label={t('integHooks.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { data: own, platform, builtins } = state.data;
  const typeText = ({ handler }: Hook) =>
    handler.kind === 'webhook'
      ? t('integHooks.typeWebhook')
      : t('integHooks.typeBuiltin', {
          title: (builtins.find((b) => b.id === handler.id)?.title ?? handler.id).toLowerCase(),
        });
  const enabled = (h: Hook) => toggled[h.id] ?? h.enabled;
  const sorted = [...own].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const toggle = async (h: Hook) => {
    const next = !enabled(h);
    setToggled((t) => ({ ...t, [h.id]: next }));
    try {
      await api.hooks.save(
        tenant,
        h.id,
        { ...specOfHook(h), enabled: next },
        t(next ? 'integHooks.reasonOn' : 'integHooks.reasonOff', { name: h.name }),
      );
      onFlash(t(next ? 'integHooks.switchedOn' : 'integHooks.switchedOff', { name: h.name }));
    } catch (error) {
      setToggled((t) => ({ ...t, [h.id]: !next }));
      onFlash(problemText(error, t), 'danger');
    }
  };

  return (
    <div className="stack-md">
      <Paragraph data-size="sm" className="meta int-intro-text">
        {t('integHooks.intro')}
      </Paragraph>
      <section aria-labelledby="hooks-platform-h" className="stack-xs">
        <Heading level={3} data-size="2xs" id="hooks-platform-h">
          {t('integHooks.fromPlatform')}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {t('integHooks.platformIntro', { tenant: tenantName })}
        </Paragraph>
        {platform.length ? (
          <div className="int-table" tabIndex={0} role="region" aria-labelledby="hooks-platform-h">
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('integHooks.colHook')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colWhen')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colEffect')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colOnFailure')}</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {platform.map((h) => (
                  <Table.Row key={h.id}>
                    <Table.HeaderCell scope="row">{h.name}</Table.HeaderCell>
                    <Table.Cell>{t(pointKeys[h.point])}</Table.Cell>
                    <Table.Cell>{t(effectKeys[h.mode])}</Table.Cell>
                    <Table.Cell>
                      {t(h.failure === 'closed' ? 'integHooks.failClosed' : 'integHooks.failOpen')}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        ) : (
          <Paragraph data-size="sm">{t('integHooks.noPlatformHooks')}</Paragraph>
        )}
      </section>
      <section aria-labelledby="hooks-own-h" className="stack-xs">
        <div className="int-intro">
          <Heading level={3} data-size="2xs" id="hooks-own-h">
            {t('integHooks.ownHeading', {
              name: tenantName,
              suffix: t(/s$/i.test(tenantName) ? 'integHooks.suffixAfterS' : 'integHooks.suffix'),
            })}
          </Heading>
          {canManage ? (
            <Button variant="primary" data-size="sm" onClick={() => navigate(hookHref())}>
              {t('integHooks.addHook')}
            </Button>
          ) : (
            <span className="meta">{needsRight('manage-services', t)}</span>
          )}
        </div>
        {sorted.length ? (
          <div className="int-table" tabIndex={0} role="region" aria-labelledby="hooks-own-h">
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell scope="col">{t('integHooks.colOrder')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colHook')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colWhen')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colEffect')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colOnFailure')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colServices')}</Table.HeaderCell>
                  <Table.HeaderCell scope="col">{t('integHooks.colOn')}</Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {sorted.map((h) => (
                  <Table.Row key={h.id}>
                    <Table.Cell className="int-num">{h.order}</Table.Cell>
                    <Table.HeaderCell scope="row" className="int-hook-name">
                      {canManage ? <a href={hookHref(h.id)}>{h.name}</a> : <span>{h.name}</span>}
                      <span className="meta">
                        {t('integHooks.typeTimeout', {
                          type: typeText(h),
                          duration: durationText(h.timeoutMs, f),
                        })}
                      </span>
                    </Table.HeaderCell>
                    <Table.Cell>{t(pointKeys[h.point])}</Table.Cell>
                    <Table.Cell>{t(effectKeys[h.mode])}</Table.Cell>
                    <Table.Cell>{t(failureKeys[h.failure])}</Table.Cell>
                    <Table.Cell>
                      {h.services?.length ? h.services.join(', ') : t('integHooks.allServices')}
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        aria-label={t('integHooks.isOn', { name: h.name })}
                        checked={enabled(h)}
                        readOnly={!canManage}
                        onChange={() => canManage && void toggle(h)}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        ) : (
          <Paragraph data-size="sm">{t('integHooks.noHooks')}</Paragraph>
        )}
        <Paragraph data-size="sm">
          {t.rich('integHooks.logNote', { link: (c) => <a href="#/log">{c}</a> })}
        </Paragraph>
      </section>
    </div>
  );
};

const outcomeTag = (trial: HookTrial, t: T) => {
  if (trial.refused) return { text: t('integHooks.outStopped'), color: 'warning' as const };
  const record = trial.records[0];
  if (!record) return { text: t('integHooks.outDidNotRun'), color: 'neutral' as const };
  if (record.outcome === 'failed')
    return { text: t('integHooks.outNoAnswer'), color: 'danger' as const };
  if (record.outcome === 'annotated')
    return { text: t('integHooks.outAnnotated'), color: 'info' as const };
  return { text: t('integHooks.outPassed'), color: 'success' as const };
};

const trialText = (trial: HookTrial, t: T) => {
  const record = trial.records[0];
  if (trial.refused) return t('integHooks.trialStopped', { reason: trial.refused.reason });
  if (record?.outcome === 'failed')
    return t('integHooks.trialFailed', { reason: record.reason ?? t('integHooks.unknownError') });
  if (record?.outcome === 'annotated') return t('integHooks.trialAnnotated');
  return t('integHooks.trialPassed');
};

const TestPanel = ({
  api,
  tenant,
  id,
}: {
  api: ApiClient;
  tenant: string;
  id: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const [testing, setTesting] = useState(false);
  const [trial, setTrial] = useState<HookTrial>();
  const [failed, setFailed] = useState('');
  const run = async () => {
    if (!id || testing) return;
    setTesting(true);
    setFailed('');
    try {
      setTrial(await api.hooks.test(tenant, id));
    } catch (error) {
      setFailed(problemText(error, t));
    } finally {
      setTesting(false);
    }
  };
  const tag = trial ? outcomeTag(trial, t) : undefined;
  const ms = trial?.records[0]?.ms;
  return (
    <section aria-labelledby="hook-test-h" aria-live="polite" className="int-hook-test stack-xs">
      <Heading level={2} data-size="2xs" id="hook-test-h">
        {t('integHooks.testHeading')}
      </Heading>
      {!trial && !testing ? (
        <Paragraph data-size="sm">
          {t('integHooks.testIntro')}
          {id ? null : ` ${t('integHooks.saveFirst')}`}
        </Paragraph>
      ) : null}
      {testing ? (
        <span className="int-inline">
          <Spinner aria-hidden="true" data-size="xs" />
          {t('integHooks.sending')}
        </span>
      ) : null}
      {trial && tag && !testing ? (
        <div className="stack-xs">
          <div className="tag-row">
            {ms !== undefined ? (
              <Tag data-size="sm" data-color={tag.color === 'danger' ? 'danger' : 'success'}>
                {t(tag.color === 'danger' ? 'integHooks.gaveUpAfter' : 'integHooks.answeredIn', {
                  duration: durationText(ms, f),
                })}
              </Tag>
            ) : null}
            <Tag data-size="sm" data-color={tag.color}>
              {tag.text}
            </Tag>
          </div>
          <Paragraph data-size="sm">{trialText(trial, t)}</Paragraph>
          <Details>
            <Details.Summary>{t('integHooks.requestAndResponse')}</Details.Summary>
            <Details.Content>
              <pre className="int-pre">
                {JSON.stringify(
                  {
                    [t('integHooks.jsonExample')]: trial.payload,
                    [t('integHooks.jsonResponse')]: trial.records,
                  },
                  null,
                  2,
                )}
              </pre>
            </Details.Content>
          </Details>
        </div>
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      {id ? (
        <div className="actions">
          <Button variant="secondary" data-size="sm" onClick={() => void run()}>
            {trial ? t('integHooks.testAgain') : t('integHooks.testHeading')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

export const HookEditor = ({
  api,
  tenant,
  id,
}: {
  api: ApiClient;
  tenant: string;
  id: string | undefined;
}) => {
  const t = useT();
  const rights = useRights();
  const [state, retry] = useAsync(
    async (signal) => {
      const [hooks, definitions] = await Promise.all([
        api.hooks.list(tenant, signal),
        api.listDefinitions(tenant, signal).catch(() => []),
      ]);
      return {
        hooks,
        services: definitions.filter((d) => d.kind === 'Service').map((d) => d.id),
      };
    },
    [api, tenant],
  );
  const [form, setForm] = useState<Form>();
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  const crumbs = (
    <Crumbs
      items={[
        { label: t('devTools.title'), href: '#/developer' },
        { label: t('integHooks.heading'), href: hooksHref },
        { label: id ? t('integHooks.editHook') : t('integHooks.addHook') },
      ]}
    />
  );
  const head = (
    <>
      {crumbs}
      <div className="stack-xs int-intro-text">
        <Heading level={1} data-size="md">
          {t('integHooks.heading')}
        </Heading>
        <p className="lead">{t('integHooks.lead')}</p>
      </div>
    </>
  );

  if (state.status === 'loading')
    return (
      <div className="stack int">
        {head}
        <Loading label={t('integHooks.loadingOne')} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="stack int">
        {head}
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  const { builtins } = state.data.hooks;
  const existing = id ? state.data.hooks.data.find((h) => h.id === id) : undefined;
  if (id && !existing)
    return (
      <div className="stack int">
        {head}
        <Alert data-color="warning">
          <Paragraph>
            {t.rich('integHooks.notFound', { link: (c) => <a href={hooksHref}>{c}</a> })}
          </Paragraph>
        </Alert>
      </div>
    );
  if (!rights.has('manage-services'))
    return (
      <div className="stack int">
        {head}
        <Alert data-color="info">
          <Paragraph>{needsRight('manage-services', t)}</Paragraph>
        </Alert>
      </div>
    );
  const f = form ?? (existing ? formOf(existing) : emptyForm(builtins[0]?.id ?? 'block-terms'));
  const set = (patch: Partial<Form>) => setForm({ ...f, ...patch });
  const errors = errorsOf(f, t);
  const shown = (key: keyof typeof errors) => (f.tried && errors[key] ? errors[key] : undefined);
  const hookId = f.existing ? f.id : slug(f.name) || 'ny-krok';
  const services = state.data.services;
  const chosen = (s: string) => !f.services || f.services.includes(s);

  const save = async () => {
    if (saving) return;
    if (Object.values(errors).some(Boolean)) {
      set({ tried: true });
      return;
    }
    setSaveError('');
    setSaving(true);
    try {
      await api.hooks.save(tenant, hookId, specOf(f), f.reason.trim());
      navigate(`${hooksHref}?saved=${encodeURIComponent(f.name.trim())}`);
    } catch (error) {
      setSaveError(problemText(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack int">
      {head}
      <div className="int-hook-grid">
        <form
          className="int-hook-form stack-md"
          aria-labelledby="hook-form-h"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Heading level={2} data-size="xs" id="hook-form-h">
            {f.existing ? f.name || t('integHooks.editHook') : t('integHooks.newHook')}
          </Heading>
          <Textfield
            label={t('integrations.name')}
            value={f.name}
            error={shown('name')}
            onChange={(e) => set({ name: e.target.value })}
          />
          <Field className="int-field-md">
            <Label>{t('integHooks.whenRuns')}</Label>
            <Select
              value={f.point}
              onChange={(e) => {
                const point = e.target.value as HookPoint;
                set({
                  point,
                  mode: !refusable(point) && f.mode === 'enforce' ? 'observe' : f.mode,
                });
              }}
            >
              {(Object.keys(pointKeys) as HookPoint[]).map((p) => (
                <Select.Option key={p} value={p}>
                  {t(pointKeys[p])}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <Fieldset>
            <Fieldset.Legend>{t('integrations.rowType')}</Fieldset.Legend>
            <Radio
              name="hook-kind"
              label={t('integHooks.kindWebhook')}
              checked={f.kind === 'webhook'}
              onChange={() => set({ kind: 'webhook' })}
            />
            <Radio
              name="hook-kind"
              label={t('integHooks.kindBuiltin')}
              checked={f.kind === 'builtin'}
              onChange={() => set({ kind: 'builtin' })}
            />
          </Fieldset>
          {f.kind === 'webhook' ? (
            <>
              <Textfield
                label={t('integHooks.address')}
                type="url"
                value={f.url}
                error={shown('url')}
                onChange={(e) => set({ url: e.target.value })}
              />
              <Textfield
                label={t('integHooks.secretLabel')}
                description={t('integHooks.secretHelp')}
                value={f.secret}
                error={shown('secret')}
                onChange={(e) => set({ secret: e.target.value })}
              />
            </>
          ) : (
            <>
              <Field className="int-field-md">
                <Label>{t('integHooks.function')}</Label>
                <Select value={f.builtin} onChange={(e) => set({ builtin: e.target.value })}>
                  {builtins.map((b) => (
                    <Select.Option key={b.id} value={b.id}>
                      {b.title}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              {f.builtin === 'block-terms' ? (
                <Textfield
                  label={t('integHooks.terms')}
                  description={t('integHooks.termsHelp')}
                  value={f.terms}
                  error={shown('terms')}
                  onChange={(e) => set({ terms: e.target.value })}
                />
              ) : null}
              {f.builtin === 'max-length' ? (
                <Textfield
                  label={t('integHooks.maxChars')}
                  inputMode="numeric"
                  value={f.chars}
                  error={shown('chars')}
                  onChange={(e) => set({ chars: e.target.value })}
                />
              ) : null}
              {f.builtin === 'tag' ? (
                <Textfield
                  multiline
                  rows={3}
                  label={t('integHooks.labels')}
                  description={t('integHooks.labelsHelp')}
                  value={f.labels}
                  onChange={(e) => set({ labels: e.target.value })}
                />
              ) : null}
            </>
          )}
          <Fieldset>
            <Fieldset.Legend>{t('integHooks.colEffect')}</Fieldset.Legend>
            {effectOptions
              .filter(([m]) => m !== 'enforce' || refusable(f.point))
              .map(([m, label, description]) => (
                <Radio
                  key={m}
                  name="hook-mode"
                  label={t(label)}
                  description={t(description)}
                  checked={f.mode === m}
                  onChange={() => set({ mode: m, ...(m === 'enforce' ? {} : { failure: 'open' }) })}
                />
              ))}
          </Fieldset>
          <Fieldset>
            <Fieldset.Legend>{t('integHooks.ifFails')}</Fieldset.Legend>
            {failureOptions.map(([value, label, description]) => {
              const locked = value === 'closed' && f.mode !== 'enforce';
              return (
                <Radio
                  key={value}
                  name="hook-failure"
                  label={t(label)}
                  description={
                    locked ? `${t(description)} ${t('integHooks.needsEnforce')}` : t(description)
                  }
                  checked={(f.mode === 'enforce' ? f.failure : 'open') === value}
                  aria-disabled={locked || undefined}
                  onChange={() => !locked && set({ failure: value })}
                />
              );
            })}
          </Fieldset>
          <div className="int-hook-numbers">
            <Textfield
              label={t('integHooks.timeout')}
              inputMode="numeric"
              value={f.timeoutMs}
              error={shown('timeoutMs')}
              onChange={(e) => set({ timeoutMs: e.target.value })}
            />
            <Textfield
              label={t('integHooks.colOrder')}
              inputMode="numeric"
              value={f.order}
              onChange={(e) => set({ order: e.target.value })}
            />
          </div>
          <Fieldset>
            <Fieldset.Legend>{t('integHooks.appliesTo')}</Fieldset.Legend>
            <Checkbox
              label={t('integHooks.allTheServices')}
              checked={!f.services}
              onChange={() => set({ services: f.services ? undefined : [] })}
            />
            {services.map((s) => (
              <Checkbox
                key={s}
                label={s}
                checked={chosen(s)}
                onChange={() => {
                  const current = f.services ?? services;
                  set({
                    services: current.includes(s)
                      ? current.filter((x) => x !== s)
                      : [...current, s],
                  });
                }}
              />
            ))}
            {shown('services') ? <span className="int-error">{shown('services')}</span> : null}
          </Fieldset>
          <Switch
            label={t('integHooks.colOn')}
            checked={f.enabled}
            onChange={() => set({ enabled: !f.enabled })}
          />
          <ReasonField
            value={f.reason}
            onChange={(reason) => set({ reason })}
            showError={f.tried}
            description={t('integrations.reasonRequired')}
          />
          {saveError ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {saveError}
            </Alert>
          ) : null}
          <div className="actions">
            <Button variant="primary" type="submit" aria-disabled={saving || undefined}>
              {t('common.save')}
            </Button>
            <Button variant="tertiary" type="button" onClick={() => navigate(hooksHref)}>
              {t('common.cancel')}
            </Button>
            <ApiCallButton
              call={() => ({
                action: t('integHooks.saveHook'),
                method: 'PUT',
                path: `/tenants/${tenant}/hooks/${hookId}`,
                body: specOf(f),
                right: rightLabel(t, 'manage-services'),
              })}
            />
          </div>
        </form>
        <TestPanel api={api} tenant={tenant} id={existing?.id} />
      </div>
    </div>
  );
};
