import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Popover,
  Select,
  Switch,
} from '@digdir/designsystemet-react';
import {
  approvalUsd,
  filmCostUsd,
  pageProblem,
  sceneProblem,
  voiceNeedsApproval,
  type DemoScene,
} from '@genai/contracts';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient, DemoDetail, DemoRecording, DemoStep } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { EmptyState, ErrorState, Loading } from '../../states';
import { DialogError, Flash, ReasonDialog } from '../../ui';
import { problemText, specOnly } from './Editor';
import { chapterCardSeconds, chaptersOf, isFilmLook, scenesOf, type Chapter } from './film';
import {
  canRecord,
  clock,
  CostApproval,
  demoState,
  editHref,
  editionsOf,
  hasFile,
  isOpen,
  progressText,
  recordingHref,
  requestRecording,
  scoreOf,
  StateTag,
  toneOf,
  useActions,
  useFileUrl,
  workflowUrl,
  type DemoState,
  type Edition,
} from './shared';
import { StudioDirector } from './StudioDirector';
import { soundHref, StudioInspector } from './StudioInspector';
import { clockTenths, sceneKindLabel, StudioTimeline, type Selection } from './StudioTimeline';
import { useFilm } from './useFilm';

const pollMs = 3000;
const narrowBelow = 860;
const speeds = [0.5, 1, 1.5] as const;

const musicLabel = { pulse: 'studio.musicPulse' } as const;

const useNarrow = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const check = () => setNarrow(box.clientWidth > 0 && box.clientWidth < narrowBelow);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return [ref, narrow] as const;
};

const EditableLine = ({
  value,
  label,
  onChange,
  onFocus,
}: {
  value: string;
  label: string;
  onChange: (text: string) => void;
  onFocus: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && box.textContent !== value && document.activeElement !== box) box.textContent = value;
  }, [value]);
  return (
    <div
      ref={ref}
      className="script-text"
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={onFocus}
      onInput={(e) => onChange(e.currentTarget.textContent ?? '')}
    />
  );
};

const chapterAt = (chapters: Chapter[], at: number) =>
  chapters.find((c) => at >= c.from && at < c.to) ?? chapters.at(-1);

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      d={d}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
);

