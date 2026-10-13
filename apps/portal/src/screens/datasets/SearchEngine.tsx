import { Alert, Button, Heading, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import type { DatasetEngine, SearchEngineInfo } from '../../api/search-engines';
import { ApiCallLink } from '../../components/ApiCall';
import { DataLocationTag } from '../../components/DataLocationTag';
import { NotDecided } from '../../components/NotDecided';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import { datasetEnginePath, engineCapabilities, seconds } from '../../data/search-engines';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { EngineSwitch } from './EngineSwitch';
import './search-engine.css';

interface Props {
  api: ApiClient;
  tenant: string;
  datasetId: string;
  datasetName: string;
  tenantName: string;
  docs: string;
  chunks: string;
  canEdit: boolean;
}

const openStates = new Set(['running', 'failed', 'comparing', 'ready']);

const EngineFacts = ({ view }: { view: DatasetEngine }) => {
  const t = useT();
  const f = useFormat();
  const e = view.engine;
  return (
    <dl className="engine-facts">
      <dt>{t('searchEngine.factEngine')}</dt>
      <dd className="engine-name">
        {e.title}
        {e.tech ? <span className="engine-tech"> · {e.tech}</span> : null}
      </dd>
      <dt>{t('searchEngine.factRunsAt')}</dt>
      <dd className="tag-row">
        {e.runsAt ?? e.tech ?? e.title}
        {e.dataLocation ? <DataLocationTag location={e.dataLocation} /> : null}
      </dd>
      <dt>{t('searchEngine.factEmbedding')}</dt>
      <dd className="tag-row">
        {e.embeddingModel ? e.embeddingModel.name : t('searchEngine.noVectors')}
        {e.embeddingModel?.dataLocation ? (
          <DataLocationTag location={e.embeddingModel.dataLocation} />
        ) : null}
      </dd>
      <dt>{t('searchEngine.factSearchTime')}</dt>
      <dd>
        {view.searchTimeMs !== undefined
          ? t('searchEngine.searchTimeAverage', { time: seconds(t, f, view.searchTimeMs) })
          : t('searchEngine.noSearches')}
      </dd>
    </dl>
  );
};

export const EngineCapabilities = ({ engine }: { engine: SearchEngineInfo }) => {
  const t = useT();
  const can = engineCapabilities.filter((c) => c.has(engine.capabilities));
  const cannot = engineCapabilities.filter((c) => !c.has(engine.capabilities));
  return (
    <div className="engine-caps">
      <div className="stack-xs">
        <h3 className="engine-sub">{t('searchEngine.canHeading')}</h3>
        <ul className="engine-cap-list" aria-label={t('searchEngine.canHeading')}>
          {can.map((c) => (
            <li key={c.id}>
              <Tag data-size="sm" data-color="success">
                {t('searchEngine.canTag')}
              </Tag>
              <span>
                <strong>{t(c.name)}</strong>
                <span className="engine-cap-text subtle">{t(c.can)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="stack-xs">
        <h3 className="engine-sub">{t('searchEngine.cannotHeading')}</h3>
        {cannot.length === 0 ? (
          <p className="engine-p">{t('searchEngine.canEverything')}</p>
        ) : (
          <ul className="engine-cap-list" aria-label={t('searchEngine.cannotHeading')}>
            {cannot.map((c) => (
              <li key={c.id}>
                <Tag data-size="sm" data-color="warning">
                  {t('searchEngine.cannotTag')}
                </Tag>
                <span>
                  <strong>{t(c.name)}</strong>
                  <span className="engine-cap-text">{t(c.consequence)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const Loaded = ({
  api,
  tenant,
  datasetId,
  datasetName,
  tenantName,
  docs,
  chunks,
  canEdit,
  initial,
  engines,
}: Props & { initial: DatasetEngine; engines: SearchEngineInfo[] }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [view, setView] = useState(initial);
  const editable = canEdit && view.canSwitch;
  const [switching, setSwitching] = useState(
    Boolean(initial.switch && openStates.has(initial.switch.state)),
  );
  const [flash, setFlash] = useState('');
  const [failedTo, setFailedTo] = useState('');
  const [backOpen, setBackOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const refresh = async () => {
    const next = await api.searchEngines.datasetEngine(tenant, datasetId);
    setView(next);
    return next;
  };

  const startSwitch = () => {
    setFlash('');
    setFailedTo('');
    setSwitching(true);
  };

  const goBack = async () => {
    setTried(true);
    const previous = view.previous;
    if (!previous || reasonProblem(reason, t)) return;
    setBusy(true);
    setProblem('');
    try {
      await api.searchEngines.rollbackSwitch(tenant, datasetId, previous.switchId, reason.trim());
      await refresh();
      setBackOpen(false);
      setReason('');
      setTried(false);
      setFlash(
        tRef.current('searchEngine.backDone', { dataset: datasetName, engine: previous.title }),
      );
    } catch {
      setProblem(tRef.current('searchEngine.backFailed'));
    } finally {
      setBusy(false);
    }
  };

  const flashBox = (
    <div aria-live="polite">
      {flash ? (
        <Alert data-color="success" data-size="sm">
          {flash}
        </Alert>
      ) : null}
    </div>
  );

  if (switching)
    return (
      <div className="engine-wrap">
        {flashBox}
        <EngineSwitch
          api={api}
          tenant={tenant}
          datasetId={datasetId}
          datasetName={datasetName}
          tenantName={tenantName}
          docs={docs}
          chunks={chunks}
          current={view}
          engines={engines}
          {...(view.switch && openStates.has(view.switch.state) ? { initial: view.switch } : {})}
          onClose={(outcome) => {
            setSwitching(false);
            if (outcome.kind === 'cancelled')
              setFlash(
                t('searchEngine.switchCancelled', {
                  dataset: datasetName,
                  engine: view.engine.title,
                }),
              );
            if (outcome.kind === 'failed') setFailedTo(outcome.target);
            if (outcome.kind === 'activated')
              setFlash(
                t('searchEngine.switchActivated', {
                  dataset: datasetName,
                  target: outcome.target,
                  engine: view.engine.title,
                }),
              );
            void refresh().catch(() => undefined);
          }}
        />
      </div>
    );

  const e = view.engine;
  const hasOther = engines.some((x) => x.id !== e.id);
  return (
    <div className="engine-wrap">
      {flashBox}
      <section aria-labelledby="motor-h" className="engine-block">
        <div className="engine-head">
          <div className="stack-xs">
            <h2 id="motor-h" className="card-title">
              {t('searchEngine.heading')}
            </h2>
            <span className="engine-intro subtle">{t('searchEngine.intro')}</span>
          </div>
          <div className="actions">
            <ApiCallLink
              call={{
                action: t('searchEngine.apiAction', { dataset: datasetName }),
                method: 'GET',
                path: `${datasetEnginePath(tenant, datasetId)}/engine`,
                right: t('rights.useServices'),
              }}
            />
            {editable && hasOther ? (
              <Button variant="secondary" data-size="sm" onClick={startSwitch}>
                {t('searchEngine.switchEngine')}
              </Button>
            ) : (
              <Tag data-size="sm" data-color="success">
                {e.title}
              </Tag>
            )}
          </div>
        </div>

        {editable && !hasOther ? (
          <div className="stack-xs">
            <p className="engine-p">
              {t(e.builtin ? 'searchEngine.usesBuiltin' : 'searchEngine.uses', {
                dataset: datasetName,
                engine: e.title,
              })}
            </p>
            <Alert data-color="info" data-size="sm">
              <p className="alert-text">
                {t('searchEngine.noOther', { tenant: tenantName, engine: e.title })}
              </p>
            </Alert>
            <a className="ds-link" href="#/contact">
              {t('searchEngine.askMore')}
            </a>
          </div>
        ) : null}

        {failedTo ? (
          <Alert data-color="danger">
            <Heading level={3} data-size="2xs">
              {t('searchEngine.failedHeading', { target: failedTo })}
            </Heading>
            <p className="alert-text">{t('searchEngine.failedText', { engine: e.title })}</p>
            {editable && hasOther ? (
              <Button variant="secondary" data-size="sm" onClick={startSwitch}>
                {t('searchEngine.retrySwitch')}
              </Button>
            ) : null}
          </Alert>
        ) : null}

        <EngineFacts view={view} />
        <EngineCapabilities engine={e} />

        <div className="stack-xs">
          <h3 className="engine-sub">{t('searchEngine.usedHeading')}</h3>
          {view.usedBy.length ? (
            <ul className="engine-used" aria-label={t('searchEngine.usedHeading')}>
              {view.usedBy.map((u) => (
                <li key={u.id}>
                  <a className="ds-link" href={`#/services/${encodeURIComponent(u.id)}`}>
                    {u.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="engine-p subtle">{t('searchEngine.usedNone')}</p>
          )}
        </div>

        {view.previous ? (
          <div className="engine-previous">
            <p className="engine-p">
              {t.rich('searchEngine.previousKept', {
                engine: view.previous.title,
                days: view.retentionDays,
                undecided: () => <NotDecided />,
              })}
            </p>
            {editable && !backOpen ? (
              <Button
                variant="secondary"
                data-size="sm"
                className="align-start"
                onClick={() => {
                  setBackOpen(true);
                  setReason('');
                  setTried(false);
                }}
              >
                {t('searchEngine.goBackTo', { engine: view.previous.title })}
              </Button>
            ) : null}
            {backOpen ? (
              <div className="stack-sm engine-reason">
                <ReasonField value={reason} onChange={setReason} showError={tried} />
                {problem ? (
                  <Alert data-color="danger" data-size="sm">
                    {problem}
                  </Alert>
                ) : null}
                <div className="actions">
                  <Button
                    variant="primary"
                    data-size="sm"
                    loading={busy}
                    onClick={() => void goBack()}
                  >
                    {t('searchEngine.goBack')}
                  </Button>
                  <Button variant="secondary" data-size="sm" onClick={() => setBackOpen(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};

export const SearchEngine = (props: Props) => {
  const t = useT();
  const { api, tenant, datasetId } = props;
  const [state, retry] = useAsync(
    (signal) =>
      Promise.all([
        api.searchEngines.datasetEngine(tenant, datasetId, signal),
        api.searchEngines.engines(tenant, signal),
      ]),
    [api, tenant, datasetId],
  );
  if (state.status === 'loading') return <Loading label={t('searchEngine.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const [initial, engines] = state.data;
  return <Loaded {...props} initial={initial} engines={engines} />;
};
