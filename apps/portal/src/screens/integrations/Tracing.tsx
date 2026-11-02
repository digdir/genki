import {
  Alert,
  Button,
  Checkbox,
  Chip,
  ErrorSummary,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Spinner,
  Switch,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { type ComponentRef, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { highRiskServices, traceServices, traceTools } from '../../data/integrations';
import { useT } from '../../i18n';
import { IntegrationTab } from '../developer-routes';

const lock = 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v10H5z';
const pulse = 'M4 12h4l3-7 4 14 3-7h2';

interface Connection {
  status: 'ok' | 'feil';
  stored: boolean;
  values: Record<string, string>;
  scope: string[];
  content: 'meta' | 'full';
  mask: boolean;
  rate: string;
  loc: 'norge' | 'eu' | 'utenfor';
  syncScores: boolean;
  annotations: boolean;
}

const blank = (): Connection => ({
  status: 'ok',
  stored: false,
  values: {},
  scope: [],
  content: 'meta',
  mask: true,
  rate: '100',
  loc: 'norge',
  syncScores: false,
  annotations: false,
});

export const Tracing = ({
  tenantName,
  status,
  fullContent,
}: {
  tenantName: string;
  status: 'feil' | 'ok';
  fullContent: boolean;
}) => {
  const t = useT();
  // Utviklerverktøy already names the page above it.
  const inDeveloperTools = useContext(IntegrationTab) !== undefined;
  const tRef = useRef(t);
  tRef.current = t;
  const [toolId, setToolId] = useState('langfuse');
  const [conns, setConns] = useState<Record<string, Connection>>(() => ({
    langfuse: {
      ...blank(),
      status,
      stored: true,
      values: { host: 'https://langfuse.testetaten.example.no', pk: 'pk-lf-3c9e81' },
      scope: ['Rapportassistenten', 'Søknadsuttrekk', 'Høringsoppsummering'],
      content: fullContent ? 'full' : 'meta',
      rate: '25',
      syncScores: true,
      annotations: true,
    },
  }));
  const [draft, setDraft] = useState<Connection>(() => conns.langfuse ?? blank());
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [testLink, setTestLink] = useState(false);
  const [flash, setFlash] = useState<{ text: string; color: 'success' | 'info' } | undefined>();
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const found = traceTools.find((x) => x.id === toolId) ?? traceTools[0];
  if (!found) return null;
  const toolName = (x: typeof found) => (x.nameKey ? t(x.nameKey) : x.name);
  const tool = { ...found, name: toolName(found) };
  const saved = conns[toolId];
  const connected = saved !== undefined;

  const errs: Record<string, string> = {};
  tool.fields.forEach(([k, label, type]) => {
    const v = type === 'secret' ? (secrets[k] ?? '') : (draft.values[k] ?? '');
    if (type === 'url' && !/^https:\/\/\S+\.\S+/.test(v)) errs[k] = t('integTracing.urlProblem');
    if (k === 'pk' && !/^pk-lf-\S{4,}/.test(v)) errs[k] = t('integTracing.publicKeyProblem');
    if (type === 'secret' && !draft.stored && v.length < 12)
      errs[k] = t('integTracing.required', { field: t(label) });
    if (type === 'secret' && draft.stored && v && v.length < 12)
      errs[k] = t('integTracing.keyTooShort');
  });
  const r = Number(draft.rate);
  if (!(Number.isInteger(r) && r >= 1 && r <= 100)) errs.rate = t('integTracing.rateProblem');
  if (!draft.scope.length) errs.scope = t('integHooks.servicesProblem');
  const shown = tried ? errs : {};
  const highFull =
    draft.content === 'full' && draft.scope.some((s) => highRiskServices.includes(s));
  const maskWarn =
    draft.content === 'full' && !draft.mask
      ? t('integTracing.maskWarning', { tool: tool.name })
      : highFull
        ? t('integTracing.highRiskWarning', {
            service: draft.scope.find((x) => highRiskServices.includes(x)) ?? '',
          })
        : '';

  const pick = (id: string) => {
    setToolId(id);
    setDraft(conns[id] ?? blank());
    setSecrets({});
    setTried(false);
    setTestMsg('');
    setTestLink(false);
  };

  const save = () => {
    if (Object.keys(errs).length) {
      setTried(true);
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    const newSecret = tool.fields.some(([k, , type]) => type === 'secret' && secrets[k]);
    const next: Connection = {
      ...draft,
      stored: true,
      status: !connected || newSecret ? 'ok' : (saved?.status ?? 'ok'),
    };
    setConns({ ...conns, [toolId]: next });
    setDraft(next);
    setSecrets({});
    setTried(false);
    setFlash({
      text: t(connected ? 'integTracing.settingsSaved' : 'integTracing.connected', {
        tool: tool.name,
      }),
      color: 'success',
    });
  };

  const failing = saved?.status === 'feil';
  const set = (p: Partial<Connection>) => setDraft({ ...draft, ...p });

  return (
    <div className="stack-md">
      <div className="stack-sm int-trace-head">
        {inDeveloperTools ? null : (
          <Heading level={2} data-size="md">
            {t('integrations.tabTracing')}
          </Heading>
        )}
        <p className="lead">{t('integTracing.lead', { tenant: tenantName })}</p>
      </div>
      <Alert data-color="info" data-size="sm">
        {t('integTracing.sourceNote')}
      </Alert>
      <div role="note" className="int-rule">
        <Icon d={lock} />
        <span>{t.rich('integTracing.fixedRule', { strong: (c) => <strong>{c}</strong> })}</span>
      </div>
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      <section aria-labelledby="verk-h" className="stack-sm">
        <Heading level={3} data-size="xs" id="verk-h">
          {t('integTracing.tools')}
        </Heading>
        <ul className="int-tools">
          {traceTools.map((x) => {
            const c = conns[x.id];
            const [label, color] = !c
              ? ([t('integTracing.notConnected'), 'neutral'] as const)
              : c.status === 'feil'
                ? ([t('integrations.statusFailing'), 'danger'] as const)
                : ([t('integTracing.statusConnected'), 'success'] as const);
            return (
              <li key={x.id}>
                <button
                  type="button"
                  aria-pressed={x.id === toolId}
                  className={x.id === toolId ? 'int-tool on' : 'int-tool'}
                  onClick={() => pick(x.id)}
                >
                  <span className="int-row-name">{toolName(x)}</span>
                  <span className="meta">{t(x.desc)}</span>
                  <Tag data-size="sm" data-color={color}>
                    {label}
                  </Tag>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="meta">{t('integTracing.listNote')}</p>
      </section>
      {connected ? (
        <section aria-labelledby="stat-h" className={failing ? 'int-status failing' : 'int-status'}>
          <div className="row-wrap">
            <Heading level={3} data-size="xs" id="stat-h">
              {t('integTracing.statusFor', { tool: tool.name })}
            </Heading>
            <Tag data-color={failing ? 'danger' : 'success'}>
              {failing ? t('integrations.statusFailing') : t('integTracing.statusConnected')}
            </Tag>
          </div>
          <dl className="facts">
            {[
              [
                t('integTracing.lastDelivery'),
                failing ? t('integTracing.exampleLateTime') : t('integTracing.exampleTime'),
              ],
              [t('integTracing.sentLastDay'), t('integTracing.exampleTraces')],
              [t('integTracing.waiting'), failing ? t('integTracing.exampleWaiting') : '0'],
              [t('integTracing.sampling'), `${saved.rate} %`],
            ].map(([l, v]) => (
              <div key={l}>
                <dt>{l}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {failing ? (
            <Alert data-color="danger" data-size="sm">
              <p className="int-err-what">{t('integTracing.rejectsKey')}</p>
              <p className="int-err-why">{t('integTracing.rejectsKeyWhy')}</p>
              <div className="actions">
                <Button
                  variant="primary"
                  data-size="sm"
                  onClick={() => {
                    setSecrets({ ...secrets, sk: '' });
                    document.getElementById('f-sk')?.focus();
                    setFlash({ text: t('integTracing.pasteNewSecret'), color: 'info' });
                  }}
                >
                  {t('integTracing.replaceSecret')}
                </Button>
                <span className="int-code">
                  {t('integrations.technicalCode', { code: '401 Unauthorized' })}
                </span>
              </div>
            </Alert>
          ) : null}
          <div className="actions">
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={testing || undefined}
              onClick={() => {
                if (testing) return;
                setTesting(true);
                setTestMsg(t('integTracing.sendingTest'));
                setTestLink(false);
                timer.current = setTimeout(() => {
                  setTesting(false);
                  setTestMsg(
                    tRef.current(
                      failing ? 'integTracing.testRejected' : 'integTracing.testArrived',
                    ),
                  );
                  setTestLink(!failing);
                }, 1100);
              }}
            >
              {t('integTracing.sendTest')}
            </Button>
            <span role="status" className="row-wrap">
              {testing ? <Spinner aria-hidden data-size="xs" /> : null}
              {testMsg}
              {testLink ? (
                <a href="#/log">{t('integTracing.openTest', { tool: tool.name })}</a>
              ) : null}
            </span>
          </div>
        </section>
      ) : null}
      <section aria-labelledby="opps-h" className="int-form-plain">
        <Heading level={3} data-size="xs" id="opps-h">
          {connected
            ? t('integTracing.settings')
            : t('integTracing.connectTool', { tool: tool.name })}
        </Heading>
        {tried && Object.keys(errs).length ? (
          <ErrorSummary ref={summary} tabIndex={-1}>
            <ErrorSummary.Heading>{t('integTracing.fixBeforeSave')}</ErrorSummary.Heading>
            <ErrorSummary.List>
              {Object.entries(errs).map(([k, text]) => (
                <ErrorSummary.Item key={k}>
                  <ErrorSummary.Link
                    href={k === 'scope' ? '#scope-err' : k === 'rate' ? '#utvalg' : `#f-${k}`}
                  >
                    {text}
                  </ErrorSummary.Link>
                </ErrorSummary.Item>
              ))}
            </ErrorSummary.List>
          </ErrorSummary>
        ) : null}
        {tool.fields.map(([k, label, type, ph, help]) => {
          const isStored = type === 'secret' && draft.stored && !secrets[k];
          return (
            <div key={k} className="int-field-lg stack-xs">
              <Textfield
                id={`f-${k}`}
                label={t(label)}
                description={
                  <>
                    {help ? t(help) : null}
                    {isStored ? (
                      <span className="int-stored">
                        <Icon d={lock} size={18} />
                        {t('integTracing.storedInVault')}
                      </span>
                    ) : null}
                  </>
                }
                type={type === 'secret' ? 'password' : type === 'url' ? 'url' : 'text'}
                autoComplete="off"
                placeholder={
                  type === 'secret' && draft.stored ? t('integTracing.pasteToReplace') : ph
                }
                value={type === 'secret' ? (secrets[k] ?? '') : (draft.values[k] ?? '')}
                error={shown[k]}
                onChange={(e) =>
                  type === 'secret'
                    ? setSecrets({ ...secrets, [k]: e.target.value })
                    : set({ values: { ...draft.values, [k]: e.target.value } })
                }
              />
            </div>
          );
        })}
        <Fieldset>
          <Fieldset.Legend>{t('integTracing.whereHosted', { tool: tool.name })}</Fieldset.Legend>
          <div className="tag-row">
            {(
              [
                ['norge', t('integTracing.locNorway')],
                ['eu', t('integTracing.locEea')],
                ['utenfor', t('integTracing.locOutside')],
              ] as const
            ).map(([k, l]) => (
              <Chip.Radio
                key={k}
                name="vertskap"
                checked={draft.loc === k}
                onChange={() => set({ loc: k })}
              >
                {l}
              </Chip.Radio>
            ))}
          </div>
          {draft.loc === 'utenfor' ? (
            <Alert data-color="warning" data-size="sm">
              {t('integTracing.outsideWarning')}
            </Alert>
          ) : null}
        </Fieldset>
        <Fieldset>
          <Fieldset.Legend>{t('integTracing.sendingServices')}</Fieldset.Legend>
          {traceServices.map(([name, risk]) => (
            <Checkbox
              key={name}
              label={name}
              description={t(risk)}
              checked={draft.scope.includes(name)}
              onChange={() =>
                set({
                  scope: draft.scope.includes(name)
                    ? draft.scope.filter((x) => x !== name)
                    : [...draft.scope, name],
                })
              }
            />
          ))}
          {shown.scope ? <ValidationMessage id="scope-err">{shown.scope}</ValidationMessage> : null}
        </Fieldset>
        <Fieldset>
          <Fieldset.Legend>{t('integTracing.whatIsSent')}</Fieldset.Legend>
          <Radio
            name="innhold"
            label={t('integTracing.metaOnly')}
            description={t('integTracing.metaOnlyHelp')}
            checked={draft.content === 'meta'}
            onChange={() => set({ content: 'meta' })}
          />
          <Radio
            name="innhold"
            label={t('integTracing.fullContent')}
            description={t('integTracing.fullContentHelp')}
            checked={draft.content === 'full'}
            onChange={() => set({ content: 'full' })}
          />
        </Fieldset>
        <Switch
          label={t('integTracing.mask')}
          description={t('integTracing.maskHelp')}
          checked={draft.mask}
          onChange={() => set({ mask: !draft.mask })}
        />
        {maskWarn ? (
          <Alert data-color="warning" data-size="sm">
            {maskWarn}
          </Alert>
        ) : null}
        <Textfield
          id="utvalg"
          className="int-field-sm"
          label={t('integTracing.share')}
          description={t('integTracing.shareHelp')}
          inputMode="numeric"
          value={draft.rate}
          error={shown.rate}
          onChange={(e) => set({ rate: e.target.value })}
        />
        <Fieldset>
          <Fieldset.Legend>{t('integTracing.sync')}</Fieldset.Legend>
          <Switch
            label={t('integTracing.syncScores')}
            description={t('integTracing.syncScoresHelp', { tool: tool.name })}
            checked={draft.syncScores}
            onChange={() => set({ syncScores: !draft.syncScores })}
          />
          <Switch
            label={t('integTracing.annotations')}
            description={t('integTracing.annotationsHelp', { tool: tool.name })}
            checked={draft.annotations}
            onChange={() => set({ annotations: !draft.annotations })}
          />
        </Fieldset>
        <div className="actions">
          <Button variant="primary" onClick={save}>
            {connected ? t('common.save') : t('integrations.connect')}
          </Button>
          {connected ? (
            <Button
              variant="tertiary"
              data-color="danger"
              onClick={() => {
                setConns(Object.fromEntries(Object.entries(conns).filter(([k]) => k !== toolId)));
                setDraft(blank());
                setFlash({
                  text: t('integTracing.disconnected', { tool: tool.name }),
                  color: 'info',
                });
              }}
            >
              {t('integrations.disconnect')}
            </Button>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="tl-h" className="stack-sm">
        <Heading level={3} data-size="xs" id="tl-h">
          {t('integTracing.timelineExample')}
        </Heading>
        <div className="int-tl-example">
          <div className="row-wrap">
            <span className="int-tl-title">Rapportassistenten</span>
            <Tag data-size="sm" data-color="success">
              {t('taskStatus.completed')}
            </Tag>
          </div>
          <span className="meta">{t('integTracing.exampleRunMeta', { tenant: tenantName })}</span>
          {[
            [t('integTracing.exampleSentOwn', { tenant: tenantName }), t('integTracing.openOwn')],
            [t('integTracing.exampleSentDigdir'), t('integTracing.openDigdir')],
          ].map(([note, link]) => (
            <span key={link} className="row-wrap small">
              <Icon d={pulse} size={16} />
              {note}
              <a href="#/log">{link}</a>
            </span>
          ))}
        </div>
        <Paragraph data-size="sm" className="meta">
          {t('integTracing.linkNote')}
        </Paragraph>
      </section>
    </div>
  );
};
