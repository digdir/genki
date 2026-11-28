import { Button, Heading, Link, Paragraph, Select } from '@digdir/designsystemet-react';
import { filmCostUsd } from '@genai/contracts';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient, Demo, DemoApp, DemoAudience, RecorderMode } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type Format, type PlainKey, type T } from '../../i18n';
import { EmptyState, ErrorState, Loading } from '../../states';
import { estimateSeconds } from './Editor';
import {
  appLabel,
  audienceLabel,
  clock,
  demoHref,
  demoState,
  hasFile,
  progressText,
  recordingHref,
  RecordingTag,
  states,
  StateTag,
  stepsDone,
  useFileUrl,
  type DemoState,
} from './shared';

const pollMs = 3000;

type Sort = 'recent' | 'title' | 'cost';

const stateFilterLabel: Record<DemoState, PlainKey> = {
  ready: 'demos.stateReady',
  outdated: 'demos.stateOutdated',
  failed: 'demos.stateFailed',
  none: 'studio.stateDraft',
};

const usd = (f: Format, value: number) => f.decimal(value, 2);

const spentOf = (demo: Demo) => demo.recorded?.costUsd ?? demo.open?.costUsd ?? 0;

const costText = (demo: Demo, state: DemoState, t: T, f: Format) => {
  const open = demo.open;
  if (open)
    return open.costUsd !== undefined
      ? t('studio.costSpentSoFar', { spent: usd(f, open.costUsd) })
      : open.costCapUsd !== undefined
        ? t('studio.costCapOnly', { cap: open.costCapUsd })
        : '';
  const film = demo.recorded ?? (state === 'failed' ? demo.latest : undefined);
  if (!film)
    return t('studio.costEstimate', {
      usd: usd(
        f,
        filmCostUsd(
          demo.steps.map((s) => s.say),
          demo.voice,
        ),
      ),
    });
  if (film.costCapUsd === undefined) return t('studio.costNone');
  return film.costUsd !== undefined
    ? t('studio.costOf', { spent: usd(f, film.costUsd), cap: film.costCapUsd })
    : t('studio.costCapOnly', { cap: film.costCapUsd });
};

const metaText = (demo: Demo, state: DemoState, t: T, f: Format) => {
  const editions = demo.editions ?? (demo.recorded ? 1 : 0);
  if (demo.open?.upTo) return t('demos.trialOf', { upTo: demo.open.upTo });
  if (demo.open) return t('studio.edition', { n: editions + 1 });
  if (state === 'failed' && demo.latest?.failure)
    return t('studio.stoppedAt', { step: demo.latest.failure.step, steps: demo.latest.steps });
  if (!demo.recorded) return t('demos.stateNone');
  return t('studio.editionDated', {
    n: editions,
    date: f.date(demo.recorded.finishedAt ?? demo.recorded.startedAt, 'medium'),
  });
};

const Poster = ({
  api,
  demo,
  title,
  recorder,
}: {
  api: ApiClient;
  demo: Demo;
  title: string;
  recorder: RecorderMode | undefined;
}) => {
  const t = useT();
  const recorded = demo.recorded;
  const poster = useFileUrl(
    api,
    hasFile(recorded, 'poster.jpg') ? recorded?.id : undefined,
    'poster.jpg',
  );
  const open = demo.open;
  const length = recorded?.seconds;
  return (
    <a
      className="film-poster"
      href={open ? recordingHref(open.id) : demoHref(demo.id)}
      aria-label={open ? t('demos.followRecording') : t('studio.openFilm', { title })}
    >
      {poster.status === 'ready' ? (
        <img src={poster.url} alt="" />
      ) : (
        <span className="film-card-title" aria-hidden="true">
          <span>{title}</span>
        </span>
      )}
      {demo.exampleData ? <span className="film-example">{t('studio.exampleData')}</span> : null}
      {open ? (
        <span className="film-live">
          {progressText(open, t, recorder)}
          <span className="film-live-bar">
            <span style={{ width: `${(100 * stepsDone(open)) / Math.max(1, open.steps)}%` }} />
          </span>
        </span>
      ) : (
        <span className="film-length">
          {length !== undefined
            ? clock(length)
            : t('studio.about', { length: clock(estimateSeconds(demo)) })}
        </span>
      )}
    </a>
  );
};

