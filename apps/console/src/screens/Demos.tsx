import {
  Alert,
  Button,
  Chip,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ApiClient,
  type Demo,
  type DemoApp,
  type DemoAudience,
  type DemoDetail,
  type DemoRecording,
  type RecorderMode,
} from '../api';
import { navigate, useAsync } from '../hooks';
import { useT } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import { Flash, PageHeader, ReasonDialog, TableRegion, VisuallyHidden } from '../ui';
import { DemoEditor } from './demos/Editor';
import { DemoSettingsScreen } from './demos/DemoSettings';
import { RecordingScreen } from './demos/Recording';
import {
  useFileUrl,
  actorName,
  appLabel,
  audienceLabel,
  clock,
  Crumbs,
  demoHref,
  demoState,
  editHref,
  hasFile,
  isOpen,
  progressText,
  requestRecording,
  RecordingTag,
  recordingHref,
  states,
  stateLabel,
  StateTag,
  useActions,
  workflowUrl,
  type DemoState,
} from './demos/shared';
import './demos.css';

export { clock, demoState } from './demos/shared';

const pollMs = 3000;

export const cueStarts = (srt: string) =>
  [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/g)].map(
    ([, h, m, s, ms]) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000,
  );

const asVtt = (srt: string) => `WEBVTT\n\n${srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;

const audienceText = (demo: Demo, t: ReturnType<typeof useT>) =>
  [t(appLabel[demo.app]), demo.audience.map((a) => t(audienceLabel[a])).join(', ')]
    .filter(Boolean)
    .join(' · ');

const Still = ({ api, demo }: { api: ApiClient; demo: Demo }) => {
  const t = useT();
  const recorded = demo.recorded;
  const poster = useFileUrl(
    api,
    hasFile(recorded, 'poster.jpg') ? recorded?.id : undefined,
    'poster.jpg',
  );
  return (
    <div
      className="demo-still"
      role="img"
      aria-label={t('demos.stillLabel', { title: demo.title })}
    >
      {poster.status === 'ready' ? <img src={poster.url} alt="" /> : null}
      {recorded?.seconds !== undefined ? (
        <span className="demo-length">{clock(recorded.seconds)}</span>
      ) : null}
    </div>
  );
};

const DemoCard = ({
  api,
  demo,
  state,
  actions,
}: {
  api: ApiClient;
  demo: Demo;
  state: DemoState;
  actions: ReturnType<typeof useActions>;
}) => {
  const t = useT();
  const f = useFormat();
  const recorded = demo.recorded;
  return (
    <li className="demo-card">
      <Still api={api} demo={demo} />
      <div className="demo-card-body">
        <div className="demo-tags">
          <StateTag state={state} />
          {demo.open ? <RecordingTag /> : null}
        </div>
        <Heading level={3} data-size="xs">
          <Link href={demoHref(demo.id)}>{demo.title}</Link>
        </Heading>
        <Paragraph data-size="sm" className="muted">
          {audienceText(demo, t)}
        </Paragraph>
        {recorded ? (
          <dl className="demo-facts">
            {recorded.seconds !== undefined ? (
              <div>
                <dt>{t('demos.length')}</dt>
                <dd>{clock(recorded.seconds)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t('demos.genki')}</dt>
              <dd>{recorded.genkiVersion}</dd>
            </div>
            <div>
              <dt>{t('demos.recordedAt')}</dt>
              <dd>{f.date(new Date(recorded.finishedAt ?? recorded.startedAt), 'medium')}</dd>
            </div>
          </dl>
        ) : null}
        {demo.open ? (
          <Paragraph data-size="sm">
            {progressText(demo.open, t)}{' '}
            <Link href={recordingHref(demo.open.id)}>{t('demos.followRecording')}</Link>
          </Paragraph>
        ) : null}
        {state === 'failed' && demo.latest?.failure ? (
          <Paragraph data-size="sm">
            {t(recorded ? 'demos.failedAt' : 'demos.failedNoGood', {
              step: demo.latest.failure.step,
              steps: demo.latest.steps,
            })}{' '}
            <Link href={recordingHref(demo.latest.id)}>{t('demos.seeFailure')}</Link>
          </Paragraph>
        ) : null}
        {!recorded && state !== 'failed' && !demo.open ? (
          <Paragraph data-size="sm">{t('demos.notRecorded')}</Paragraph>
        ) : null}
        {recorded ? (
          <div className="demo-actions">
            <Button asChild variant="secondary" data-size="sm">
              <a href={demoHref(demo.id)}>{t('demos.play')}</a>
            </Button>
            <Button
              variant="tertiary"
              data-size="sm"
              onClick={() => void actions.download(recorded, 'demo.mp4')}
            >
              {t('demos.download')}
            </Button>
            <Button variant="tertiary" data-size="sm" onClick={() => void actions.copy(demo.id)}>
              {t('demos.copyLink')}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
};

const Library = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const actions = useActions(api);
  const [state, retry] = useAsync((signal) => api.demos(signal), [api]);
  const [query, setQuery] = useState('');
  const [app, setApp] = useState<DemoApp | 'all'>('all');
  const [audience, setAudience] = useState<DemoAudience | 'all'>('all');
  const [shown, setShown] = useState<DemoState | 'all'>('all');

  const rated = useMemo(
    () =>
      state.status === 'ready'
        ? state.data.data.map((demo) => ({ demo, state: demoState(demo, state.data.genkiVersion) }))
        : [],
    [state],
  );
  const recording = rated.some((r) => r.demo.open);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(retry, pollMs);
    return () => clearInterval(timer);
  }, [recording, retry]);

  const header = (
    <>
      <PageHeader
        eyebrow={t('shell.groupPlatform')}
        title={t('demos.title')}
        intro={t('demos.intro')}
      />
      <div className="actions-row demo-header-actions">
        <Button asChild data-size="sm">
          <a href="#/demos?new=1">{t('demos.newDemo')}</a>
        </Button>
        <Button asChild variant="secondary" data-size="sm">
          <a href="#/demos?settings=1">{t('demos.settings')}</a>
        </Button>
      </div>
    </>
  );
  if (state.status === 'loading')
    return (
      <>
        {header}
        <Loading label={t('demos.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );

  const needle = query.trim().toLocaleLowerCase('nb');
  const filtered = rated.filter(
    (r) =>
      (app === 'all' || r.demo.app === app) &&
      (audience === 'all' || r.demo.audience.includes(audience)) &&
      (needle === '' ||
        `${r.demo.title} ${r.demo.description}`.toLocaleLowerCase('nb').includes(needle)),
  );
  const visible = filtered.filter((r) => shown === 'all' || r.state === shown);
  const count = (s: DemoState) => filtered.filter((r) => r.state === s).length;
  const outdated = rated.filter((r) => r.state === 'outdated').length;

  return (
    <>
      {header}
      <Flash message={actions.flash.message} />
      {outdated > 0 && state.data.genkiVersion ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="xs">
            {outdated === 1
              ? t('demos.outdatedOneTitle')
              : t('demos.outdatedTitle', { count: outdated })}
          </Heading>
          <Paragraph>
            {t(state.data.recorder === 'job' ? 'demos.outdatedTextJob' : 'demos.outdatedText', {
              version: state.data.genkiVersion,
            })}
          </Paragraph>
        </Alert>
      ) : null}
      {rated.length === 0 ? (
        <EmptyState title={t('demos.noneTitle')}>
          <Paragraph>{t('demos.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        <>
          <div className="filters">
            <Textfield
              className="search-field"
              label={t('demos.search')}
              type="search"
              placeholder={t('demos.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="field">
              <Label htmlFor="demo-area">{t('demos.area')}</Label>
              <Select
                id="demo-area"
                value={app}
                onChange={(e) => setApp(e.target.value as DemoApp | 'all')}
              >
                <Select.Option value="all">{t('demos.allAreas')}</Select.Option>
                {(Object.keys(appLabel) as DemoApp[]).map((a) => (
                  <Select.Option key={a} value={a}>
                    {t(appLabel[a])}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div className="field">
              <Label htmlFor="demo-audience">{t('demos.audience')}</Label>
              <Select
                id="demo-audience"
                value={audience}
                onChange={(e) => setAudience(e.target.value as DemoAudience | 'all')}
              >
                <Select.Option value="all">{t('demos.allAudiences')}</Select.Option>
                {(Object.keys(audienceLabel) as DemoAudience[]).map((a) => (
                  <Select.Option key={a} value={a}>
                    {t(audienceLabel[a])}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <Fieldset>
              <FieldsetLegend>{t('demos.state')}</FieldsetLegend>
              <div className="chips">
                <Chip.Radio
                  name="demo-state"
                  checked={shown === 'all'}
                  onChange={() => setShown('all')}
                >
                  {t('demos.stateAll', { count: filtered.length })}
                </Chip.Radio>
                {states
                  .filter((s) => count(s) > 0 || shown === s)
                  .map((s) => (
                    <Chip.Radio
                      key={s}
                      name="demo-state"
                      checked={shown === s}
                      onChange={() => setShown(s)}
                    >
                      {t('demos.stateCount', { state: t(stateLabel[s]), count: count(s) })}
                    </Chip.Radio>
                  ))}
              </div>
            </Fieldset>
          </div>
          <VisuallyHidden>
            <Heading level={2}>{t('demos.listHeading', { count: visible.length })}</Heading>
          </VisuallyHidden>
          {visible.length === 0 ? (
            <EmptyState title={t('demos.noMatchTitle')}>
              <Paragraph>{t('demos.noMatchText')}</Paragraph>
            </EmptyState>
          ) : (
            <ul className="demo-grid">
              {visible.map((r) => (
                <DemoCard
                  key={r.demo.id}
                  api={api}
                  demo={r.demo}
                  state={r.state}
                  actions={actions}
                />
              ))}
            </ul>
          )}
          <Paragraph data-size="sm" className="muted">
            {t('demos.footer')}
          </Paragraph>
        </>
      )}
    </>
  );
};

type Media =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; video: string; track?: string; cues: number[] };

const useMedia = (api: ApiClient, recording: DemoRecording | undefined) => {
  const [media, setMedia] = useState<Media>({ status: 'loading' });
  useEffect(() => {
    if (!recording) return;
    const controller = new AbortController();
    const urls: string[] = [];
    setMedia({ status: 'loading' });
    void (async () => {
      try {
        const video = await api.demoFile(recording.id, 'demo.mp4', controller.signal);
        const srt = hasFile(recording, 'demo.srt')
          ? await (await api.demoFile(recording.id, 'demo.srt', controller.signal)).text()
          : undefined;
        if (controller.signal.aborted) return;
        const videoUrl = URL.createObjectURL(video);
        urls.push(videoUrl);
        const track = srt
          ? URL.createObjectURL(new Blob([asVtt(srt)], { type: 'text/vtt' }))
          : undefined;
        if (track) urls.push(track);
        setMedia({
          status: 'ready',
          video: videoUrl,
          ...(track ? { track } : {}),
          cues: srt ? cueStarts(srt) : [],
        });
      } catch {
        if (!controller.signal.aborted) setMedia({ status: 'error' });
      }
    })();
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [api, recording?.id]);
  return media;
};

const resultText = (r: DemoRecording, t: ReturnType<typeof useT>) =>
  r.status === 'recorded'
    ? t('demos.resultRecorded', { length: clock(r.seconds ?? 0) })
    : r.status === 'failed'
      ? t('demos.resultFailed', { step: r.failure?.step ?? 0 })
      : r.status === 'cancelled'
        ? t('demos.resultCancelled')
        : r.status === 'queued'
          ? t('demos.resultQueued')
          : t('demos.resultRunning');

const RecordActions = ({
  demo,
  recorder,
  busy,
  onAsk,
}: {
  api: ApiClient;
  demo: Demo;
  recorder: RecorderMode;
  busy: boolean;
  onAsk: () => void;
}) => {
  const t = useT();
  return (
    <div className="stack-sm demo-record-actions">
      <div className="actions-row">
        {recorder === 'job' ? (
          <Button data-size="sm" onClick={onAsk} disabled={busy}>
            {t('demos.recordAgain')}
          </Button>
        ) : null}
        <Button asChild variant="secondary" data-size="sm">
          <a href={editHref(demo.id)}>{t('demos.edit')}</a>
        </Button>
      </div>
      {recorder === 'workflow' ? (
        <Paragraph data-size="sm" className="muted">
          {t('demos.workflowOnly', { id: demo.id })}{' '}
          <Link href={workflowUrl} target="_blank" rel="noreferrer">
            {t('demos.workflowLink')}
          </Link>
        </Paragraph>
      ) : null}
    </div>
  );
};

const Detail = ({ api, id }: { api: ApiClient; id: string }) => {
  const t = useT();
  const f = useFormat();
  const actions = useActions(api);
  const [state, retry] = useAsync((signal) => api.demo(id, signal), [api, id]);
  const detail = state.status === 'ready' ? state.data : undefined;
  const full = detail?.recordings.filter((r) => r.upTo === undefined) ?? [];
  const recorded = full.find((r) => r.status === 'recorded');
  const open = detail?.recordings.find(isOpen);
  const media = useMedia(api, recorded);
  const video = useRef<HTMLVideoElement>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(retry, pollMs);
    return () => clearInterval(timer);
  }, [open?.id, retry]);

  const crumbs = (title?: string) => <Crumbs title={title} />;

  if (state.status === 'loading')
    return (
      <>
        {crumbs()}
        <Loading label={t('demos.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {crumbs()}
        {(state.error as { status?: number }).status === 404 ? (
          <EmptyState title={t('demos.notFoundTitle')}>
            <Paragraph>{t('demos.notFoundText')}</Paragraph>
          </EmptyState>
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </>
    );

  const demo: DemoDetail = state.data;
  const latest = full.find((r) => !isOpen(r) && r.status !== 'cancelled');
  const current = demoState(
    { ...demo, ...(latest ? { latest } : {}), ...(recorded ? { recorded } : {}) },
    demo.genkiVersion,
  );
  const cues = media.status === 'ready' ? media.cues : [];
  const timed = recorded?.demoVersion === demo.version && cues.length === demo.steps.length;
  const jump = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    void video.current.play()?.catch(() => undefined);
  };

  return (
    <>
      {crumbs(demo.title)}
      <Flash message={actions.flash.message} />
      <div className="page-header">
        <div className="demo-tags">
          <StateTag state={current} />
          <Tag data-size="sm">{t(appLabel[demo.app])}</Tag>
          {demo.audience.map((a) => (
            <Tag key={a} data-size="sm">
              {t(audienceLabel[a])}
            </Tag>
          ))}
        </div>
        <Heading level={1} data-size="lg">
          {demo.title}
        </Heading>
        {demo.description ? <p className="intro">{demo.description}</p> : null}
        <Paragraph data-size="sm" className="muted">
          {t('demos.changedBy')}:{' '}
          {t('demos.changedByText', {
            who: actorName(demo.updatedBy),
            when: f.dateTime(new Date(demo.updatedAt), 'medium'),
          })}
        </Paragraph>
      </div>
      <RecordActions
        api={api}
        demo={demo}
        recorder={demo.recorder ?? 'workflow'}
        busy={Boolean(open)}
        onAsk={() => setAsking(true)}
      />
      <ReasonDialog
        open={asking}
        title={t('demos.recordAgainTitle', { title: demo.title })}
        text={t('demos.recordAgainText')}
        confirmLabel={t('demos.recordAgainConfirm')}
        onClose={() => setAsking(false)}
        onConfirm={async (reason) => {
          const started = await requestRecording(api, demo.id, reason, t);
          navigate('/demos', { recording: started.id });
        }}
      />
      <div className="demo-detail">
        <div className="stack">
          {open ? (
            <Alert data-color="info">
              {progressText(open, t)}{' '}
              <Link href={recordingHref(open.id)}>{t('demos.followRecording')}</Link>
            </Alert>
          ) : null}
          {current === 'failed' && latest?.failure ? (
            <Alert data-color="warning">
              {recorded
                ? t('demos.latestFailed', { step: latest.failure.step, steps: latest.steps })
                : t('demos.failedNoGood', { step: latest.failure.step, steps: latest.steps })}{' '}
              <Link href={recordingHref(latest.id)}>{t('demos.seeFailure')}</Link>
            </Alert>
          ) : null}
          {!recorded ? (
            <Alert data-color="info">{t('demos.noVideo')}</Alert>
          ) : media.status === 'loading' ? (
            <Loading label={t('demos.videoLoading')} />
          ) : media.status === 'error' ? (
            <Alert data-color="danger">{t('demos.videoFailed')}</Alert>
          ) : (
            <video
              ref={video}
              className="demo-video"
              controls
              preload="metadata"
              src={media.video}
              aria-label={t('demos.videoLabel', { title: demo.title })}
            >
              {media.track ? (
                <track
                  kind="subtitles"
                  src={media.track}
                  srcLang={demo.language.slice(0, 2)}
                  label={demo.language}
                  default
                />
              ) : null}
            </video>
          )}
          <section aria-labelledby="demo-history" className="stack">
            <Heading level={2} data-size="sm" id="demo-history">
              {t('demos.history')}
            </Heading>
            {demo.recordings.length === 0 ? (
              <Paragraph>{t('demos.historyEmpty')}</Paragraph>
            ) : (
              <TableRegion label={t('demos.history')}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell>{t('demos.colDate')}</TableHeaderCell>
                      <TableHeaderCell>{t('demos.colGenki')}</TableHeaderCell>
                      <TableHeaderCell>{t('demos.colDemoVersion')}</TableHeaderCell>
                      <TableHeaderCell>{t('demos.colKind')}</TableHeaderCell>
                      <TableHeaderCell>{t('demos.colResult')}</TableHeaderCell>
                      <TableHeaderCell>
                        <VisuallyHidden>{t('demos.openRecording')}</VisuallyHidden>
                      </TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {demo.recordings.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>{f.dateTime(new Date(r.startedAt), 'medium')}</TableCell>
                        <TableCell>{r.genkiVersion}</TableCell>
                        <TableCell>{r.demoVersion}</TableCell>
                        <TableCell>
                          {r.upTo === undefined
                            ? t('demos.kindFull')
                            : t('demos.trialOf', { upTo: r.upTo })}
                        </TableCell>
                        <TableCell>{resultText(r, t)}</TableCell>
                        <TableCell>
                          <Link
                            href={recordingHref(r.id)}
                            aria-label={`${t('demos.openRecording')}: ${f.dateTime(new Date(r.startedAt), 'medium')}`}
                          >
                            {t('demos.openRecording')}
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
            )}
          </section>
        </div>
        <aside className="stack">
          <section aria-labelledby="demo-narration" className="card stack">
            <Heading level={2} data-size="sm" id="demo-narration">
              {t('demos.narration')}
            </Heading>
            {timed ? <Paragraph data-size="sm">{t('demos.narrationHelp')}</Paragraph> : null}
            <ol className="demo-steps">
              {demo.steps.map((step, i) => {
                const at = cues[i];
                return (
                  <li key={i}>
                    {timed && at !== undefined && media.status === 'ready' ? (
                      <button
                        type="button"
                        className="demo-step"
                        aria-label={t('demos.jumpTo', { time: clock(at), text: step.say })}
                        onClick={() => jump(at)}
                      >
                        <span className="demo-step-time">{clock(at)}</span>
                        <span>{step.say}</span>
                      </button>
                    ) : (
                      <span className="demo-step">{step.say}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          {recorded ? (
            <section aria-labelledby="demo-share" className="card stack">
              <Heading level={2} data-size="sm" id="demo-share">
                {t('demos.shareTitle')}
              </Heading>
              <div className="demo-actions">
                <Button
                  variant="secondary"
                  data-size="sm"
                  onClick={() => void actions.download(recorded, 'demo.mp4')}
                >
                  {t('demos.downloadMp4')}
                </Button>
                {hasFile(recorded, 'demo.srt') ? (
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    onClick={() => void actions.download(recorded, 'demo.srt')}
                  >
                    {t('demos.downloadSrt')}
                  </Button>
                ) : null}
                <Button
                  variant="tertiary"
                  data-size="sm"
                  onClick={() => void actions.copy(demo.id)}
                >
                  {t('demos.copyLink')}
                </Button>
              </div>
              <Paragraph data-size="sm" className="muted">
                {t('demos.shareHelp')}
              </Paragraph>
            </section>
          ) : null}
          {recorded ? (
            <section aria-labelledby="demo-about" className="card stack">
              <Heading level={2} data-size="sm" id="demo-about">
                {t('demos.about')}
              </Heading>
              <dl className="demo-about">
                <dt>{t('demos.genkiVersion')}</dt>
                <dd>{recorded.genkiVersion}</dd>
                <dt>{t('demos.length')}</dt>
                <dd>
                  {t('demos.lengthSteps', {
                    length: clock(recorded.seconds ?? 0),
                    steps: recorded.steps,
                  })}
                </dd>
                <dt>{t('demos.voice')}</dt>
                <dd>{recorded.voice ?? t('demos.silent')}</dd>
                <dt>{t('demos.demoVersion')}</dt>
                <dd>{recorded.demoVersion}</dd>
              </dl>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
};

export const Demos = ({
  api,
  params = new URLSearchParams(),
  demo = params.get('demo') ?? undefined,
}: {
  api: ApiClient;
  params?: URLSearchParams;
  demo?: string | undefined;
}) => {
  const recording = params.get('recording');
  const edit = params.get('edit');
  if (params.get('settings')) return <DemoSettingsScreen api={api} />;
  if (params.get('new')) return <DemoEditor api={api} />;
  if (edit)
    return <DemoEditor api={api} id={edit} step={Number(params.get('step')) || undefined} />;
  if (recording) return <RecordingScreen api={api} id={recording} />;
  return demo ? <Detail api={api} id={demo} /> : <Library api={api} />;
};
