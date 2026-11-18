import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Spinner,
  Tabs,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import {
  isOpen,
  skippedCount,
  skippedOf,
  type DatasetDeleteResult,
  type DatasetDetailView,
  type ExecutionView,
  type ExecutionsView,
} from '../../api/datasets';
import { BackLink } from '../../components/BackLink';
import { prefetchSignal } from '../../api/cache';
import { statusColors, statusKeys, type DatasetStatus } from '../../data/datasets';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { ErrorState, Loading, PageLoading } from '../../states';
import { admissionRunsOutSoon } from './admission';
import { backoffDelay } from './backoff';
import { DeleteDataset, LeaveDialog, SourceSettings, Technical } from './DatasetSettings';
import { CancelDialog, Run, RunTable, scheduleLine, Skipped } from './Ingestions';
import { Content } from './Content';
import {
  refusalText,
  countText,
  datasetStatus,
  isOwnEndpoint,
  ownEndpointText,
  runDatasetStatus,
  externalSourceText,
  scheduleText,
  isForeign,
  sharedSourceText,
  sourceText,
  failureText,
  lastSucceeded,
  uploadAccept,
} from './live-model';
import { datasetTabPath, type DetailTab } from './model';
import { SearchEngine } from './SearchEngine';
import { UsedBy } from './UsedBy';
import { Uploads } from './Uploads';
import './search-engine.css';

export const pollMs = 1500;

const Deleted = ({ name, result }: { name: string; result: DatasetDeleteResult }) => {
  const t = useT();
  const f = useFormat();
  const endpoint = result.removed.endpoint
    ? t(result.removed.secret ? 'datasets.deletedEndpointAndKey' : 'datasets.deletedEndpoint', {
        endpoint: result.removed.endpoint,
      })
    : '';
  const kept = result.kept.knowledgeRecords
    ? t('datasets.deletedKeptRecords')
    : result.kept.generations.length
      ? t('datasets.deletedKeptGenerations', {
          count: result.kept.generations.length,
          list: result.kept.generations.join(', '),
        })
      : t('datasets.deletedNothingKept');
  return (
    <div className="stack dataset-page">
      <BackLink label={t('datasets.title')} href="#/datasets" />
      <Heading level={1} data-size="md">
        {t('datasets.deletedTitle', { name })}
      </Heading>
      <Alert data-color={result.kept.generations.length ? 'warning' : 'success'}>
        <p className="alert-text">
          {t('datasets.deletedRemoved', {
            pipelines: f.number(result.removed.pipelines.length),
            uploads: f.number(result.removed.uploads.length),
            generations: f.number(result.removed.generations.length),
          })}
          {endpoint ? ` ${endpoint}` : ''}
        </p>
        <p className="alert-text">{kept}</p>
      </Alert>
      <Paragraph>
        <a href="#/datasets">{t('datasets.goToDatasets')}</a>
      </Paragraph>
    </div>
  );
};

export const LiveDatasetDetail = ({
  api,
  tenant,
  tenantName,
  id,
  tab,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  id: string;
  tab: DetailTab;
}) => {
  const t = useT();
  const [detail, retryDetail] = useAsync(
    (signal) => api.datasets.get(tenant, id, signal),
    [api, tenant, id],
  );
  if (detail.status === 'loading')
    return (
      <div className="stack">
        <BackLink label={t('datasets.title')} href="#/datasets" />
        <PageLoading label={t('datasets.loadingOne')} shape="detail" onRetry={retryDetail} />
      </div>
    );
  if (detail.status === 'error')
    return detail.error instanceof ApiError && detail.error.status === 404 ? (
      <>
        <Heading level={1} data-size="lg">
          {t('datasets.notFound')}
        </Heading>
        <Paragraph>
          {t('datasets.notFoundText')} <a href="#/datasets">{t('datasets.goToDatasets')}</a>
        </Paragraph>
      </>
    ) : (
      <>
        <Heading level={1} data-size="lg">
          {t('datasets.title')}
        </Heading>
        <ErrorState error={detail.error} onRetry={retryDetail} />
      </>
    );
  return (
    <Loaded
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      initial={detail.data}
      tab={tab === 'filters' ? 'content' : tab}
      onTab={(next) => navigate(datasetTabPath(id, next))}
    />
  );
};