const FilmCard = ({
  api,
  demo,
  state,
  recorder,
}: {
  api: ApiClient;
  demo: Demo;
  state: DemoState;
  recorder: RecorderMode | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <li className="film-card">
      <Poster api={api} demo={demo} title={demo.title} recorder={recorder} />
      <div className="film-card-body">
        <Heading level={3} data-size="2xs">
          <Link href={demoHref(demo.id)} className="film-card-link">
            {demo.title}
          </Link>
        </Heading>
        <div className="film-card-row">
          {demo.open ? <RecordingTag /> : <StateTag state={state} />}
          <span className="muted">{metaText(demo, state, t, f)}</span>
        </div>
        <div className="film-card-foot">
          <span>
            {[
              appLabel[demo.app] ? '' : demo.app,
              demo.audience.map((a) => t(audienceLabel[a])).join(', '),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="num">{costText(demo, state, t, f)}</span>
        </div>
      </div>
    </li>
  );
};

const Clapper = () => (
  <svg width="96" height="80" viewBox="0 0 96 80" aria-hidden="true" className="film-empty-art">
    <rect x="8" y="26" width="80" height="48" rx="6" className="art-body" />
    <path d="M8 26 L84 8 L88 22" className="art-board" />
    <path d="M20 22.5 28 12M40 17.8 48 7.3M60 13 68 3" className="art-stripes" />
    <path d="M42 40v20l16-10z" className="art-play" />
  </svg>
);

const Empty = () => {
  const t = useT();
  return (
    <div className="film-empty">
      <Clapper />
      <Heading level={2} data-size="sm">
        {t('studio.emptyTitle')}
      </Heading>
      <Paragraph className="muted">{t('studio.emptyText')}</Paragraph>
      <Button asChild data-size="sm">
        <a href="#/demos?new=1">{t('studio.newFilm')}</a>
      </Button>
    </div>
  );
};

const lastRecorded = (demo: Demo) =>
  demo.recorded?.finishedAt ?? demo.recorded?.startedAt ?? demo.open?.startedAt ?? '';

export const Library = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.demos(signal), [api]);
  const [app, setApp] = useState<DemoApp | 'all'>('all');
  const [audience, setAudience] = useState<DemoAudience | 'all'>('all');
  const [shown, setShown] = useState<DemoState | 'all'>('all');
  const [sort, setSort] = useState<Sort>('recent');

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

  const header = (actions: boolean) => (
    <div className="film-head">
      <Heading level={1} data-size="md">
        {t('demos.title')}
      </Heading>
      {actions ? (
        <div className="actions-row">
          <Button asChild variant="secondary" data-size="sm">
            <a href="#/demos?settings=1">{t('demos.settings')}</a>
          </Button>
          <Button asChild data-size="sm">
            <a href="#/demos?new=1">{t('studio.newFilm')}</a>
          </Button>
        </div>
      ) : null}
    </div>
  );
  if (state.status === 'loading')
    return (
      <>
        {header(true)}
        <Loading label={t('demos.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header(true)}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  if (rated.length === 0)
    return (
      <>
        {header(false)}
        <Empty />
      </>
    );

  const filtered = rated.filter(
    (r) =>
      (app === 'all' || r.demo.app === app) &&
      (audience === 'all' || r.demo.audience.includes(audience)),
  );
  const visible = filtered
    .filter((r) => shown === 'all' || r.state === shown)
    .sort((a, b) =>
      sort === 'title'
        ? a.demo.title.localeCompare(b.demo.title, 'nb')
        : sort === 'cost'
          ? spentOf(b.demo) - spentOf(a.demo)
          : lastRecorded(b.demo).localeCompare(lastRecorded(a.demo)),
    );
  const count = (s: DemoState) => filtered.filter((r) => r.state === s).length;

  return (
    <>
      {header(true)}
      <div className="film-filters">
        <div className="seg" role="group" aria-label={t('demos.state')}>
          <button type="button" aria-pressed={shown === 'all'} onClick={() => setShown('all')}>
            {t('demos.stateAll', { count: filtered.length })}
          </button>
          {states
            .filter((s) => count(s) > 0 || shown === s)
            .map((s) => (
              <button key={s} type="button" aria-pressed={shown === s} onClick={() => setShown(s)}>
                {t('demos.stateCount', { state: t(stateFilterLabel[s]), count: count(s) })}
              </button>
            ))}
        </div>
        <div className="film-selects">
          <Select
            aria-label={t('demos.area')}
            data-size="sm"
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
          <Select
            aria-label={t('demos.audience')}
            data-size="sm"
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
          <Select
            aria-label={t('studio.sort')}
            data-size="sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <Select.Option value="recent">{t('studio.sortRecent')}</Select.Option>
            <Select.Option value="title">{t('studio.sortTitle')}</Select.Option>
            <Select.Option value="cost">{t('studio.sortCost')}</Select.Option>
          </Select>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState title={t('demos.noMatchTitle')}>
          <Paragraph>{t('demos.noMatchText')}</Paragraph>
        </EmptyState>
      ) : (
        <ul className="film-grid" aria-label={t('demos.listHeading', { count: visible.length })}>
          {visible.map((r) => (
            <FilmCard
              key={r.demo.id}
              api={api}
              demo={r.demo}
              state={r.state}
              recorder={state.status === 'ready' ? state.data.recorder : undefined}
            />
          ))}
        </ul>
      )}
    </>
  );
};