const Review = ({
  api,
  demo,
  edition,
  state,
  chapters,
  poster,
  video,
}: {
  api: ApiClient;
  demo: DemoDetail;
  edition: Edition | undefined;
  state: DemoState;
  chapters: Chapter[];
  poster: string | undefined;
  video: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const actions = useActions(api);
  const player = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const recording = edition?.recording;
  const lines = recording?.lines ?? [];
  const weak = lines.filter((l) => l.score > 0);
  const current = chapterAt(chapters, now);
  const jump = (at: number) => {
    if (!player.current) return;
    player.current.currentTime = at;
    void player.current.play()?.catch(() => undefined);
  };
  return (
    <div className="review">
      <Flash message={actions.flash.message} />
      <Alert data-size="sm" data-color="info" className="review-note">
        {t('studio.narrowNote')}
      </Alert>
      <div className="stage review-stage">
        {video ? (
          <video
            ref={player}
            src={video}
            poster={poster}
            controls
            playsInline
            preload="metadata"
            aria-label={t('demos.videoLabel', { title: demo.title })}
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          />
        ) : (
          <span className="stage-empty">{t('studio.notRecorded')}</span>
        )}
      </div>
      <div className="review-pad">
        <div>
          <Heading level={1} data-size="sm">
            {demo.title}
          </Heading>
          <div className="review-meta">
            <StateTag state={state} />
            {edition && recording ? (
              <span className="muted small">
                {[
                  recording.seconds !== undefined ? clock(recording.seconds) : '',
                  t('studio.edition', { n: edition.n }),
                  f.date(recording.finishedAt ?? recording.startedAt, 'medium'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
          </div>
        </div>
        {recording ? (
          <div className="actions-row">
            <Button data-size="sm" onClick={() => jump(now)}>
              {t('demos.play')}
            </Button>
            <Button
              data-size="sm"
              variant="secondary"
              onClick={() => void actions.download(recording, 'demo.mp4')}
            >
              {t('demos.download')}
            </Button>
            <Button data-size="sm" variant="secondary" onClick={() => void actions.copy(demo.id)}>
              {t('demos.copyLink')}
            </Button>
          </div>
        ) : null}
        {chapters.length ? (
          <>
            <Heading level={2} data-size="2xs">
              {t('studio.chapters')}
            </Heading>
            <ul className="review-chapters">
              {chapters.map((c) => (
                <li key={c.n}>
                  <button
                    type="button"
                    aria-current={c === current ? 'true' : undefined}
                    onClick={() => jump(c.from)}
                  >
                    <span className="num">{clock(c.from)}</span>
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {lines.length ? (
          <details>
            <summary>
              {t('studio.qualityPerLine')}{' '}
              <span className="muted">{t('studio.qualityWeak', { count: weak.length })}</span>
            </summary>
            <ul className="review-lines">
              {lines.map((l) => (
                <li key={l.step}>
                  <span className="muted num">{t('studio.lineShort', { n: l.step })}</span>
                  <span>{demo.steps[l.step - 1]?.say}</span>
                  <span className={`score is-${toneOf(l.score)}`}>{l.score}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
};

const SharePopover = ({
  api,
  demo,
  recording,
}: {
  api: ApiClient;
  demo: DemoDetail;
  recording: DemoRecording | undefined;
}) => {
  const t = useT();
  const actions = useActions(api);
  return (
    <>
      <Flash message={actions.flash.message} />
      <Popover.TriggerContext>
        <Popover.Trigger variant="secondary" data-size="sm">
          {t('studio.share')}
        </Popover.Trigger>
        <Popover placement="bottom-end" data-size="sm">
          <div className="share-menu">
            <Button variant="tertiary" data-size="sm" onClick={() => void actions.copy(demo.id)}>
              {t('demos.copyLink')}
            </Button>
            {recording ? (
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => void actions.download(recording, 'demo.mp4')}
              >
                {t('demos.downloadMp4')}
              </Button>
            ) : null}
            {recording && hasFile(recording, 'demo.srt') ? (
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => void actions.download(recording, 'demo.srt')}
              >
                {t('demos.downloadSrt')}
              </Button>
            ) : null}
          </div>
        </Popover>
      </Popover.TriggerContext>
    </>
  );
};

const StudioView = ({
  api,
  demo,
  chosen,
  retry,
}: {
  api: ApiClient;
  demo: DemoDetail;
  chosen: string | undefined;
  retry: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const editions = useMemo(() => editionsOf(demo.recordings), [demo.recordings]);
  const [picked, setPicked] = useState(chosen);
  const edition = editions.find((e) => e.recording.id === picked) ?? editions.at(-1);
  const recording = edition?.recording;
  const open = demo.recordings.find(isOpen);
  const latest = demo.recordings.find(
    (r) => r.upTo === undefined && !isOpen(r) && r.status !== 'cancelled',
  );
  const newest = editions.at(-1);
  const current = demoState(
    { ...demo, ...(latest ? { latest } : {}), ...(newest ? { recorded: newest.recording } : {}) },
    demo.genkiVersion,
  );
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const says = useMemo(
    () => demo.steps.map((s, i) => drafts[i + 1] ?? s.say),
    [demo.steps, drafts],
  );
  const stored = useMemo(() => demo.steps.map((s) => s.say), [demo.steps]);
  const [sceneDrafts, setSceneDrafts] = useState<Record<number, DemoScene>>({});
  const [pageDrafts, setPageDrafts] = useState<Record<number, string>>({});
  const looks = useMemo(
    () =>
      demo.steps.map((s, i) => {
        const scene = sceneDrafts[i + 1] ?? s.scene;
        const page = pageDrafts[i + 1] ?? s.page;
        return { ...(scene ? { scene } : {}), ...(page ? { page } : {}), chapter: s.chapter };
      }),
    [demo.steps, sceneDrafts, pageDrafts],
  );
  const editedLines = says.filter((s, i) => s !== stored[i]).length;
  const editedLooks = new Set([...Object.keys(sceneDrafts), ...Object.keys(pageDrafts)]).size;
  const edited = editedLines + editedLooks;
  const invalid = looks.some(
    (l, i) =>
      (sceneDrafts[i + 1] !== undefined && l.scene !== undefined && sceneProblem(l.scene)) ||
      (pageDrafts[i + 1]?.trim() && pageProblem(pageDrafts[i + 1]?.trim())),
  );
  const film = useFilm(api, recording, stored);
  const timeline = film.timeline;
  const timed = timeline !== undefined && timeline.lines.length === demo.steps.length;
  const chapters = useMemo(
    () =>
      timeline && timed
        ? chaptersOf(
            demo.steps.map((s) => s.chapter),
            timeline,
            isFilmLook(timeline) ? chapterCardSeconds : 0,
          )
        : [],
    [timeline, timed, demo.steps],
  );
  const scenes = useMemo(
    () =>
      timeline && timed
        ? scenesOf(
            timeline,
            {
              ...(demo.intro ? { intro: demo.intro.title } : {}),
              ...(demo.outro ? { outro: demo.outro.title } : {}),
            },
            looks,
          )
        : [],
    [timeline, timed, demo.intro, demo.outro, looks],
  );
  const video = useFileUrl(api, recording?.id, recording ? 'demo.mp4' : undefined);
  const poster = useFileUrl(
    api,
    hasFile(recording, 'poster.jpg') ? recording?.id : undefined,
    'poster.jpg',
  );
  const player = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [selection, setSelection] = useState<Selection>({ kind: 'line', step: 1 });
  const [tab, setTab] = useState<'props' | 'director'>('props');
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [flash, setFlash] = useState<string | undefined>();
  const [box, narrow] = useNarrow();
  const length = timeline?.length ?? recording?.seconds ?? 0;
  const music = demo.music ? t(musicLabel[demo.music]) : undefined;
  const modelVoice = voiceNeedsApproval(demo.voice);
  const costCap = approvalUsd(filmCostUsd(says, demo.voice));

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(retry, pollMs);
    return () => clearInterval(timer);
  }, [open?.id, retry]);

  useEffect(() => {
    if (player.current) player.current.playbackRate = speed;
  }, [speed, video.status]);

  const seek = (seconds: number) => {
    setNow(seconds);
    if (player.current) player.current.currentTime = seconds;
  };
  const select = (next: Selection, at?: number) => {
    setSelection(next);
    setTab('props');
    if (at !== undefined) seek(at);
  };
  const lineAtNow = timeline?.lines.find((l) => now >= l.from && now < l.to)?.step;
  const cue = film.cues.find((c) => now >= c.from && now < c.to);
  const chapterNow = chapterAt(chapters, now);
  const toggle = () => {
    const v = player.current;
    if (!v) return;
    if (v.paused) void v.play()?.catch(() => undefined);
    else v.pause();
  };
  const jumpLine = (direction: 1 | -1) => {
    const lines = timeline?.lines ?? [];
    const target =
      direction > 0
        ? (lines.find((l) => l.from > now + 0.05) ?? lines.at(-1))
        : ([...lines].reverse().find((l) => l.from < now - 0.5) ?? lines[0]);
    if (target) seek(target.from);
  };
  const [draftOf, setDraftOf] = useState<{ version: number; steps: DemoStep[] }>();
  const base = draftOf ?? demo;
  const started = () => setDraftOf((d) => d ?? { version: demo.version, steps: demo.steps });
  const setSay = (step: number, text: string) => {
    started();
    setDrafts((d) => ({ ...d, [step]: text }));
  };
  const setScene = (step: number, scene: DemoScene) => {
    started();
    setSceneDrafts((d) => ({ ...d, [step]: scene }));
  };
  const setPage = (step: number, page: string) => {
    started();
    setPageDrafts((d) => ({ ...d, [step]: page }));
  };
  const saveScript = async (reason: string) => {
    try {
      await api.saveDemo(
        demo.id,
        specOnly({
          ...demo,
          steps: base.steps.map(({ scene: _scene, page: _page, ...step }, i) => {
            const look = looks[i];
            return {
              ...step,
              say: says[i] ?? step.say,
              ...(look?.scene ? { scene: look.scene } : {}),
              ...(look?.page?.trim() ? { page: look.page.trim() } : {}),
            };
          }),
        }),
        reason,
        base.version,
      );
    } catch (error) {
      const text = problemText(error, t);
      if (text) throw new DialogError(text);
      throw error;
    }
    setDrafts({});
    setSceneDrafts({});
    setPageDrafts({});
    setDraftOf(undefined);
  };

  const head = (
    <div className="studio-head">
      <a className="icon-button" href="#/demos" aria-label={t('studio.backToDemos')}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M11 4 6 9l5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
      <div className="studio-title">
        <span className="muted small">{t('demos.title')}</span>
        <Heading level={1} data-size="xs">
          {demo.title}
        </Heading>
      </div>
      {editions.length ? (
        <Select
          aria-label={t('studio.editionLabel')}
          data-size="sm"
          className="studio-edition"
          value={recording?.id ?? ''}
          onChange={(e) => {
            setPicked(e.target.value);
            setNow(0);
            setPlaying(false);
            setSelection((s) => (s.kind === 'line' ? s : { kind: 'line', step: 1 }));
          }}
        >
          {[...editions].reverse().map((e, i) => (
            <Select.Option key={e.recording.id} value={e.recording.id}>
              {[
                t('studio.edition', { n: e.n }),
                f.date(e.recording.finishedAt ?? e.recording.startedAt, 'medium'),
                ...(i === 0 ? [t('studio.current')] : []),
              ].join(' · ')}
            </Select.Option>
          ))}
        </Select>
      ) : null}
      <StateTag state={current} />
      <span className="grow" />
      {recording?.costCapUsd !== undefined ? (
        <div className="cost-meter">
          <span className="muted small">
            {t.rich('studio.costMeter', {
              b: (c) => <b className="num">{c}</b>,
              spent: f.decimal(recording.costUsd ?? 0, 2),
              cap: recording.costCapUsd,
            })}
          </span>
          <span className="meter-bar" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(100, (100 * (recording.costUsd ?? 0)) / recording.costCapUsd)}%`,
              }}
            />
          </span>
        </div>
      ) : null}
      <Button asChild variant="secondary" data-size="sm">
        <a href={soundHref(demo.id)}>{t('studio.voiceAndSound')}</a>
      </Button>
      <SharePopover api={api} demo={demo} recording={recording} />
      {canRecord(demo.recorder) ? (
        <Button data-size="sm" disabled={Boolean(open) || invalid} onClick={() => setAsking(true)}>
          {edited ? t('studio.recordChanges') : t('demos.recordAgain')}
        </Button>
      ) : null}
    </div>
  );

  const notices: ReactNode[] = [];
  if (open)
    notices.push(
      <span key="open">
        {progressText(open, t, demo.recorder)}{' '}
        <Link href={recordingHref(open.id)}>{t('demos.followRecording')}</Link>
      </span>,
    );
  if (current === 'failed' && latest?.failure)
    notices.push(
      <span key="failed">
        {editions.length
          ? t('demos.latestFailed', { step: latest.failure.step, steps: latest.steps })
          : t('demos.failedNoGood', { step: latest.failure.step, steps: latest.steps })}{' '}
        <Link href={recordingHref(latest.id)}>{t('demos.seeFailure')}</Link>
      </span>,
    );
  if (!canRecord(demo.recorder))
    notices.push(
      <span key="workflow">
        {t('demos.workflowOnly', { id: demo.id })}{' '}
        <Link href={workflowUrl} target="_blank" rel="noreferrer">
          {t('demos.workflowLink')}
        </Link>
      </span>,
    );
  if (film.unreadable) notices.push(<span key="edl">{t('demos.studioUnreadable')}</span>);

  const dialogs = (
    <>
      <ReasonDialog
        open={asking}
        title={t('demos.recordAgainTitle', { title: demo.title })}
        text={
          edited
            ? `${t('demos.recordAgainText')} ${t('studio.recordSavesFirst')}`
            : t('demos.recordAgainText')
        }
        confirmLabel={t('demos.recordAgainConfirm')}
        onClose={() => {
          setAsking(false);
          setApproved(false);
        }}
        onConfirm={async (reason) => {
          if (modelVoice && !approved) throw new DialogError(t('demos.costApprovalMissing'));
          if (edited) {
            await saveScript(reason);
            retry();
          }
          const started = await requestRecording(
            api,
            demo.id,
            reason,
            t,
            undefined,
            approved ? costCap : undefined,
          );
          navigate('/demos', { recording: started.id });
        }}
      >
        <CostApproval
          usd={costCap}
          required={modelVoice}
          checked={approved}
          onChange={setApproved}
        />
      </ReasonDialog>
      <ReasonDialog
        open={saving}
        title={t('studio.saveScriptTitle')}
        text={t('studio.saveScriptText')}
        confirmLabel={t('studio.saveScript')}
        onClose={() => setSaving(false)}
        onConfirm={async (reason) => {
          await saveScript(reason);
          setFlash(t('studio.scriptSaved'));
          retry();
        }}
      />
    </>
  );

  if (narrow)
    return (
      <div ref={box} className="studio-page" data-size="sm">
        <Review
          api={api}
          demo={demo}
          edition={edition}
          state={current}
          chapters={chapters}
          poster={poster.status === 'ready' ? poster.url : undefined}
          video={video.status === 'ready' ? video.url : undefined}
        />
      </div>
    );

  const rows: ReactNode[] = [];
  let lastChapter: string | undefined;
  let lastScene: number | undefined;
  const sceneRow = (n: number) => {
    const s = scenes.find((x) => x.n === n);
    if (!s) return null;
    return (
      <div key={`s${n}`} className="script-scene">
        <button type="button" onClick={() => select({ kind: 'scene', n }, s.from)}>
          {t('studio.sceneOf', { n, name: s.name || t(sceneKindLabel[s.kind]) })}
        </button>
        <span className="muted">{t(sceneKindLabel[s.kind])}</span>
      </div>
    );
  };
  const titleScene = scenes.find((s) => s.kind === 'title' && !s.steps.length);
  demo.steps.forEach((step, i) => {
    const n = i + 1;
    if (step.chapter && step.chapter !== lastChapter) {
      lastChapter = step.chapter;
      const chapter = chapters.find((c) => c.steps.includes(n));
      rows.push(
        <Heading key={`c${n}`} level={2} data-size="2xs" className="script-chapter">
          {chapter ? `${chapter.n}. ${step.chapter}` : step.chapter}
        </Heading>,
      );
    }
    if (n === 1 && titleScene) rows.push(sceneRow(titleScene.n));
    const scene = scenes.find((s) => s.steps.includes(n));
    if (scene && scene.n !== lastScene) {
      const card = scenes.find((s) => s.n === scene.n - 1);
      if (card?.kind === 'chapter') rows.push(sceneRow(card.n));
      lastScene = scene.n;
      rows.push(sceneRow(scene.n));
    }
    const line = timed ? timeline?.lines[i] : undefined;
    const score = scoreOf(recording, n);
    const spoken = step.spoken
      ? Object.values(step.spoken).find((v): v is string => Boolean(v))
      : undefined;
    const isSelected = selection.kind === 'line' && selection.step === n;
    rows.push(
      <div
        key={`l${n}`}
        className={`script-line${isSelected ? ' is-selected' : ''}${lineAtNow === n ? ' is-now' : ''}${says[i] !== stored[i] ? ' is-edited' : ''}`}
        onClick={() => select({ kind: 'line', step: n }, isSelected ? undefined : line?.from)}
      >
        <div className="script-meta">
          {line ? <span className="num">{clock(line.from)}</span> : null}
          {score ? <span className={`score is-${toneOf(score.score)}`}>{score.score}</span> : null}
          {says[i] !== stored[i] ? (
            <span className="script-edited">{t('studio.edited')}</span>
          ) : null}
        </div>
        <EditableLine
          value={says[i] ?? ''}
          label={t('studio.shownLine', { n })}
          onChange={(text) => setSay(n, text)}
          onFocus={() => {
            setSelection({ kind: 'line', step: n });
            setTab('props');
          }}
        />
        {spoken ? (
          <div className="script-spoken">
            <b>{t('studio.said')}</b>
            <span>{spoken}</span>
          </div>
        ) : null}
      </div>,
    );
  });
  const closeScene = scenes.find((s) => s.kind === 'close' && !s.steps.length);
  if (closeScene) rows.push(sceneRow(closeScene.n));

  return (
    <div ref={box} className="studio-page" data-size="sm">
      <Flash message={flash ? { text: flash } : undefined} />
      {dialogs}
      <div className={`studio${notices.length ? ' has-notice' : ''}`}>
        {head}
        {notices.length ? (
          <div className="studio-notice" role="status">
            {notices}
          </div>
        ) : null}
        <aside className="studio-script" aria-label={t('studio.script')}>
          <div className="studio-tabs">
            <span className="studio-tab is-on">{t('studio.script')}</span>
            <span className="grow" />
            <Link href={editHref(demo.id)} className="small">
              {t('studio.editSteps')}
            </Link>
          </div>
          <div className="studio-scroll script">{rows}</div>
          <div className="script-foot">
            {edited ? (
              <>
                <span>
                  {editedLooks
                    ? t('studio.changesEdited', { count: edited })
                    : t('studio.linesEdited', { count: edited })}
                </span>
                <span className="grow" />
                <Button data-size="sm" disabled={invalid} onClick={() => setSaving(true)}>
                  {t('studio.saveScript')}
                </Button>
              </>
            ) : (
              <span className="muted">{t('studio.typeToEdit')}</span>
            )}
          </div>
        </aside>
        <div className="studio-center">
          <div className="stage-wrap">
            <div className="stage">
              {video.status === 'ready' ? (
                <video
                  ref={player}
                  src={video.url}
                  poster={poster.status === 'ready' ? poster.url : undefined}
                  playsInline
                  preload="metadata"
                  aria-label={t('demos.videoLabel', { title: demo.title })}
                  onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onClick={toggle}
                />
              ) : (
                <span className="stage-empty">
                  {!recording
                    ? t('studio.notRecorded')
                    : video.status === 'error'
                      ? t('demos.videoFailed')
                      : t('demos.videoLoading')}
                </span>
              )}
              {chapterNow ? <span className="stage-chapter">{chapterNow.name}</span> : null}
              {demo.exampleData ? (
                <span className="stage-example">{t('studio.exampleData')}</span>
              ) : null}
              {captions && cue ? <span className="stage-caption">{cue.text}</span> : null}
            </div>
          </div>
          <div className="transport">
            <button
              type="button"
              className="icon-button"
              aria-label={t('studio.previousLine')}
              disabled={!timeline}
              onClick={() => jumpLine(-1)}
            >
              <Icon d="M4 4v10M14 4 7 9l7 5z" />
            </button>
            <button
              type="button"
              className="play-button"
              aria-label={playing ? t('studio.pause') : t('demos.play')}
              disabled={video.status !== 'ready'}
              onClick={toggle}
            >
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2h3v12H4zM9 2h3v12H9z" fill="currentColor" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2v12l10-6z" fill="currentColor" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('studio.nextLine')}
              disabled={!timeline}
              onClick={() => jumpLine(1)}
            >
              <Icon d="M14 4v10M4 4l7 5-7 5z" />
            </button>
            <span className="transport-time num">
              <b>{clockTenths(now)}</b> / {clock(length)}
            </span>
            <span className="grow" />
            <Switch
              data-size="sm"
              label={t('studio.captions')}
              checked={captions}
              onChange={(e) => setCaptions(e.target.checked)}
            />
            <Select
              aria-label={t('studio.speed')}
              data-size="sm"
              className="transport-speed"
              value={String(speed)}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {speeds.map((s) => (
                <Select.Option key={s} value={String(s)}>
                  {`${f.number(s)}×`}
                </Select.Option>
              ))}
            </Select>
          </div>
        </div>
        <aside className="studio-side" aria-label={t('studio.sidePanel')}>
          <div className="studio-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              id="studio-tab-props"
              aria-controls="studio-panel"
              aria-selected={tab === 'props'}
              className={`studio-tab${tab === 'props' ? ' is-on' : ''}`}
              onClick={() => setTab('props')}
            >
              {t('studio.properties')}
            </button>
            <button
              type="button"
              role="tab"
              id="studio-tab-director"
              aria-controls="studio-panel"
              aria-selected={tab === 'director'}
              className={`studio-tab${tab === 'director' ? ' is-on' : ''}`}
              onClick={() => setTab('director')}
            >
              {t('studio.director')}
            </button>
          </div>
          <div
            className="studio-scroll"
            role="tabpanel"
            id="studio-panel"
            aria-labelledby={tab === 'props' ? 'studio-tab-props' : 'studio-tab-director'}
          >
            {tab === 'props' ? (
              <StudioInspector
                demo={demo}
                recording={recording}
                timeline={timed ? timeline : undefined}
                chapters={chapters}
                scenes={scenes}
                selection={selection}
                says={says}
                onSay={setSay}
                looks={looks}
                onScene={setScene}
                onPage={setPage}
                music={music}
              />
            ) : (
              <StudioDirector
                key={recording?.id}
                api={api}
                demo={demo}
                editions={editions}
                recording={recording}
              />
            )}
          </div>
        </aside>
        <StudioTimeline
          api={api}
          recording={recording}
          timeline={timed ? timeline : undefined}
          chapters={chapters}
          scenes={scenes}
          cues={film.cues}
          scoreOf={(step) => scoreOf(recording, step)}
          music={music}
          says={says}
          selection={selection}
          onSelect={select}
          now={now}
          onSeek={seek}
          playing={playing}
        />
      </div>
    </div>
  );
};

export const DemoStudio = ({
  api,
  id,
  recording,
}: {
  api: ApiClient;
  id: string;
  recording?: string | undefined;
}) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.demo(id, signal), [api, id]);
  if (state.status === 'loading') return <Loading label={t('demos.loading')} />;
  if (state.status === 'error')
    return (state.error as { status?: number }).status === 404 ? (
      <EmptyState title={t('demos.notFoundTitle')}>
        <Paragraph>{t('demos.notFoundText')}</Paragraph>
      </EmptyState>
    ) : (
      <ErrorState error={state.error} onRetry={retry} />
    );
  return <StudioView api={api} demo={state.data} chosen={recording} retry={retry} />;
};