const Loaded = ({
  api,
  tenant,
  tenantName,
  initial,
  tab,
  onTab,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  initial: DatasetDetailView;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [view, setView] = useState(initial);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [openRun, setOpenRun] = useState<string>();
  const [runs, setRuns] = useState<ExecutionsView>();
  const [runsError, setRunsError] = useState<unknown>();
  const [pollFailures, setPollFailures] = useState(0);
  const [flash, setFlash] = useState('');
  const [failure, setFailure] = useState('');
  const [finished, setFinished] = useState<ExecutionView>();
  const [deleted, setDeleted] = useState<DatasetDeleteResult>();
  const [askCancel, setAskCancel] = useState<ExecutionView>();
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<string>();
  const [formKey, setFormKey] = useState(0);
  const onDirty = useCallback((next: boolean) => setDirty(next), []);
  const watching = useRef(isOpen(initial.lastExecution));
  const rights = useRights();
  const editable = view.editable !== false;
  const canEdit = editable && rights.has('manage-datasets');
  const [pipelines, retryPipelines] = useAsync(
    (signal) => (editable ? api.datasets.pipelines(tenant, view.id, signal) : Promise.resolve([])),
    [api, tenant, view.id, editable],
  );
  const pipeline = pipelines.status === 'ready' ? pipelines.data[0] : undefined;
  const ownEndpoint = isOwnEndpoint(view);
  const [engine] = useAsync(
    (signal) =>
      ownEndpoint
        ? api.searchEngines.datasetEngine(tenant, view.fullId, signal)
        : Promise.resolve(undefined),
    [api, tenant, view.fullId, ownEndpoint],
  );
  const endpointHost =
    engine.status === 'ready' && engine.data?.engine.engine === 'http-search'
      ? engine.data.engine.runsAt
      : undefined;

  useEffect(() => {
    if (initial.source === 'upload' && initial.editable !== false)
      void api.datasets.uploads(tenant, initial.id, prefetchSignal()).catch(() => undefined);
  }, [api, tenant, initial.id, initial.source, initial.editable]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      if (!link || event.defaultPrevented) return;
      event.preventDefault();
      setLeaving(link.getAttribute('href') ?? undefined);
    };
    document.addEventListener('click', guard, true);
    return () => document.removeEventListener('click', guard, true);
  }, [dirty]);

  const changeTab = (next: DetailTab) => {
    if (next === tab) return;
    if (dirty) setLeaving(`#${datasetTabPath(view.fullId, next)}`);
    else onTab(next);
  };

  const refresh = useCallback(async () => {
    if (!pipeline) return;
    const next = await api.datasets.executions(tenant, view.id, pipeline.id);
    setRuns(next);
    const latest = next.data[0];
    if (latest && !isOpen(latest) && watching.current) {
      watching.current = false;
      setFinished(latest);
      setOpenRun(latest.id);
      setView(await api.datasets.get(tenant, view.id));
    }
    if (isOpen(latest)) watching.current = true;
  }, [api, tenant, view.id, pipeline]);

  const load = useCallback(async () => {
    try {
      await refresh();
      setRunsError(undefined);
      setPollFailures(0);
    } catch (error) {
      setRunsError(error);
      setPollFailures((n) => n + 1);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = isOpen(runs?.data[0]);
  const polling = running || (runsError !== undefined && watching.current);
  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => void load(), backoffDelay(pollMs, pollFailures));
    return () => clearTimeout(timer);
  }, [polling, load, pollFailures, runs]);

  const run = async (before?: () => Promise<unknown>) => {
    if (!pipeline || running) return;
    setFailure('');
    setFlash('');
    setFinished(undefined);
    try {
      await before?.();
      await api.datasets.execute(tenant, view.id, pipeline.id, tRef.current('datasets.runReason'));
      watching.current = true;
      await load();
    } catch (error) {
      setFailure(
        error instanceof ApiError &&
          error.status === 409 &&
          error.problem?.errors?.some((e) => e.path === 'backend')
          ? `${tRef.current('config.writeKeyNotice')}. ${failureText(tRef.current, error)}`
          : failureText(tRef.current, error),
      );
    }
  };

  const uploadAndRun = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    try {
      await run(async () => {
        const result = await api.datasets.upload(
          tenant,
          view.id,
          files,
          tRef.current('datasets.uploadReason', { name: view.name }),
        );
        if (result.uploaded.length === 0) throw new Error(tRef.current('datasets.noneUploaded'));
      });
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  const cancel = async (execution: ExecutionView) => {
    setAskCancel(undefined);
    if (!pipeline) return;
    setFailure('');
    setFlash('');
    try {
      await api.datasets.cancelExecution(
        tenant,
        view.id,
        pipeline.id,
        execution.id,
        tRef.current('datasets.cancelReason'),
      );
      setFlash(tRef.current('datasets.ingestionCancelled'));
      await load();
    } catch (error) {
      setFailure(failureText(tRef.current, error));
    }
  };

  // The open run whose admission runs out first; the list starts with the newest, often a queued one.
  const admitted = runs?.data
    .filter(
      (r) =>
        (r.status === 'queued' || r.status === 'running') &&
        r.admissionRunsOutAt &&
        !r.cancelRequestedAt,
    )
    .sort((a, b) => (a.admissionRunsOutAt ?? '').localeCompare(b.admissionRunsOutAt ?? ''))[0];
  const runsOut = admitted?.admissionRunsOutAt;
  const [readmitting, setReadmitting] = useState(false);
  const [readmitFailure, setReadmitFailure] = useState('');

  const readmit = async () => {
    if (!pipeline || !admitted || readmitting) return;
    setReadmitFailure('');
    setReadmitting(true);
    try {
      await api.datasets.readmitExecution(
        tenant,
        view.id,
        pipeline.id,
        admitted.id,
        tRef.current('datasets.readmitReason'),
      );
      await load();
    } catch (error) {
      setReadmitFailure(refusalText(tRef.current, error));
    } finally {
      setReadmitting(false);
    }
  };

  const latest = runs?.data[0];
  const status: DatasetStatus =
    view.state !== 'external' && latest
      ? runDatasetStatus({ status: latest.status, skipped: skippedCount(latest) })
      : datasetStatus(view);
  const nextRun = runs?.nextRunAt !== undefined ? runs.nextRunAt : view.nextRunAt;
  const failedRun = latest?.status === 'failed' ? latest : undefined;
  const skippedNow = finished
    ? skippedOf(finished).length
      ? skippedOf(finished)
      : (view.skipped ?? [])
    : [];
  const lastStarted = latest?.startedAt ?? view.lastExecution?.startedAt;
  const lastOk = lastSucceeded(runs?.data ?? []);
  const meta = [
    sharedSourceText(t, view, endpointHost),
    ...(isForeign(view)
      ? []
      : [
          ownEndpoint
            ? t('datasets.lastEndpoint')
            : view.state === 'external'
              ? t('datasets.lastExternal')
              : failedRun && lastOk
                ? t('datasets.metaLastOk', { when: f.dateTime(lastOk.startedAt) })
                : lastStarted
                  ? t('datasets.metaLast', { when: f.dateTime(lastStarted) })
                  : t('datasets.metaNotYet'),
        ]),
    ...(view.documents !== null ? [t('datasets.metaDocuments', { count: view.documents })] : []),
  ].join(' · ');

  if (deleted) return <Deleted name={view.name} result={deleted} />;
  return (
    <div className="stack dataset-page">
      <BackLink label={t('datasets.title')} href="#/datasets" />
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="md">
              {view.name}
            </Heading>
            <Tag data-color={statusColors[status]}>{t(statusKeys[status])}</Tag>
          </div>
          <p className="lead">{meta}</p>
        </div>
        {canEdit && pipeline ? (
          <div className="actions">
            <Button
              variant="secondary"
              aria-disabled={running || uploading || undefined}
              onClick={() => void run()}
            >
              {t('datasets.runNow')}
            </Button>
            {view.source === 'upload' ? (
              <>
                <Button
                  variant="primary"
                  aria-disabled={running || uploading || undefined}
                  onClick={() => !running && !uploading && uploadInput.current?.click()}
                >
                  {uploading ? t('datasets.uploadingFiles') : t('datasets.uploadFiles')}
                </Button>
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  hidden
                  accept={uploadAccept}
                  aria-label={t('datasets.chooseFilesToUpload')}
                  onChange={(e) => void uploadAndRun([...(e.currentTarget.files ?? [])])}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div aria-live="polite" className="stack-sm">
        {failedRun ? (
          <Alert data-color="danger">
            <Heading level={2} data-size="2xs">
              {t('datasets.failedAt', { when: f.dateTime(failedRun.startedAt) })}
            </Heading>
            <p className="alert-text">
              {failedRun.error
                ? `${t('datasets.failedCause', { message: failedRun.error.replace(/[.\s]*$/, '.') })} `
                : ''}
              {lastOk
                ? t('datasets.servicesUseFrom', { when: f.date(lastOk.startedAt) })
                : t('datasets.nothingChanged')}
              {pipeline?.spec.source.kind === 'website'
                ? ` ${t('datasets.failedWebsiteHelp')}`
                : ''}
            </p>
            {canEdit && pipeline ? (
              <div className="row-wrap">
                <Button variant="secondary" data-size="sm" onClick={() => void run()}>
                  {t('common.tryAgain')}
                </Button>
                {pipeline.spec.source.kind === 'website' ? (
                  <a href={`#${datasetTabPath(view.fullId, 'source')}`}>
                    {t('datasets.changeAddress')}
                  </a>
                ) : null}
              </div>
            ) : null}
          </Alert>
        ) : null}
        {running ? (
          <Alert data-color={latest?.status === 'waiting' ? 'warning' : 'info'} data-size="sm">
            <span role="status" className="row-wrap">
              {latest?.status === 'waiting' ? null : <Spinner aria-hidden="true" data-size="xs" />}
              {t(
                latest?.status === 'queued'
                  ? 'datasets.queuedLeave'
                  : latest?.status === 'waiting'
                    ? 'datasets.waitingLeave'
                    : 'datasets.runningLeave',
              )}
            </span>
          </Alert>
        ) : null}
        {runsOut ? (
          <div className="stack-xs">
            {admissionRunsOutSoon(runsOut) ? (
              <Alert data-color="warning" data-size="sm">
                {t('datasets.admissionSoon', { time: f.dateTime(runsOut) })}
              </Alert>
            ) : (
              <p className="meta">{t('datasets.admission', { time: f.dateTime(runsOut) })}</p>
            )}
            {canEdit ? (
              <Button
                variant="secondary"
                data-size="sm"
                className="align-start"
                loading={readmitting}
                onClick={() => void readmit()}
              >
                {t('datasets.readmit')}
              </Button>
            ) : null}
            {readmitFailure ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {t('datasets.readmitFailed', { problem: readmitFailure })}
              </Alert>
            ) : null}
          </div>
        ) : null}
        {finished?.status === 'succeeded' ? (
          <Alert data-color={skippedNow.length ? 'warning' : 'success'}>
            <Heading level={2} data-size="2xs">
              {t('datasets.ingestionDone')}
            </Heading>
            <p className="alert-text">
              {t('datasets.storedDocuments', { amount: f.number(finished.report?.stored ?? 0) })}{' '}
              {skippedNow.length
                ? t('datasets.someSkipped', { amount: f.number(skippedNow.length) })
                : t('datasets.noneSkippedShort')}
            </p>
            {skippedNow.length ? <Skipped list={skippedNow} /> : null}
          </Alert>
        ) : null}
        {failure ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('datasets.couldNotStart', { problem: failure })}
          </Alert>
        ) : null}
        {flash ? (
          <Alert data-color="success" data-size="sm" role="status">
            {flash}
          </Alert>
        ) : null}
      </div>

      <Tabs value={tab} onChange={(v) => changeTab(v as DetailTab)}>
        <Tabs.List aria-label={t('datasets.tabsLabel')}>
          <Tabs.Tab value="content">{t('datasets.tabContent')}</Tabs.Tab>
          <Tabs.Tab value="ingestions">{t('datasets.tabIngestions')}</Tabs.Tab>
          <Tabs.Tab value="used-by">{t('datasets.tabUsedBy')}</Tabs.Tab>
          <Tabs.Tab value="source">{t('datasets.tabSource')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="content">
          {tab === 'content' ? (
            <Content
              api={api}
              tenant={tenant}
              view={view}
              canUpload={canEdit && view.source === 'upload' && !!pipeline}
              onUpload={() => uploadInput.current?.click()}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="ingestions">
          {ownEndpoint ? (
            <p className="meta">{t('datasets.endpointIngestions')}</p>
          ) : !editable ? (
            <p className="meta">
              {view.state === 'external'
                ? t('datasets.externalIngestions')
                : t('datasets.sharedIngestions')}
            </p>
          ) : pipelines.status === 'error' ? (
            <ErrorState error={pipelines.error} onRetry={retryPipelines} headingLevel={3} />
          ) : runsError !== undefined && !runs ? (
            <ErrorState error={runsError} onRetry={() => void load()} headingLevel={3} />
          ) : pipelines.status === 'loading' || (pipeline && !runs) ? (
            <Loading label={t('datasets.loadingRuns')} shape="list" onRetry={retryPipelines} />
          ) : (
            <section className="stack-sm" aria-labelledby="runs-h">
              <Heading level={2} data-size="xs" id="runs-h">
                {t('datasets.tabIngestions')}
              </Heading>
              {pipeline ? (
                <Paragraph data-size="sm">{scheduleLine(t, f, pipeline, nextRun)}</Paragraph>
              ) : null}
              {!runs || runs.data.length === 0 ? (
                <p className="meta">{t('datasets.noIngestions')}</p>
              ) : (
                <>
                  {runsError !== undefined ? (
                    <Alert data-color="warning" data-size="sm">
                      <Paragraph data-size="sm">
                        {polling ? t('datasets.runsRetrying') : t('datasets.runsStale')}
                      </Paragraph>
                      {polling ? null : (
                        <Button variant="secondary" data-size="sm" onClick={() => void load()}>
                          {t('common.tryAgain')}
                        </Button>
                      )}
                    </Alert>
                  ) : null}
                  {pipeline?.spec.source.kind === 'website' ? (
                    <RunTable
                      runs={runs.data}
                      {...(canEdit ? { onCancel: (r: ExecutionView) => setAskCancel(r) } : {})}
                    />
                  ) : (
                    <ol className="runs" aria-label={t('datasets.tabIngestions')}>
                      {runs.data.map((r) => (
                        <Run
                          key={r.id}
                          run={r}
                          open={openRun === r.id}
                          onToggle={() => setOpenRun(openRun === r.id ? undefined : r.id)}
                          {...(canEdit && isOpen(r) ? { onCancel: () => setAskCancel(r) } : {})}
                        />
                      ))}
                    </ol>
                  )}
                </>
              )}
            </section>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="used-by">
          <UsedBy
            api={api}
            tenant={tenant}
            readers={view.usedBy ?? []}
            documents={countText(t, f, view.documents)}
          />
        </Tabs.Panel>
        <Tabs.Panel value="source">
          {canEdit && pipelines.status === 'loading' ? (
            <Loading label={t('datasets.loadingOne')} shape="form" onRetry={retryPipelines} />
          ) : canEdit ? (
            <SourceSettings
              key={`${view.name}-${pipeline?.version ?? 0}-${formKey}`}
              api={api}
              tenant={tenant}
              tenantName={tenantName}
              view={view}
              pipeline={pipeline}
              onDirty={onDirty}
              onSaved={(text) => {
                setFlash(text);
                retryPipelines();
                void api.datasets.get(tenant, view.id).then(setView, () => undefined);
              }}
            >
              {view.source === 'upload' ? (
                <Uploads
                  api={api}
                  tenant={tenant}
                  dataset={view.id}
                  datasetName={view.name}
                  canEdit={canEdit}
                  onUploaded={() => setFlash(t('datasets.filesUploaded'))}
                />
              ) : null}
            </SourceSettings>
          ) : (
            <div className="stack">
              <section aria-labelledby="kilde-h" className="source-card">
                <h2 id="kilde-h" className="card-title">
                  {t('datasets.factSource')}
                </h2>
                <dl className="source-dl">
                  <div>
                    <dt>{t('datasets.factSource')}</dt>
                    <dd>
                      {ownEndpoint
                        ? ownEndpointText(t, endpointHost)
                        : view.state === 'external'
                          ? externalSourceText(t, view)
                          : isForeign(view)
                            ? t('datasets.unknown')
                            : t(sourceText[view.source])}
                    </dd>
                  </div>
                  {pipeline ? (
                    <div>
                      <dt>{t('datasets.update')}</dt>
                      <dd>{t(scheduleText[pipeline.spec.schedule] ?? scheduleText.none)}</dd>
                    </div>
                  ) : null}
                </dl>
                {!editable ? (
                  <Alert data-color="info" data-size="sm">
                    {view.state === 'external'
                      ? t('datasets.externalWithYou')
                      : t('datasets.sharedWithYou')}
                  </Alert>
                ) : null}
              </section>
              {view.source === 'upload' ? (
                <Uploads
                  api={api}
                  tenant={tenant}
                  dataset={view.id}
                  datasetName={view.name}
                  canEdit={false}
                  onUploaded={() => undefined}
                />
              ) : null}
            </div>
          )}
          <div className="stack dataset-settings-after">
            <Technical view={view}>
              {(open) =>
                open ? (
                  <SearchEngine
                    api={api}
                    tenant={tenant}
                    tenantName={tenantName}
                    datasetId={view.fullId}
                    datasetName={view.name}
                    docs={countText(t, f, view.documents)}
                    chunks={countText(t, f, view.chunks)}
                    canEdit={canEdit}
                  />
                ) : null
              }
            </Technical>
            {canEdit ? (
              <DeleteDataset api={api} tenant={tenant} view={view} onDeleted={setDeleted} />
            ) : null}
          </div>
        </Tabs.Panel>
      </Tabs>
      {askCancel ? (
        <CancelDialog
          run={askCancel}
          onKeep={() => setAskCancel(undefined)}
          onCancel={() => void cancel(askCancel)}
        />
      ) : null}
      {leaving ? (
        <LeaveDialog
          onStay={() => setLeaving(undefined)}
          onLeave={() => {
            const target = leaving;
            setLeaving(undefined);
            setDirty(false);
            setFormKey((k) => k + 1);
            window.location.hash = target;
          }}
        />
      ) : null}
    </div>
  );
};
