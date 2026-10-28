import {
  Alert,
  Button,
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
  Tabs,
  Tag,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import {
  problemTitle,
  type Estimate,
  type ProjectDetail,
  type ProjectRun,
  type ProjectSelection,
  type Subscription,
} from '../../projects-api';
import { go, SelectionFields, serviceTitle, type ProjectsProps } from './shared';

const tabs = ['data', 'points', 'analyses', 'log'] as const;
type Tab = (typeof tabs)[number];

const kroner = (micro: number, f: Format) => f.currency(micro / 1_000_000);

const nextMonth = (now: Date, f: Format) =>
  f.date(new Date(now.getFullYear(), now.getMonth() + 1, 1)).replace(/ \d{4}$/, '');

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const whoOf = (t: T, by: string, name?: string) =>
  name ?? (by.startsWith('platform:') ? t('project.platform') : by.slice(by.lastIndexOf(':') + 1));

const isActive = (run: ProjectRun) => run.status === 'queued' || run.status === 'running';

const runStatus = (
  status: ProjectRun['status'],
): [PlainKey, 'success' | 'warning' | 'danger' | 'neutral' | 'info'] =>
  status === 'succeeded'
    ? ['project.statusSucceeded', 'success']
    : status === 'failed'
      ? ['project.statusFailed', 'danger']
      : status === 'cancelled'
        ? ['project.statusCancelled', 'neutral']
        : status === 'stopped'
          ? ['project.statusStopped', 'warning']
          : ['project.statusRunning', 'info'];

type Props = ProjectsProps & { id: string; tab: string; item?: string };

export const ProjectPage = (props: Props) => {
  const t = useT();
  const f = useFormat();
  const { api, tenant, id } = props;
  const tab: Tab = tabs.includes(props.tab as Tab) ? (props.tab as Tab) : 'data';
  const [round, setRound] = useState(0);
  const [noAccess, setNoAccess] = useState(false);
  const [project, retry] = useAsync(
    (signal) => api.get(tenant, id, signal),
    [api, tenant, id, round],
  );
  const [runs, , setRuns] = useAsync(
    (signal) => api.runs(tenant, id, signal),
    [api, tenant, id, round],
  );
  const seen = useRef<ProjectDetail>(undefined);
  if (project.status === 'ready') seen.current = project.data;
  const current = seen.current?.id === id ? seen.current : undefined;
  const refresh = () => setRound((r) => r + 1);

  if (!current) {
    if (project.status === 'error')
      return (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{problemTitle(project.error, t)}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('project.tryAgain')}
          </Button>
        </Alert>
      );
    return <Spinner aria-label={t('project.loading')} data-size="md" />;
  }

  const fresh = current.subscriptions.reduce((n, s) => n + s.fresh.length, 0);
  const runList = runs.status === 'ready' ? runs.data : [];
  const pending = runList.filter((r) => r.approval?.status === 'pending').length;
  const problems = current.subscriptions.flatMap((s) =>
    problemsOf(s, current, props.services, t, f),
  );

  return (
    <div className="project-page">
      <a href="#/projects" className="back-link">
        {t('project.allProjects')}
      </a>
      <div className="page-head">
        <Heading level={1} data-size="md">
          {current.name}
        </Heading>
        {current.purpose ? <Paragraph>{current.purpose}</Paragraph> : null}
        <div className="actions">
          <RenameProject
            api={api}
            tenant={tenant}
            project={current}
            onFlash={props.onFlash}
            onRenamed={refresh}
          />
          <DeleteProject api={api} tenant={tenant} project={current} onFlash={props.onFlash} />
        </div>
      </div>
      {noAccess ? (
        <Alert data-color="danger">
          <Paragraph className="alert-title">{t('project.noAccessTitle')}</Paragraph>
          <Paragraph>{t('project.noAccessText')}</Paragraph>
        </Alert>
      ) : null}
      {problems.map((p) => (
        <Alert key={p.title} data-color="warning">
          <Paragraph className="alert-title">{p.title}</Paragraph>
          <Paragraph>{p.text}</Paragraph>
        </Alert>
      ))}
      <Tabs value={tab} onChange={(next) => go(`/projects/${encodeURIComponent(id)}/${next}`)}>
        <Tabs.List>
          <Tabs.Tab value="data">
            {t('project.tabData')}
            {fresh ? (
              <Tag data-size="sm" data-color="info" className="tab-tag">
                {t('project.freshCount', { count: fresh })}
              </Tag>
            ) : null}
          </Tabs.Tab>
          <Tabs.Tab value="points">{t('project.tabPoints')}</Tabs.Tab>
          <Tabs.Tab value="analyses">
            {t('project.tabAnalyses')}
            {pending ? (
              <Tag data-size="sm" data-color="info" className="tab-tag">
                {t('project.pendingCount', { count: pending })}
              </Tag>
            ) : null}
          </Tabs.Tab>
          <Tabs.Tab value="log">{t('project.tabLog')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="data">
          {tab === 'data' ? (
            <DataTab
              {...props}
              project={current}
              noAccess={noAccess}
              onNoAccess={() => setNoAccess(true)}
              onChanged={refresh}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="points">{tab === 'points' ? <PointsTab {...props} /> : null}</Tabs.Panel>
        <Tabs.Panel value="analyses">
          {tab === 'analyses' ? (
            <AnalysesTab
              {...props}
              project={current}
              runs={runList}
              loading={runs.status === 'loading' && runList.length === 0}
              onChanged={(run) => {
                if (run)
                  setRuns((state) =>
                    state.status === 'ready'
                      ? {
                          status: 'ready',
                          data: state.data.map((r) => (r.id === run.id ? run : r)),
                        }
                      : state,
                  );
                else refresh();
              }}
            />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="log">
          {tab === 'log' ? <LogTab {...props} round={round} /> : null}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};

const RenameProject = ({
  api,
  tenant,
  project,
  onFlash,
  onRenamed,
}: Pick<Props, 'api' | 'tenant' | 'onFlash'> & {
  project: ProjectDetail;
  onRenamed: () => void;
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [others] = useAsync(
    async (signal) => (editing ? await api.list(tenant, signal) : []),
    [api, tenant, editing],
  );
  if (!editing)
    return (
      <div>
        <Button
          variant="tertiary"
          data-size="sm"
          onClick={() => {
            setName(project.name);
            setTried(false);
            setError('');
            setEditing(true);
          }}
        >
          {t('project.rename')}
        </Button>
      </div>
    );
  const wanted = name.trim();
  const taken =
    others.status === 'ready' &&
    others.data.some(
      (p) => p.id !== project.id && p.name.trim().toLowerCase() === wanted.toLowerCase(),
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (busy || !wanted || taken) return;
    if (wanted === project.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.update(
        tenant,
        project.id,
        {
          name: wanted,
          purpose: project.purpose,
          services: project.services,
          selections: project.selections,
          version: project.version,
        },
        t('project.renameReason'),
      );
      onFlash(t('project.renamed'));
      setEditing(false);
      onRenamed();
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rename-project" onSubmit={(e) => void save(e)} noValidate>
      <Textfield
        id="prosjekt-nytt-navn"
        data-size="sm"
        label={t('project.newName')}
        value={name}
        {...(tried && !wanted
          ? { error: t('project.nameMissing') }
          : taken
            ? { error: t('project.nameTaken') }
            : {})}
        onChange={(e) => setName(e.target.value)}
      />
      {error ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{error}</Paragraph>
        </Alert>
      ) : null}
      <div className="actions">
        <Button type="submit" data-size="sm" aria-disabled={busy || undefined}>
          {t('project.saveName')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={() => setEditing(false)}>
          {t('project.cancel')}
        </Button>
      </div>
    </form>
  );
};

const DeleteProject = ({
  api,
  tenant,
  project,
  onFlash,
}: Pick<Props, 'api' | 'tenant' | 'onFlash'> & { project: ProjectDetail }) => {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!asking)
    return (
      <div>
        <Button
          variant="tertiary"
          data-size="sm"
          data-color="danger"
          onClick={() => setAsking(true)}
        >
          {t('project.delete')}
        </Button>
      </div>
    );
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.remove(tenant, project.id, t('project.deleteReason'));
      onFlash(t('project.deleted'));
      go('/projects');
    } catch (e) {
      setError(problemTitle(e, t));
      setBusy(false);
    }
  };
  return (
    <Alert data-color="danger" data-size="sm" role="alertdialog">
      <Paragraph data-size="sm">{t('project.deleteConfirm', { name: project.name })}</Paragraph>
      {error ? <Paragraph data-size="sm">{error}</Paragraph> : null}
      <div className="actions">
        <Button
          data-size="sm"
          data-color="danger"
          aria-disabled={busy || undefined}
          onClick={() => void remove()}
        >
          {t('project.deleteYes')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={() => setAsking(false)}>
          {t('project.cancel')}
        </Button>
      </div>
    </Alert>
  );
};

const problemsOf = (
  subscription: Subscription,
  project: ProjectDetail,
  services: ProjectsProps['services'],
  t: T,
  f: Format,
) => {
  const out: { title: string; text: string }[] = [];
  const paused = subscription.paused;
  if (paused?.kind === 'cost-cap')
    out.push({
      title: subscription.cap.maxCostNok
        ? t('project.capReachedAt', { amount: f.currency(subscription.cap.maxCostNok) })
        : t('project.capReached'),
      text: t('project.capWaiting', {
        count: subscription.waiting,
        date: nextMonth(new Date(), f),
      }),
    });
  else if (paused)
    out.push({
      title: t('project.pausedTitle'),
      text: `${
        subscription.service
          ? t('project.pausedService', { service: serviceTitle(services, subscription.service) })
          : ''
      }${paused.reason}`,
    });
  if (subscription.error)
    out.push({
      title: t('project.checkFailed', {
        selection:
          project.selections.find((s) => s.id === subscription.selection)?.name ??
          t('project.theSelection'),
      }),
      text: t('project.checkFailedText', { error: subscription.error }),
    });
  return out;
};

const filterTags = (selection: ProjectSelection) =>
  Object.entries(selection.filters).flatMap(([field, values]) =>
    values.map((v) => ({ key: `${field}/${v}`, text: v })),
  );

type DataProps = Props & {
  project: ProjectDetail;
  noAccess: boolean;
  onNoAccess: () => void;
  onChanged: () => void;
};

const DataTab = (props: DataProps) => {
  const t = useT();
  const { project } = props;
  const followable = project.selections.filter((s) => !s.documents?.length);
  const fixed = project.selections.filter((s) => s.documents?.length);
  return (
    <div className="project-tab">
      {project.selections.length === 0 ? <Paragraph>{t('project.noDocuments')}</Paragraph> : null}
      {followable.map((s) => (
        <SelectionCard
          key={s.id}
          {...props}
          selection={s}
          subscription={project.subscriptions.find((x) => x.selection === s.id)}
        />
      ))}
      <article className="panel stack-sm">
        <Heading level={2} data-size="xs">
          {t('project.singleDocuments')}
        </Heading>
        {fixed.length ? (
          <ul className="plain">
            {fixed.map((s) => (
              <li key={s.id}>
                {t('project.fixedSelection', {
                  name: s.name,
                  documents: t('project.documentCount', { count: s.documents?.length ?? 0 }),
                })}
              </li>
            ))}
          </ul>
        ) : null}
        <NewSelection {...props} />
      </article>
    </div>
  );
};

const SelectionCard = ({
  api,
  tenant,
  project,
  selection,
  subscription,
  services,
  noAccess,
  onNoAccess,
  onChanged,
  onFlash,
}: DataProps & { selection: ProjectSelection; subscription: Subscription | undefined }) => {
  const t = useT();
  const f = useFormat();
  const [documents] = useAsync(
    (signal) => api.documents(tenant, project.id, selection.id, signal),
    [api, tenant, project.id, selection.id],
  );
  const forbidden =
    documents.status === 'error' &&
    documents.error instanceof ApiError &&
    documents.error.status === 403;
  useEffect(() => {
    if (forbidden) onNoAccess();
  }, [forbidden]);
  const [mode, setMode] = useState(subscription?.mode ?? 'notify');
  const [service, setService] = useState(subscription?.service ?? project.services[0] ?? '');
  const [limit, setLimit] = useState(
    subscription?.cap.maxCostNok === undefined ? '' : String(subscription.cap.maxCostNok),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const headingId = `utvalg-${selection.id}-h`;
  const on = Boolean(subscription);

  const act = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      onFlash(done);
      onChanged();
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };

  const notify = () =>
    act(
      () =>
        api.subscribe(
          tenant,
          project.id,
          selection.id,
          { mode: 'notify' },
          t('project.followReason'),
        ),
      t('project.following'),
    );

  const limitValue = Number(limit.replace(',', '.'));
  const automatic = () => {
    if (!(Number.isFinite(limitValue) && limitValue > 0)) {
      setError(t('project.limitMissing'));
      return;
    }
    void act(
      () =>
        api.subscribe(
          tenant,
          project.id,
          selection.id,
          { mode: 'run', service, maxCostNok: limitValue },
          t('project.autoReason'),
        ),
      t('project.autoOn'),
    );
  };

  return (
    <article className="panel stack" aria-labelledby={headingId}>
      <div className="row-between">
        <Heading level={2} data-size="xs" id={headingId}>
          {selection.name}
        </Heading>
        <span aria-live="polite" className="strong">
          {documents.status === 'ready'
            ? t('project.documentCount', { count: documents.data.found })
            : ''}
        </span>
      </div>
      <div className="tags">
        {documents.status === 'ready' ? (
          <Tag data-size="sm" data-color="neutral">
            {documents.data.datasetName}
          </Tag>
        ) : null}
        {filterTags(selection).map((tag) => (
          <Tag key={tag.key} data-size="sm" data-color="neutral">
            {tag.text}
          </Tag>
        ))}
      </div>
      <Details data-size="sm" aria-label={t('project.whereFrom')}>
        <Details.Summary>{t('project.whereFrom')}</Details.Summary>
        <Details.Content>
          {documents.status === 'ready'
            ? t('project.datasetIs', { name: documents.data.datasetName })
            : ''}
          {subscription?.checkedAt
            ? t('project.lastChecked', { when: f.dateTime(subscription.checkedAt) })
            : t('project.followHint')}
        </Details.Content>
      </Details>
      <div className="subscription-box">
        <Switch
          label={t('project.follow')}
          checked={on}
          disabled={noAccess || busy}
          onChange={(e) =>
            e.target.checked
              ? void notify()
              : void act(
                  () =>
                    api.unsubscribe(tenant, project.id, selection.id, t('project.unfollowReason')),
                  t('project.unfollowed'),
                )
          }
        />
        {on ? (
          <>
            <Paragraph data-size="sm">{t('project.followText')}</Paragraph>
            <Fieldset data-size="sm">
              <Fieldset.Legend>{t('project.whenNew')}</Fieldset.Legend>
              <Radio
                name={`modus-${selection.id}`}
                label={t('project.justShow')}
                checked={mode === 'notify'}
                onChange={() => {
                  setMode('notify');
                  if (subscription?.mode === 'run') void notify();
                }}
              />
              <Radio
                name={`modus-${selection.id}`}
                label={t('project.runAuto')}
                checked={mode === 'run'}
                onChange={() => setMode('run')}
              />
            </Fieldset>
            {mode === 'run' ? (
              <div className="stack-sm">
                <div className="field-grid">
                  <Field data-size="sm">
                    <Label htmlFor={`auto-tjeneste-${selection.id}`}>{t('project.service')}</Label>
                    <Select
                      id={`auto-tjeneste-${selection.id}`}
                      value={service}
                      onChange={(e) => setService(e.target.value)}
                    >
                      {project.services.map((s) => (
                        <Select.Option key={s} value={s}>
                          {serviceTitle(services, s)}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                  <Textfield
                    data-size="sm"
                    id={`auto-grense-${selection.id}`}
                    label={t('project.limit')}
                    inputMode="decimal"
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                  />
                </div>
                <Paragraph data-size="sm">{t('project.draftsUntilApproved')}</Paragraph>
                {subscription?.mode === 'run' &&
                subscription.service === service &&
                String(subscription.cap.maxCostNok ?? '') === limit ? null : (
                  <div>
                    <Button
                      data-size="sm"
                      aria-disabled={busy || project.services.length === 0 || undefined}
                      onClick={automatic}
                    >
                      {t('project.runAutomatically')}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
            <Paragraph data-size="sm">
              {t('project.emailUndecided')}{' '}
              <Tag data-size="sm" data-color="warning">
                {t('project.undecided')}
              </Tag>
            </Paragraph>
            <Details data-size="sm" aria-label={t('project.showApiCall')}>
              <Details.Summary>{t('project.showApiCall')}</Details.Summary>
              <Details.Content>
                <code className="api-line">
                  PUT /tenants/{tenant}/projects/{project.id}/subscriptions/{selection.id}
                </code>
                <pre className="api-body">
                  {JSON.stringify(
                    mode === 'run'
                      ? { mode, service, maxCostNok: limitValue || undefined }
                      : { mode },
                    null,
                    2,
                  )}
                </pre>
              </Details.Content>
            </Details>
          </>
        ) : null}
        {error ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {error}
          </Alert>
        ) : null}
      </div>
      {subscription?.fresh.length ? (
        <section aria-labelledby={`${headingId}-ny`} className="stack-sm">
          <Heading level={3} data-size="2xs" id={`${headingId}-ny`}>
            {t('project.freshHeading')}
          </Heading>
          <ul className="fresh-list">
            {subscription.fresh.map((fresh) => (
              <li key={fresh.document.id}>
                <span className="tags">
                  <Tag data-size="sm" data-color="info">
                    {t('project.new')}
                  </Tag>
                  {fresh.document.url ? (
                    <a href={fresh.document.url}>{fresh.document.title}</a>
                  ) : (
                    fresh.document.title
                  )}
                </span>
                <span className="subtle-sm">
                  {t('project.readIn', { date: f.date(fresh.arrivedAt) })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
};

const NewSelection = ({ api, tenant, project, onChanged, onFlash }: DataProps) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sources] = useAsync(
    async (signal) => (open ? api.sources(tenant, signal) : []),
    [api, tenant, open],
  );
  const [name, setName] = useState('');
  const [dataset, setDataset] = useState('');
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const list = sources.status === 'ready' ? sources.data : [];
  const datasetId = dataset || list[0]?.id || '';
  if (!open)
    return (
      <div>
        <Button variant="secondary" data-size="sm" onClick={() => setOpen(true)}>
          {t('project.newSelection')}
        </Button>
      </div>
    );
  const save = async () => {
    setError('');
    try {
      await api.update(
        tenant,
        project.id,
        {
          name: project.name,
          purpose: project.purpose,
          services: project.services,
          selections: [
            ...project.selections,
            {
              id: '',
              name: name.trim() || t('project.selectionN', { n: project.selections.length + 1 }),
              dataset: datasetId,
              filters,
            },
          ],
          version: project.version,
        },
        t('project.addSelectionReason'),
      );
      onFlash(t('project.selectionAdded'));
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(problemTitle(e, t));
    }
  };
  return (
    <div className="stack-sm">
      <Textfield
        data-size="sm"
        id="nytt-utvalg-navn"
        label={t('project.selectionName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {sources.status === 'loading' ? (
        <Spinner aria-label={t('project.loadingDatasets')} data-size="sm" />
      ) : (
        <SelectionFields
          sources={list}
          dataset={datasetId}
          filters={filters}
          onChange={(d, f) => {
            setDataset(d);
            setFilters(f);
          }}
        />
      )}
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="actions">
        <Button data-size="sm" onClick={() => void save()}>
          {t('project.addSelection')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={() => setOpen(false)}>
          {t('project.cancel')}
        </Button>
      </div>
    </div>
  );
};

const PointsTab = ({ api, tenant, id, onFlash }: Props) => {
  const t = useT();
  const f = useFormat();
  const [round, setRound] = useState(0);
  const [points, retry] = useAsync(
    (signal) => api.points(tenant, id, signal),
    [api, tenant, id, round],
  );
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const add = async () => {
    if (!text.trim()) {
      setError(t('project.writePoint'));
      return;
    }
    setError('');
    try {
      await api.addPoint(tenant, id, text.trim(), t('project.addPointReason'));
      setText('');
      onFlash(t('project.pointAdded'));
      setRound((r) => r + 1);
    } catch (e) {
      setError(problemTitle(e, t));
    }
  };
  return (
    <div className="project-tab">
      <Paragraph className="measure">{t('project.pointsIntro')}</Paragraph>
      {points.status === 'loading' ? (
        <Spinner aria-label={t('project.loadingPoints')} data-size="sm" />
      ) : points.status === 'error' ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{problemTitle(points.error, t)}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('project.tryAgain')}
          </Button>
        </Alert>
      ) : points.data.length ? (
        <ol className="point-list">
          {points.data.map((p) => (
            <li key={p.id} className="panel">
              <span className="point-text">{p.text}</span>
              <span className="subtle-sm">
                {t('project.pointBy', {
                  who: whoOf(t, p.by, p.byName),
                  date: f.date(p.at).replace(/ \d{4}$/, ''),
                })}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <Field className="measure">
        <Label htmlFor="nytt-punkt">{t('project.newPoint')}</Label>
        <Textarea
          id="nytt-punkt"
          rows={2}
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'nytt-punkt-feil' : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
        />
        {error ? (
          <Paragraph id="nytt-punkt-feil" data-size="sm" className="error-text">
            {error}
          </Paragraph>
        ) : null}
        <Button
          variant="secondary"
          data-size="sm"
          className="form-submit"
          onClick={() => void add()}
        >
          {t('project.add')}
        </Button>
      </Field>
    </div>
  );
};

const AnalysesTab = ({
  api,
  tenant,
  project,
  runs,
  loading,
  item,
  services,
  onChanged,
  onFlash,
}: Props & {
  project: ProjectDetail;
  runs: ProjectRun[];
  loading: boolean;
  onChanged: (run?: ProjectRun) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [error, setError] = useState('');
  const active = runs.some(isActive);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => onChanged(), 2000);
    return () => clearTimeout(timer);
  }, [active, runs]);

  const review = async (run: ProjectRun, decision: 'approved' | 'rejected') => {
    setError('');
    try {
      const approval = await api.review(
        tenant,
        project.id,
        run.id,
        decision,
        decision === 'approved' ? t('project.approveReason') : t('project.rejectReason'),
      );
      onChanged({ ...run, approval });
      onFlash(
        decision === 'approved' ? t('project.resultsApproved') : t('project.resultsRejected'),
      );
      go(`/projects/${encodeURIComponent(project.id)}/analyses`);
    } catch (e) {
      setError(problemTitle(e, t));
    }
  };

  const selectionName = (id?: string) => project.selections.find((s) => s.id === id)?.name ?? '';

  return (
    <div className="project-tab">
      <RunSetup
        api={api}
        tenant={tenant}
        project={project}
        services={services}
        onStarted={() => onChanged()}
        onFlash={onFlash}
      />
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      {loading ? (
        <Spinner aria-label={t('project.loadingAnalyses')} data-size="sm" />
      ) : runs.length === 0 ? (
        <Paragraph>{t('project.noRuns')}</Paragraph>
      ) : (
        <ul className="run-list" aria-label={t('project.analyses')}>
          {[...runs]
            .sort(
              (a, b) =>
                Number(b.approval?.status === 'pending') - Number(a.approval?.status === 'pending'),
            )
            .map((run) => {
              const [statusKey, statusColor] = runStatus(run.status);
              const base = `${serviceTitle(services, run.service)}${
                run.selection ? `, ${selectionName(run.selection).toLowerCase()}` : ''
              }`;
              const title =
                run.trigger === 'subscription' ? t('project.automatic', { title: base }) : base;
              const tag: [string, 'warning' | 'success' | 'danger' | 'neutral' | 'info'] =
                run.approval?.status === 'pending' && !isActive(run)
                  ? [t('project.aiDraft'), 'warning']
                  : run.approval?.status === 'approved'
                    ? [
                        t('project.approvedBy', {
                          name: run.approval.byName ?? t('project.aUser'),
                        }),
                        'success',
                      ]
                    : run.approval?.status === 'rejected'
                      ? [t('project.rejected'), 'danger']
                      : [t(statusKey), statusColor];
              const reviewing = item === run.id;
              return (
                <li key={run.id} className="panel stack-sm">
                  <div className="tags">
                    <Heading level={3} data-size="2xs">
                      {title}
                    </Heading>
                    <Tag data-size="sm" data-color={tag[1]}>
                      {tag[0]}
                    </Tag>
                  </div>
                  <span className="subtle-sm">
                    {[
                      t('project.documentCount', { count: run.total }),
                      t('project.serviceVersion', {
                        service: serviceTitle(services, run.service),
                        version: String(run.version),
                      }),
                      f.dateTime(run.startedAt),
                      ...(run.costMicroNok !== null && run.costMicroNok !== undefined
                        ? [kroner(run.costMicroNok, f)]
                        : []),
                    ].join(' · ')}
                  </span>
                  {run.newSince > 0 ? (
                    <Alert data-color="warning" data-size="sm">
                      <Paragraph data-size="sm">
                        {t('project.olderData', { count: run.newSince })}
                      </Paragraph>
                    </Alert>
                  ) : null}
                  {run.approval?.status === 'pending' && !isActive(run) ? (
                    reviewing ? (
                      <div className="stack-sm review-box">
                        <Paragraph data-size="sm">{t('project.reviewText')}</Paragraph>
                        {api.exportUrl ? (
                          <a href={api.exportUrl(tenant, run)}>{t('project.downloadResults')}</a>
                        ) : null}
                        <div className="actions">
                          <Button data-size="sm" onClick={() => void review(run, 'approved')}>
                            {t('project.approveResults')}
                          </Button>
                          <Button
                            variant="secondary"
                            data-color="danger"
                            data-size="sm"
                            onClick={() => void review(run, 'rejected')}
                          >
                            {t('project.rejectResults')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <a
                          className="ds-button"
                          data-variant="primary"
                          data-size="sm"
                          href={`#/projects/${encodeURIComponent(project.id)}/analyses/${encodeURIComponent(run.id)}`}
                        >
                          {t('project.seeAndApprove')}
                        </a>
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
};

const RunSetup = ({
  api,
  tenant,
  project,
  services,
  onStarted,
  onFlash,
}: Pick<Props, 'api' | 'tenant' | 'services' | 'onFlash'> & {
  project: ProjectDetail;
  onStarted: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [service, setService] = useState(project.services[0] ?? '');
  const [selection, setSelection] = useState(project.selections[0]?.id ?? '');
  const [estimate, setEstimate] = useState<Estimate>();
  const estimates = useRef(new Map<string, Estimate>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (project.services.length === 0 || project.selections.length === 0)
    return <Paragraph data-size="sm">{t('project.linkServiceAndSelection')}</Paragraph>;
  const work = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };
  const calculate = () =>
    work(async () => {
      const key = `${service}\u0000${selection}`;
      const known = estimates.current.get(key);
      if (known) return setEstimate(known);
      const fresh = await api.estimate(
        tenant,
        project.id,
        { service, selection },
        t('project.estimateReason'),
      );
      estimates.current.set(key, fresh);
      setEstimate(fresh);
    });
  const start = () =>
    work(async () => {
      if (!estimate) return;
      await api.start(
        tenant,
        project.id,
        {
          estimate: estimate.id,
          selection,
          ...(estimate.costMicroNok
            ? { maxCostNok: Math.max(1, Math.ceil((estimate.costMicroNok.high * 1.2) / 1_000_000)) }
            : { maxTokens: Math.ceil(estimate.tokens.high * 1.2) }),
        },
        t('project.startReason', {
          service: serviceTitle(services, service),
          count: estimate.items,
        }),
      );
      estimates.current.clear();
      setEstimate(undefined);
      onFlash(t('project.started'));
      onStarted();
    });
  return (
    <section aria-labelledby="ny-analyse-h" className="panel stack-sm">
      <Heading level={2} data-size="xs" id="ny-analyse-h">
        {t('project.newAnalysis')}
      </Heading>
      <div className="field-grid">
        <Field data-size="sm">
          <Label htmlFor="analyse-tjeneste">{t('project.service')}</Label>
          <Select
            id="analyse-tjeneste"
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              setEstimate(undefined);
            }}
          >
            {project.services.map((s) => (
              <Select.Option key={s} value={s}>
                {serviceTitle(services, s)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field data-size="sm">
          <Label htmlFor="analyse-utvalg">{t('project.selection')}</Label>
          <Select
            id="analyse-utvalg"
            value={selection}
            onChange={(e) => {
              setSelection(e.target.value);
              setEstimate(undefined);
            }}
          >
            {project.selections.map((s) => (
              <Select.Option key={s.id} value={s.id}>
                {s.name}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </div>
      {estimate ? (
        <Paragraph data-size="sm" role="status">
          {estimate.costMicroNok
            ? t('project.estimate', {
                low: kroner(estimate.costMicroNok.low, f),
                high: kroner(estimate.costMicroNok.high, f),
                count: estimate.items,
              })
            : t('project.noPrice', { count: estimate.items })}
        </Paragraph>
      ) : null}
      {busy ? (
        <div role="status" className="inline-status">
          <Spinner aria-hidden data-size="sm" />
          <Paragraph data-size="sm">
            {estimate ? t('project.starting') : t('project.calculating')}
          </Paragraph>
        </div>
      ) : null}
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="actions">
        {estimate ? (
          <Button data-size="sm" aria-disabled={busy || undefined} onClick={() => void start()}>
            {t('project.start')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={busy || undefined}
            onClick={() => void calculate()}
          >
            {t('project.calculate')}
          </Button>
        )}
      </div>
    </section>
  );
};

const LogTab = ({ api, tenant, id, round }: Props & { round: number }) => {
  const t = useT();
  const f = useFormat();
  const [log, retry] = useAsync((signal) => api.log(tenant, id, signal), [api, tenant, id, round]);
  return (
    <div className="project-tab">
      <Paragraph data-size="sm" className="subtle">
        {t('project.logIntro')}
      </Paragraph>
      {log.status === 'loading' ? (
        <Spinner aria-label={t('project.loadingLog')} data-size="sm" />
      ) : log.status === 'error' ? (
        <Alert data-color="danger" data-size="sm">
          <Paragraph data-size="sm">{problemTitle(log.error, t)}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retry}>
            {t('project.tryAgain')}
          </Button>
        </Alert>
      ) : (
        <ol className="project-log">
          {log.data.map((e) => (
            <li key={`${e.kind}/${e.id}/${e.version}/${e.at}`}>
              <span className="subtle">{f.dateTime(e.at)}</span>
              <span>
                <strong>{whoOf(t, e.by, e.byName)}</strong> {lowerFirst(e.reason)}
                {e.deleted ? t('project.removed') : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
