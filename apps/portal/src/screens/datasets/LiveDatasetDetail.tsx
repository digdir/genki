import {
  Alert,
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tabs,
  Tag,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import {
  skippedCount,
  skippedOf,
  type DatasetDetailView,
  type ExecutionView,
  type ExecutionsView,
  type PipelineSource,
  type PipelineView,
  type Schedule,
  type SkippedDocument,
} from '../../api/datasets';
import { ApiCallLink } from '../../components/ApiCall';
import { datasetRunCall } from '../../data/api-calls';
import { Icon } from '../../components/Icon';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import {
  kudosDocumentTypes,
  statusColors,
  statusKeys,
  type DatasetStatus,
} from '../../data/datasets';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import type { DetailTab } from './DatasetDetail';
import {
  countText,
  datasetStatus,
  executionStatus,
  externalSourceText,
  fromGlobs,
  reasonText,
  residencyText,
  scheduleText,
  sharedSourceText,
  sourceText,
  toGlobs,
  whenText,
  failureText,
} from './live-model';
import { SearchEngine } from './SearchEngine';
import { Uploads } from './Uploads';
import './search-engine.css';

const back = 'M15 6l-6 6 6 6';
const chevron = 'M6 9l6 6 6-6';
const play = 'M7 5l12 7-12 7z';
const years = ['2010', '2015', '2018', '2020', '2022', '2024'];

export const pollMs = 1500;

const Skipped = ({ list }: { list: SkippedDocument[] }) => {
  const t = useT();
  return (
    <ul aria-label={t('datasets.skipped')} className="skipped-list">
      {list.map((s) => (
        <li key={s.document}>
          <strong className="wrap">{s.document}</strong>
          <span>{reasonText(t, s.reason)}</span>
        </li>
      ))}
    </ul>
  );
};

const Run = ({
  run,
  open,
  onToggle,
}: {
  run: ExecutionView;
  open: boolean;
  onToggle: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const status = executionStatus(t, run);
  const skipped = skippedOf(run);
  const running = run.status === 'running';
  return (
    <li id={`run-${run.id}`} className={open ? 'run open' : 'run'}>
      <button type="button" className="run-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="run-when">
          <strong>{f.dateTime(run.startedAt)}</strong>
          <span className="meta">
            {run.endedAt
              ? t('datasets.finishedAt', { when: f.dateTime(run.endedAt) })
              : t('datasets.stillRunning')}
          </span>
        </span>
        <Tag data-size="sm" data-color={status.color}>
          {running ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
          {status.text}
        </Tag>
        <span className="run-counts numeric">
          <span>{t('datasets.storedCount', { amount: f.number(run.report?.stored ?? 0) })}</span>
          <span>{t('datasets.skippedCount', { amount: f.number(skippedCount(run)) })}</span>
        </span>
        <span className={open ? 'chevron up' : 'chevron'}>
          <Icon d={chevron} size={18} />
        </span>
      </button>
      {open ? (
        <div className="run-body">
          {running ? <p className="meta">{t('datasets.runningSelfUpdates')}</p> : null}
          {run.status === 'failed' ? (
            <div className="run-error fatal">
              <strong>{t('datasets.ingestionFailed')}</strong>
              <p className="why">{t('datasets.nothingChanged')}</p>
              {run.error ? (
                <span className="code">
                  {t('datasets.technicalMessage', { message: run.error })}
                </span>
              ) : null}
            </div>
          ) : null}
          {skipped.length > 0 ? <Skipped list={skipped} /> : null}
          {!running && run.status !== 'failed' && skipped.length === 0 ? (
            <p className="no-errors">{t('datasets.noneSkipped')}</p>
          ) : null}
          {run.report?.failed.length ? (
            <p className="meta">
              {t('datasets.documentsFailed', {
                count: run.report.failed.length,
                names: run.report.failedDocuments
                  ? run.report.failedDocuments.map((d) => `${d.document}: ${d.reason}`).join(', ')
                  : run.report.failed.join(', '),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

interface SourceForm {
  name: string;
  description: string;
  sitemap: string;
  include: string;
  exclude: string;
  types: string[];
  fromYear: string;
  schedule: Schedule;
  reason: string;
}

const formOf = (view: DatasetDetailView, pipeline: PipelineView | undefined): SourceForm => {
  const source = pipeline?.spec.source;
  return {
    name: view.name,
    description: view.description ?? '',
    sitemap: source?.kind === 'website' ? source.sitemap : '',
    include: source?.kind === 'website' ? fromGlobs(source.include) : '',
    exclude: source?.kind === 'website' ? fromGlobs(source.exclude) : '',
    types: source?.kind === 'kudos' ? source.types : [],
    fromYear: source?.kind === 'kudos' && source.since ? source.since.slice(0, 4) : '2020',
    schedule: pipeline?.spec.schedule ?? 'none',
    reason: '',
  };
};

const sourceFrom = (form: SourceForm, current: PipelineSource): PipelineSource =>
  current.kind === 'website'
    ? {
        kind: 'website',
        sitemap: form.sitemap.trim(),
        include: toGlobs(form.include),
        exclude: toGlobs(form.exclude),
      }
    : current.kind === 'kudos'
      ? { ...current, types: form.types, since: `${form.fromYear}-01-01` }
      : current;

const SourceSettings = ({
  api,
  tenant,
  view,
  pipeline,
  onSaved,
}: {
  api: ApiClient;
  tenant: string;
  view: DatasetDetailView;
  pipeline: PipelineView | undefined;
  onSaved: (text: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [form, setForm] = useState(() => formOf(view, pipeline));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const set = (patch: Partial<SourceForm>) => setForm((f) => ({ ...f, ...patch }));
  const source = pipeline?.spec.source;

  const save = async () => {
    setTried(true);
    if (reasonProblem(form.reason, t) || !form.name.trim()) return;
    setBusy(true);
    setFailure('');
    const reason = form.reason.trim();
    try {
      if (form.name.trim() !== view.name || form.description.trim() !== (view.description ?? ''))
        await api.datasets.rename(
          tenant,
          view.id,
          { name: form.name.trim(), description: form.description.trim() },
          reason,
        );
      if (pipeline && source) {
        const spec = {
          ...pipeline.spec,
          name: form.name.trim(),
          source: sourceFrom(form, source),
          schedule: source.kind === 'upload' ? ('none' as const) : form.schedule,
        };
        if (JSON.stringify(spec) !== JSON.stringify(pipeline.spec))
          await api.datasets.savePipeline(tenant, view.id, pipeline.id, spec, reason);
      }
      setForm((f) => ({ ...f, reason: '' }));
      setTried(false);
      onSaved(tRef.current('datasets.changesSaved'));
    } catch (error) {
      setFailure(failureText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="kilde-h" className="source-card">
      <h2 id="kilde-h" className="card-title">
        {t('datasets.tabSource')}
      </h2>
      <Textfield
        label={t('datasets.name')}
        value={form.name}
        error={tried && !form.name.trim() ? t('datasets.nameProblem') : undefined}
        onChange={(e) => set({ name: e.target.value })}
      />
      <Textfield
        label={t('datasets.description')}
        multiline
        rows={2}
        value={form.description}
        onChange={(e) => set({ description: e.target.value })}
      />
      <dl className="source-dl">
        <div>
          <dt>{t('datasets.factSource')}</dt>
          <dd>{t(sourceText[view.source])}</dd>
        </div>
      </dl>
      {source?.kind === 'website' ? (
        <>
          <Textfield
            type="url"
            label={t('datasets.sitemapLabel')}
            value={form.sitemap}
            onChange={(e) => set({ sitemap: e.target.value })}
          />
          <Field>
            <Label htmlFor="kilde-med">{t('datasets.includeOnly')}</Label>
            <Field.Description>{t('datasets.includeHelp')}</Field.Description>
            <Textarea
              id="kilde-med"
              rows={3}
              value={form.include}
              onChange={(e) => set({ include: e.target.value })}
            />
          </Field>
          <Field>
            <Label htmlFor="kilde-utelat">{t('datasets.exclude')}</Label>
            <Textarea
              id="kilde-utelat"
              rows={3}
              value={form.exclude}
              onChange={(e) => set({ exclude: e.target.value })}
            />
          </Field>
        </>
      ) : null}
      {source?.kind === 'kudos' ? (
        <>
          <Fieldset>
            <Fieldset.Legend>{t('datasets.documentTypes')}</Fieldset.Legend>
            <Fieldset.Description>{t('datasets.noTypeMeansAll')}</Fieldset.Description>
            <div className="tag-row">
              {kudosDocumentTypes.map((type) => (
                <Chip.Checkbox
                  key={type}
                  checked={form.types.includes(type)}
                  onChange={() =>
                    set({
                      types: form.types.includes(type)
                        ? form.types.filter((x) => x !== type)
                        : [...form.types, type],
                    })
                  }
                >
                  {type}
                </Chip.Checkbox>
              ))}
            </div>
          </Fieldset>
          <Field className="year-field">
            <Label htmlFor="kilde-fra-ar">{t('datasets.fromYear')}</Label>
            <Select
              id="kilde-fra-ar"
              value={form.fromYear}
              onChange={(e) => set({ fromYear: e.target.value })}
            >
              {years.map((y) => (
                <Select.Option key={y} value={y}>
                  {y}
                </Select.Option>
              ))}
            </Select>
          </Field>
        </>
      ) : null}
      {source && source.kind !== 'upload' ? (
        <Field className="schedule-field">
          <Label htmlFor="kilde-tidsplan">{t('datasets.update')}</Label>
          <Select
            id="kilde-tidsplan"
            value={form.schedule}
            onChange={(e) => set({ schedule: e.target.value as Schedule })}
          >
            <Select.Option value="daily">{t(scheduleText.daily)}</Select.Option>
            <Select.Option value="weekly">{t(scheduleText.weekly)}</Select.Option>
            <Select.Option value="none">{t(scheduleText.none)}</Select.Option>
          </Select>
        </Field>
      ) : null}
      <ReasonField value={form.reason} onChange={(reason) => set({ reason })} showError={tried} />
      <div aria-live="polite">
        {failure ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('datasets.changesNotSaved', { problem: failure })}
          </Alert>
        ) : null}
      </div>
      <Button
        variant="primary"
        data-size="sm"
        className="align-start"
        aria-disabled={busy ? true : undefined}
        onClick={() => !busy && void save()}
      >
        {busy ? t('datasets.saving') : t('common.save')}
      </Button>
    </section>
  );
};

const Facets = ({
  api,
  tenant,
  view,
}: {
  api: ApiClient;
  tenant: string;
  view: DatasetDetailView;
}) => {
  const t = useT();
  const f = useFormat();
  const fields = view.facets ?? [];
  const [values] = useAsync(
    (signal) =>
      fields.length ? api.facets(view.fullId, tenant, fields, signal) : Promise.resolve([]),
    [api, tenant, view.fullId, fields.join(',')],
  );
  if (fields.length === 0) return <p className="meta">{t('datasets.noFiltersLive')}</p>;
  const found = values.status === 'ready' ? values.data : [];
  return (
    <div className="facet-grid">
      {fields.map((field) => {
        const options = found.find((x) => x.field === field)?.options ?? [];
        return (
          <section key={field} className="facet-card" aria-label={field}>
            <h3 className="facet-name">{field}</h3>
            {options.length ? (
              <ul aria-label={t('datasets.valuesFor', { name: field })} className="facet-values">
                {options.map((o) => (
                  <li key={o.value}>
                    <span>{o.value}</span>
                    <span className="numeric right">{f.number(o.count)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="meta">
                {values.status === 'loading'
                  ? t('datasets.loadingValues')
                  : t('datasets.valuesUnavailable')}
              </span>
            )}
          </section>
        );
      })}
    </div>
  );
};

export const LiveDatasetDetail = ({
  api,
  tenant,
  tenantName,
  id,
  initialTab,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  id: string;
  initialTab: DetailTab;
}) => {
  const t = useT();
  const [detail, retryDetail] = useAsync(
    (signal) => api.datasets.get(tenant, id, signal),
    [api, tenant, id],
  );
  if (detail.status === 'loading') return <Loading label={t('datasets.loadingOne')} />;
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
      initialTab={initialTab}
    />
  );
};

const Loaded = ({
  api,
  tenant,
  tenantName,
  initial,
  initialTab,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  initial: DatasetDetailView;
  initialTab: DetailTab;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [trying, setTrying] = useState(false);
  const [openRun, setOpenRun] = useState<string>();
  const [runs, setRuns] = useState<ExecutionsView>();
  const [flash, setFlash] = useState('');
  const [failure, setFailure] = useState('');
  const [finished, setFinished] = useState<ExecutionView>();
  const watching = useRef(initial.lastExecution?.status === 'running');
  const rights = useRights();
  const editable = view.editable !== false;
  const canEdit = editable && rights.has('manage-datasets');
  const [pipelines, retryPipelines] = useAsync(
    (signal) => (editable ? api.datasets.pipelines(tenant, view.id, signal) : Promise.resolve([])),
    [api, tenant, view.id, editable],
  );
  const pipeline = pipelines.status === 'ready' ? pipelines.data[0] : undefined;
  useEffect(() => setTab(initialTab), [initialTab]);

  const refresh = useCallback(async () => {
    if (!pipeline) return;
    const next = await api.datasets.executions(tenant, view.id, pipeline.id);
    setRuns(next);
    const latest = next.data[0];
    if (latest && latest.status !== 'running' && watching.current) {
      watching.current = false;
      setFinished(latest);
      setOpenRun(latest.id);
      setView(await api.datasets.get(tenant, view.id));
    }
    if (latest?.status === 'running') watching.current = true;
  }, [api, tenant, view.id, pipeline]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const running = runs?.data[0]?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), pollMs);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const run = async () => {
    if (!pipeline || running) return;
    setFailure('');
    setFlash('');
    setFinished(undefined);
    try {
      await api.datasets.execute(tenant, view.id, pipeline.id, 'Manuell innlesing fra portalen');
      watching.current = true;
      await refresh();
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

  const cancel = async () => {
    const execution = runs?.data.find((r) => r.status === 'running');
    if (!pipeline || !execution) return;
    setFailure('');
    setFlash('');
    try {
      await api.datasets.cancelExecution(
        tenant,
        view.id,
        pipeline.id,
        execution.id,
        'Avbrutt fra portalen',
      );
      setFlash(tRef.current('datasets.ingestionCancelled'));
      await refresh();
    } catch (error) {
      setFailure(failureText(tRef.current, error));
    }
  };

  const latest = runs?.data[0];
  const lastOk = runs?.data.find((r) => r.status === 'succeeded');
  const status: DatasetStatus =
    view.state === 'external'
      ? datasetStatus(view)
      : latest
        ? latest.status === 'running'
          ? 'Innlesing pågår'
          : latest.status === 'failed'
            ? 'Feilet'
            : latest.status === 'cancelled'
              ? 'Delvis lest inn'
              : 'Klar'
        : datasetStatus(view);
  const nextRun = runs?.nextRunAt !== undefined ? runs.nextRunAt : view.nextRunAt;
  const skippedNow = finished
    ? skippedOf(finished).length
      ? skippedOf(finished)
      : (view.skipped ?? [])
    : [];

  return (
    <div className="stack dataset-page">
      <a href="#/datasets" className="back-link">
        <Icon d={back} size={18} />
        {t('datasets.title')}
      </a>
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="md">
              {view.name}
            </Heading>
            <Tag data-color={statusColors[status]}>{t(statusKeys[status])}</Tag>
            <Tag data-color="neutral">{sharedSourceText(t, view)}</Tag>
          </div>
          {view.description ? <p className="lead">{view.description}</p> : null}
        </div>
        <div className="actions">
          <Button variant="secondary" aria-pressed={trying} onClick={() => setTrying((x) => !x)}>
            <Icon d={play} />
            {t('datasets.try')}
          </Button>
          {canEdit && pipeline ? (
            <>
              <Button
                variant="secondary"
                aria-disabled={running || undefined}
                onClick={() => void run()}
              >
                {t('datasets.runNow')}
              </Button>
              {running ? (
                <Button variant="secondary" data-color="danger" onClick={() => void cancel()}>
                  {t('datasets.cancelIngestion')}
                </Button>
              ) : null}
              <ApiCallLink
                call={{
                  ...datasetRunCall(tenant, view.id, pipeline.id),
                  action: t('datasets.apiRunAction', { name: view.name }),
                  right: t('rights.manageDatasets'),
                  endpoint: 'ds-pipeline-run',
                }}
              />
            </>
          ) : null}
        </div>
      </div>
      <div aria-live="polite" className="stack-sm">
        {running ? (
          <Alert data-color="info" data-size="sm">
            <span role="status" className="row-wrap">
              <Spinner aria-hidden="true" data-size="xs" />
              {t('datasets.runningLeave')}
            </span>
          </Alert>
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
        {finished?.status === 'failed' ? (
          <Alert data-color="danger">
            <Heading level={2} data-size="2xs">
              {t('datasets.ingestionFailed')}
            </Heading>
            <p className="alert-text">{t('datasets.nothingChanged')}</p>
          </Alert>
        ) : null}
        {failure ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('datasets.couldNotStart', { problem: failure })}
          </Alert>
        ) : null}
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>
      <dl className="facts">
        {[
          [t('datasets.factDocuments'), countText(t, f, view.documents)],
          [t('datasets.factChunks'), countText(t, f, view.chunks)],
          [
            t('datasets.factLastOk'),
            view.state === 'external'
              ? t('datasets.lastExternal')
              : lastOk?.endedAt
                ? f.dateTime(lastOk.endedAt)
                : view.lastExecution?.status === 'succeeded'
                  ? whenText(
                      f,
                      view.lastExecution.endedAt ?? view.lastExecution.startedAt,
                      t('datasets.notYet'),
                    )
                  : t('datasets.notYet'),
          ],
          [
            t('datasets.factNext'),
            view.state === 'external'
              ? t('datasets.nextExternal')
              : whenText(f, nextRun, t('datasets.scheduleNone')),
          ],
          [t('datasets.factProcessed'), residencyText(t, view.effectiveResidency)],
        ].map(([l, v]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd className="fact-text">{v}</dd>
          </div>
        ))}
      </dl>

      <Tabs value={tab} onChange={(v) => setTab(v as DetailTab)}>
        <Tabs.List aria-label={t('datasets.tabsLabel')}>
          <Tabs.Tab value="ingestions">{t('datasets.tabIngestions')}</Tabs.Tab>
          <Tabs.Tab value="filters">{t('datasets.tabFilters')}</Tabs.Tab>
          <Tabs.Tab value="source">{t('datasets.tabSource')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ingestions">
          {!editable ? (
            <p className="meta">
              {view.state === 'external'
                ? t('datasets.externalIngestions')
                : t('datasets.sharedIngestions')}
            </p>
          ) : pipelines.status === 'error' ? (
            <ErrorState error={pipelines.error} onRetry={retryPipelines} headingLevel={3} />
          ) : !runs || runs.data.length === 0 ? (
            <p className="meta">{t('datasets.noIngestions')}</p>
          ) : (
            <ol className="runs" aria-label={t('datasets.tabIngestions')}>
              {runs.data.map((r) => (
                <Run
                  key={r.id}
                  run={r}
                  open={openRun === r.id}
                  onToggle={() => setOpenRun(openRun === r.id ? undefined : r.id)}
                />
              ))}
            </ol>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="filters">
          <div className="stack-sm">
            <p className="meta panel-intro">{t('datasets.filtersIntro')}</p>
            <Facets api={api} tenant={tenant} view={view} />
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="source">
          <div className="source-grid">
            {canEdit ? (
              <SourceSettings
                key={`${view.name}-${pipeline?.version ?? 0}`}
                api={api}
                tenant={tenant}
                view={view}
                pipeline={pipeline}
                onSaved={(text) => {
                  setFlash(text);
                  retryPipelines();
                  void api.datasets.get(tenant, view.id).then(setView, () => undefined);
                }}
              />
            ) : (
              <section aria-labelledby="kilde-h" className="source-card">
                <h2 id="kilde-h" className="card-title">
                  {t('datasets.factSource')}
                </h2>
                <dl className="source-dl">
                  <div>
                    <dt>{t('datasets.factSource')}</dt>
                    <dd>
                      {view.state === 'external'
                        ? externalSourceText(t, view)
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
            )}
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
          </div>
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
        </Tabs.Panel>
      </Tabs>
      {trying ? (
        <div className="dataset-try-sheet">
          <PlaygroundPanel
            layout="side"
            context="dataset"
            name={view.fullId}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            onClose={() => setTrying(false)}
          />
        </div>
      ) : null}
    </div>
  );
};
