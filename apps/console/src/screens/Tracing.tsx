import {
  Alert,
  Button,
  Checkbox,
  Chip,
  ErrorSummary,
  Fieldset,
  FieldsetLegend,
  Heading,
  Paragraph,
  Radio,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import type { ApiClient } from '../api';
import { useT } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { ErrorState, Loading } from '../states';
import type { Hosting, TraceConnection, TraceTool, TracingStatus } from '../types';
import { Flash, formatWhen, PageHeader, TableRegion, Unavailable, useFlash } from '../ui';

const fromEnvironment = (status: TracingStatus): Record<string, TraceConnection> => {
  if (!status.enabled || !status.endpoint) return {};
  const tool = /langfuse/i.test(status.endpoint) ? 'langfuse' : 'otel';
  return {
    [tool]: {
      status:
        (status.stats?.failed ?? 0) > 0 && (status.stats?.exported ?? 0) === 0 ? 'failing' : 'ok',
      hosting: 'norway',
      values: tool === 'langfuse' ? { host: status.endpoint } : { endpoint: status.endpoint },
      secretsStored: true,
      scope: [],
      content: status.content ? 'full' : 'meta',
      mask: true,
      sampleRate: Math.round((status.sampleRate ?? 1) * 100),
      syncScores: false,
      annotations: false,
      ...(status.stats ? { sent24h: status.stats.exported, queued: status.stats.failed } : {}),
    },
  };
};

const blank: TraceConnection = {
  status: 'ok',
  hosting: 'norway',
  values: {},
  secretsStored: false,
  scope: [],
  content: 'meta',
  mask: true,
  sampleRate: 100,
  syncScores: false,
  annotations: false,
};

type Draft = Omit<TraceConnection, 'sampleRate'> & {
  sampleRate: string;
  secrets: Record<string, string>;
};

const toDraft = (c: TraceConnection | undefined): Draft => ({
  ...(c ?? blank),
  sampleRate: String((c ?? blank).sampleRate),
  secrets: {},
});

const Form = ({
  api,
  tool,
  connection,
  agencies,
  onSaved,
  onDisconnected,
  onFlash,
}: {
  api: ApiClient;
  tool: TraceTool;
  connection: TraceConnection | undefined;
  agencies: string[];
  onSaved: (c: TraceConnection) => void;
  onDisconnected: () => void;
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const fmt = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [d, setD] = useState<Draft>(() => toDraft(connection));
  const [tried, setTried] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ text: string; link: boolean } | undefined>();
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const connected = Boolean(connection);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const errors: { id: string; text: string }[] = [];
  for (const f of tool.fields) {
    const v = f.type === 'secret' ? (d.secrets[f.key] ?? '') : (d.values[f.key] ?? '');
    if (f.type === 'url' && !/^https:\/\/\S+\.\S+/.test(v))
      errors.push({ id: `f-${f.key}`, text: t('tracing.errUrl') });
    if (f.key === 'pk' && !/^pk-lf-\S{4,}/.test(v))
      errors.push({ id: `f-${f.key}`, text: t('tracing.errPublicKey') });
    if (f.type === 'secret' && !d.secretsStored && v.length < 12)
      errors.push({ id: `f-${f.key}`, text: t('tracing.errRequired', { label: f.label }) });
    if (f.type === 'secret' && d.secretsStored && v && v.length < 12)
      errors.push({ id: `f-${f.key}`, text: t('tracing.errKeyShort') });
  }
  const rate = Number(d.sampleRate);
  if (!(Number.isInteger(rate) && rate >= 1 && rate <= 100))
    errors.push({ id: 'utvalg', text: t('tracing.errRate') });
  if (!d.scope.length) errors.push({ id: 'scope-err', text: t('tracing.errScope') });
  const errorFor = (id: string) => (tried ? errors.find((e) => e.id === id)?.text : undefined);

  const save = async () => {
    if (errors.length) {
      setTried(true);
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    try {
      const { secrets, sampleRate, ...rest } = d;
      await api.saveTracing(tool.id, {
        hosting: rest.hosting,
        values: rest.values,
        scope: rest.scope,
        content: rest.content,
        mask: rest.mask,
        syncScores: rest.syncScores,
        annotations: rest.annotations,
        sampleRate: Number(sampleRate),
        secrets,
      });
      const newSecret = Object.values(secrets).some(Boolean);
      onSaved({
        ...rest,
        sampleRate: Number(sampleRate),
        secretsStored: true,
        status: !connection || newSecret ? 'ok' : connection.status,
      });
      setD((x) => ({ ...x, secrets: {}, secretsStored: true }));
      setTried(false);
      const say = tRef.current;
      onFlash(
        `${connected ? say('tracing.savedSettings', { tool: tool.name }) : say('tracing.savedConnected', { tool: tool.name })}${say('tracing.savedRest')}`,
      );
    } catch {
      onFlash(tRef.current('tracing.saveFailed', { tool: tool.name }), 'danger');
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestMsg({ text: t('tracing.sendingTest'), link: false });
    try {
      const r = await api.testTracing(tool.id);
      setTestMsg(
        r.delivered
          ? {
              text: tRef.current('tracing.testDelivered', {
                seconds: fmt.number(r.seconds ?? 1),
              }),
              link: true,
            }
          : {
              text: tRef.current('tracing.testRejected', {
                code: r.code ?? tRef.current('tracing.testCodeFallback'),
              }),
              link: false,
            },
      );
    } catch {
      setTestMsg({ text: tRef.current('tracing.testFailed'), link: false });
    } finally {
      setTesting(false);
    }
  };

  const failing = connection?.status === 'failing';
  const secretField = tool.fields.find((f) => f.type === 'secret');

  return (
    <>
      {connection ? (
        <section
          className={failing ? 'card stack status-card failing' : 'card stack status-card'}
          aria-labelledby="stat-h"
        >
          <div className="name-line">
            <Heading level={2} data-size="xs" id="stat-h">
              {t('tracing.statusFor', { tool: tool.name })}
            </Heading>
            <Tag data-color={failing ? 'danger' : 'success'}>
              {failing ? t('tracing.failing') : t('tracing.connected')}
            </Tag>
          </div>
          <dl className="facts">
            <div>
              <dt>{t('tracing.lastDelivery')}</dt>
              <dd>{connection.lastDelivery ? formatWhen(connection.lastDelivery, fmt, t) : '–'}</dd>
            </div>
            <div>
              <dt>{t('tracing.sent24h')}</dt>
              <dd>
                {connection.sent24h === undefined
                  ? '–'
                  : t('tracing.traces', { count: connection.sent24h })}
              </dd>
            </div>
            <div>
              <dt>{t('tracing.waiting')}</dt>
              <dd>{connection.queued ? t('tracing.traces', { count: connection.queued }) : '0'}</dd>
            </div>
            <div>
              <dt>{t('tracing.sampling')}</dt>
              <dd>{t('tracing.percent', { value: connection.sampleRate })}</dd>
            </div>
          </dl>
          {failing ? (
            <Alert data-color="danger" data-size="sm">
              <Paragraph>
                {connection.error?.what ?? t('tracing.rejectsKey', { tool: tool.name })}
              </Paragraph>
              <Paragraph>{connection.error?.why ?? t('tracing.keyChanged')}</Paragraph>
              <div className="name-line">
                <Button
                  data-size="sm"
                  onClick={() => {
                    if (secretField) document.getElementById(`f-${secretField.key}`)?.focus();
                    onFlash(t('tracing.pasteNewSecret'), 'info');
                  }}
                >
                  {t('tracing.replaceSecret')}
                </Button>
                <span className="meta">
                  {t('tracing.technicalCode', {
                    code: connection.error?.code ?? '401 Unauthorized',
                  })}
                </span>
              </div>
            </Alert>
          ) : null}
          <div className="name-line">
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={testing || undefined}
              onClick={() => void (testing ? undefined : sendTest())}
            >
              {t('tracing.sendTest')}
            </Button>
            <span role="status">
              {testing ? <Spinner aria-hidden data-size="xs" /> : null}
              {testMsg?.text}
              {testMsg?.link ? (
                <>
                  {' '}
                  <a
                    href={d.values.host ?? d.values.endpoint ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('tracing.openTest', { tool: tool.name })}
                  </a>
                </>
              ) : null}
            </span>
          </div>
        </section>
      ) : null}

      <section className="card stack" aria-labelledby="opps-h">
        <Heading level={2} data-size="xs" id="opps-h">
          {connected ? t('tracing.settings') : t('tracing.connectTo', { tool: tool.name })}
        </Heading>
        {tried && errors.length ? (
          <ErrorSummary ref={summary} tabIndex={-1}>
            <ErrorSummary.Heading>{t('tracing.fixBeforeSaving')}</ErrorSummary.Heading>
            <ErrorSummary.List>
              {errors.map((e) => (
                <ErrorSummary.Item key={e.id + e.text}>
                  <ErrorSummary.Link href={`#${e.id}`}>{e.text}</ErrorSummary.Link>
                </ErrorSummary.Item>
              ))}
            </ErrorSummary.List>
          </ErrorSummary>
        ) : null}
        {tool.fields.map((f) =>
          f.type === 'secret' ? (
            <Textfield
              key={f.key}
              id={`f-${f.key}`}
              label={f.label}
              description={`${f.help}${d.secretsStored && !d.secrets[f.key] ? t('tracing.storedInVault') : ''}`.trim()}
              type="password"
              autoComplete="off"
              placeholder={d.secretsStored ? t('tracing.pasteNewValue') : f.placeholder}
              value={d.secrets[f.key] ?? ''}
              error={errorFor(`f-${f.key}`)}
              onChange={(e) => set({ secrets: { ...d.secrets, [f.key]: e.target.value } })}
            />
          ) : (
            <Textfield
              key={f.key}
              id={`f-${f.key}`}
              label={f.label}
              {...(f.help ? { description: f.help } : {})}
              type={f.type === 'url' ? 'url' : 'text'}
              autoComplete="off"
              placeholder={f.placeholder}
              value={d.values[f.key] ?? ''}
              error={errorFor(`f-${f.key}`)}
              onChange={(e) => set({ values: { ...d.values, [f.key]: e.target.value } })}
            />
          ),
        )}
        <Fieldset>
          <FieldsetLegend>{t('tracing.hostedWhere', { tool: tool.name })}</FieldsetLegend>
          <div className="chips">
            {(
              [
                ['norway', t('tracing.hostNorway')],
                ['eu', t('tracing.hostEu')],
                ['outside', t('tracing.hostOutside')],
              ] as [Hosting, string][]
            ).map(([value, label]) => (
              <Chip.Radio
                key={value}
                name="vertskap"
                checked={d.hosting === value}
                onChange={() => set({ hosting: value })}
              >
                {label}
              </Chip.Radio>
            ))}
          </div>
          {d.hosting === 'outside' ? (
            <Alert data-color="warning" data-size="sm">
              {t('tracing.outsideWarning')}
            </Alert>
          ) : null}
        </Fieldset>
        <Fieldset>
          <FieldsetLegend>{t('tracing.scopeLegend', { tool: tool.name })}</FieldsetLegend>
          {agencies.map((a) => (
            <Checkbox
              key={a}
              label={a}
              {...(a === 'Testetaten' ? { description: t('tracing.hasOwn') } : {})}
              checked={d.scope.includes(a)}
              onChange={() =>
                set({
                  scope: d.scope.includes(a) ? d.scope.filter((x) => x !== a) : [...d.scope, a],
                })
              }
            />
          ))}
          {errorFor('scope-err') ? (
            <ValidationMessage id="scope-err">{errorFor('scope-err')}</ValidationMessage>
          ) : null}
        </Fieldset>
        <Fieldset>
          <FieldsetLegend>{t('tracing.whatSent')}</FieldsetLegend>
          <Radio
            name="innhold"
            value="meta"
            label={t('tracing.metaOnly')}
            description={t('tracing.metaDescription')}
            checked={d.content === 'meta'}
            onChange={() => set({ content: 'meta' })}
          />
          <Radio
            name="innhold"
            value="full"
            label={t('tracing.fullContent')}
            description={t('tracing.fullDescription')}
            checked={d.content === 'full'}
            onChange={() => set({ content: 'full' })}
          />
        </Fieldset>
        <Switch
          label={t('tracing.mask')}
          description={t('tracing.maskDescription')}
          checked={d.mask}
          onChange={() => set({ mask: !d.mask })}
        />
        {d.content === 'full' && !d.mask ? (
          <Alert data-color="warning" data-size="sm">
            {t('tracing.unmaskedWarning', { tool: tool.name })}
          </Alert>
        ) : null}
        <Textfield
          className="narrow"
          id="utvalg"
          label={t('tracing.rateLabel')}
          description={t('tracing.rateDescription')}
          inputMode="numeric"
          value={d.sampleRate}
          error={errorFor('utvalg')}
          onChange={(e) => set({ sampleRate: e.target.value })}
        />
        <Fieldset>
          <FieldsetLegend>{t('tracing.sync')}</FieldsetLegend>
          <Switch
            label={t('tracing.syncScores')}
            description={t('tracing.syncScoresDescription', { tool: tool.name })}
            checked={d.syncScores}
            onChange={() => set({ syncScores: !d.syncScores })}
          />
          <Switch
            label={t('tracing.annotations')}
            description={t('tracing.annotationsDescription', { tool: tool.name })}
            checked={d.annotations}
            onChange={() => set({ annotations: !d.annotations })}
          />
        </Fieldset>
        <div className="actions-row">
          <Button onClick={() => void save()}>
            {connected ? t('tracing.save') : t('tracing.connect')}
          </Button>
          {connected ? (
            <Button
              variant="tertiary"
              data-color="danger"
              onClick={() => {
                void api.disconnectTracing(tool.id).then(
                  () => {
                    onDisconnected();
                    onFlash(tRef.current('tracing.disconnected', { tool: tool.name }), 'info');
                  },
                  () =>
                    onFlash(
                      tRef.current('tracing.disconnectFailed', { tool: tool.name }),
                      'danger',
                    ),
                );
              }}
            >
              {t('tracing.disconnect')}
            </Button>
          ) : null}
        </div>
      </section>
    </>
  );
};

const EnvironmentTracing = ({ status }: { status: TracingStatus }) => {
  const t = useT();
  const f = useFormat();
  return (
    <>
      <section className="card stack-sm" aria-labelledby="miljo-h">
        <div className="card-head">
          <Heading level={2} data-size="xs" id="miljo-h">
            {t('tracing.envTitle')}
          </Heading>
          <Tag data-size="sm" data-color={status.enabled ? 'success' : 'neutral'}>
            {status.enabled ? t('tracing.on') : t('tracing.off')}
          </Tag>
        </div>
        <Paragraph data-size="sm">{t('tracing.envNote')}</Paragraph>
        {status.enabled ? (
          <dl className="def-list">
            {status.endpoint ? (
              <>
                <dt>{t('tracing.target')}</dt>
                <dd>{status.endpoint}</dd>
              </>
            ) : null}
            <dt>{t('tracing.content')}</dt>
            <dd>{status.content ? t('tracing.fullContent') : t('tracing.metaOnly')}</dd>
            {status.sampleRate !== undefined ? (
              <>
                <dt>{t('tracing.shareSent')}</dt>
                <dd>{t('tracing.percent', { value: Math.round(status.sampleRate * 100) })}</dd>
              </>
            ) : null}
            {status.stats ? (
              <>
                <dt>{t('tracing.sent')}</dt>
                <dd>{f.number(status.stats.exported)}</dd>
                <dt>{t('tracing.failed')}</dt>
                <dd>{f.number(status.stats.failed)}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </section>
      <Unavailable title={t('tracing.unavailableTitle')}>
        {t('tracing.unavailableText')}
      </Unavailable>
    </>
  );
};

export const Tracing = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const tenantName = useTenantNames(api);
  const [state, retry] = useAsync(
    async (signal) => {
      const [status, tenants] = await Promise.all([
        api.tracing(signal),
        api.listTenants(signal).catch(() => []),
      ]);
      return { status, agencies: tenants.map((x) => x.name) };
    },
    [api],
  );
  const [tool, setTool] = useState('langfuse');
  const [connections, setConnections] = useState<Record<string, TraceConnection>>({});
  const flash = useFlash();

  useEffect(() => {
    if (state.status === 'ready')
      setConnections(state.data.status.connections ?? fromEnvironment(state.data.status));
  }, [state]);

  const tools = state.status === 'ready' ? state.data.status.tools : undefined;
  const current = tools?.find((x) => x.id === tool) ?? tools?.[0];

  return (
    <>
      <PageHeader title={t('tracing.title')} intro={t('tracing.intro')} />
      <Alert data-color="info" data-size="sm">
        {t('tracing.sourceNote')}
      </Alert>
      <div className="fixed-rule" role="note">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v10H5z" />
        </svg>
        <span>
          <strong>{t('tracing.fixedRule')}</strong>
          {t('tracing.fixedRuleText')}
        </span>
      </div>
      <Flash message={flash.message} />
      {state.status === 'loading' ? (
        <Loading label={t('tracing.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !tools ? (
        <EnvironmentTracing status={state.data.status} />
      ) : (
        <>
          <section className="stack" aria-labelledby="verk-h">
            <Heading level={2} data-size="xs" id="verk-h">
              {t('tracing.toolsTitle')}
            </Heading>
            <ul className="plain tool-grid">
              {tools.map((x) => {
                const c = connections[x.id];
                const s: [string, 'neutral' | 'danger' | 'success'] = !c
                  ? [t('tracing.notConnected'), 'neutral']
                  : c.status === 'failing'
                    ? [t('tracing.failing'), 'danger']
                    : [t('tracing.connected'), 'success'];
                return (
                  <li key={x.id}>
                    <button
                      type="button"
                      className={x.id === current?.id ? 'tool-card selected' : 'tool-card'}
                      aria-pressed={x.id === current?.id}
                      onClick={() => setTool(x.id)}
                    >
                      <span className="label-strong">{x.name}</span>
                      <span className="meta">{x.description}</span>
                      <Tag data-size="sm" data-color={s[1]}>
                        {s[0]}
                      </Tag>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Paragraph data-size="sm" className="meta">
              {t('tracing.toolsNote')}
            </Paragraph>
          </section>
          {current ? (
            <Form
              key={current.id}
              api={api}
              tool={current}
              connection={connections[current.id]}
              agencies={state.data.agencies}
              onSaved={(c) => setConnections((all) => ({ ...all, [current.id]: c }))}
              onDisconnected={() =>
                setConnections((all) =>
                  Object.fromEntries(Object.entries(all).filter(([id]) => id !== current.id)),
                )
              }
              onFlash={flash.show}
            />
          ) : null}
          {state.data.status.tenantConnections ? (
            <section className="stack" aria-labelledby="egne-h">
              <Heading level={2} data-size="xs" id="egne-h">
                {t('tracing.ownTitle')}
              </Heading>
              <Paragraph>{t('tracing.ownText')}</Paragraph>
              <TableRegion label={t('tracing.ownLabel')}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">{t('tracing.colTenant')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('tracing.colTool')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('tracing.colContent')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('tracing.colStatus')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('tracing.colLastDelivery')}</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {state.data.status.tenantConnections.map((r) => (
                      <TableRow key={r.tenant}>
                        <TableHeaderCell scope="row" className="row-head">
                          {tenantName(r.tenant)}
                        </TableHeaderCell>
                        <TableCell>{r.tool}</TableCell>
                        <TableCell>{r.content}</TableCell>
                        <TableCell>
                          <Tag data-size="sm" data-color={r.status === 'ok' ? 'success' : 'danger'}>
                            {r.status === 'ok' ? t('tracing.connected') : t('tracing.failing')}
                          </Tag>
                        </TableCell>
                        <TableCell>{formatWhen(r.lastDelivery, f, t)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
            </section>
          ) : null}
          <section className="stack" aria-labelledby="tl-h">
            <Heading level={2} data-size="xs" id="tl-h">
              {t('tracing.timelineTitle')}
            </Heading>
            <div className="card stack-sm">
              <div className="name-line">
                <span className="label-strong">Rapportassistenten</span>
                <Tag data-size="sm" data-color="success">
                  {t('tracing.timelineStatus')}
                </Tag>
              </div>
              <span className="meta">{t('tracing.timelineMeta')}</span>
              <span>
                {t.rich('tracing.timelineSent', { link: (c) => <a href="#/tracing">{c}</a> })}
              </span>
              <span>
                {t.rich('tracing.timelineMetaSent', { link: (c) => <a href="#/tracing">{c}</a> })}
              </span>
            </div>
            <Paragraph data-size="sm" className="meta">
              {t('tracing.timelineNote')}
            </Paragraph>
          </section>
        </>
      )}
    </>
  );
};
