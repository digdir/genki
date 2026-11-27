import { Alert, Button, Heading, Textfield } from '@digdir/designsystemet-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiClient, DemoDetail, DemoRecording } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { Loading } from '../../states';
import { approvalUsd, editCostUsd } from '@genai/contracts';
import { DialogError, ReasonDialog } from '../../ui';
import { timelineOf, type FilmEdl, type FilmEvents, type Timeline } from './film';
import { clock, CostApproval, CostLine, hasFile, queueing, useFileUrl } from './shared';

const pixelsPerSecond = 120;

export const hasStudio = (recording: DemoRecording) =>
  recording.status === 'recorded' &&
  recording.upTo === undefined &&
  hasFile(recording, 'capture.mp4') &&
  hasFile(recording, 'edl.json') &&
  hasFile(recording, 'events.json');

const readJson = async <T,>(api: ApiClient, recording: string, name: string, signal: AbortSignal) =>
  JSON.parse(await (await api.demoFile(recording, name, signal)).text()) as T;

const Track = ({
  label,
  length,
  children,
}: {
  label: string;
  length: number;
  children: ReactNode;
}) => (
  <div className="studio-row">
    <span className="studio-row-label" aria-hidden="true">
      {label}
    </span>
    <ol className="studio-track" aria-label={label} style={{ width: length * pixelsPerSecond }}>
      {children}
    </ol>
  </div>
);

const left = (at: number) => ({ left: at * pixelsPerSecond });

const TimelineView = ({
  timeline,
  now,
  seek,
}: {
  timeline: Timeline;
  now: number;
  seek: (seconds: number) => void;
}) => {
  const t = useT();
  return (
    <div className="studio-timeline">
      <div className="studio-playhead" style={left(now)} aria-hidden="true" />
      <Track label={t('demos.studioSteps')} length={timeline.length}>
        {timeline.shots.map((s) => (
          <li key={s.step} style={left(s.at)}>
            <button
              type="button"
              className={`studio-item${s.page ? ' is-page' : ''}`}
              title={s.say}
              aria-label={t(s.page ? 'demos.studioStepPage' : 'demos.studioStep', {
                n: s.step,
                time: clock(s.at),
                text: s.say,
              })}
              onClick={() => seek(s.at)}
            >
              {s.step}
              {s.page && s.title ? ` · ${s.title}` : ''}
            </button>
          </li>
        ))}
      </Track>
      <Track label={t('demos.studioCamera')} length={timeline.length}>
        {timeline.camera.map((c, i) => (
          <li key={i} style={left(c.at)}>
            <button
              type="button"
              className="studio-item"
              title={c.why}
              aria-label={t('demos.studioKeyframe', {
                zoom: c.zoom.toFixed(1),
                time: clock(c.at),
                why: c.why ?? c.word ?? '',
              })}
              onClick={() => seek(c.at)}
            >
              {c.zoom.toFixed(1)}×{c.why ? ` ${c.why}` : ''}
            </button>
          </li>
        ))}
      </Track>
      <Track label={t('demos.studioWords')} length={timeline.length}>
        {timeline.words.map((w, i) => (
          <li key={i} style={left(w.at)} className="studio-word">
            {w.text}
          </li>
        ))}
      </Track>
    </div>
  );
};

export const Studio = ({
  api,
  recording,
  demo,
}: {
  api: ApiClient;
  recording: DemoRecording;
  demo: DemoDetail | undefined;
}) => {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const film = useFileUrl(api, recording.id, 'demo.mp4');
  const [plan] = useAsync(
    async (signal) => ({
      edl: await readJson<FilmEdl>(api, recording.id, 'edl.json', signal),
      events: await readJson<FilmEvents>(api, recording.id, 'events.json', signal),
    }),
    [api, recording.id],
  );
  const timeline = useMemo(() => {
    if (plan.status !== 'ready') return undefined;
    try {
      return timelineOf(plan.data.edl, plan.data.events);
    } catch {
      return null;
    }
  }, [plan]);
  const [now, setNow] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [asking, setAsking] = useState(false);
  const [approved, setApproved] = useState(false);
  const costCap = approvalUsd(editCostUsd(recording.steps));
  const seek = (seconds: number) => {
    setNow(seconds);
    if (video.current) video.current.currentTime = seconds;
  };

  return (
    <section aria-labelledby="studio" className="stack">
      <Heading level={1} data-size="lg" id="studio">
        {t('demos.studioTitle')}
      </Heading>
      <CostLine recording={recording} />
      {film.status === 'ready' ? (
        <video
          ref={video}
          className="demo-video"
          controls
          preload="metadata"
          src={film.url}
          aria-label={t('demos.videoLabel', { title: demo?.title ?? recording.demo })}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        />
      ) : film.status === 'loading' ? (
        <Loading label={t('demos.videoLoading')} />
      ) : (
        <Alert data-color="danger">{t('demos.videoFailed')}</Alert>
      )}
      {plan.status === 'loading' ? null : timeline ? (
        <TimelineView timeline={timeline} now={now} seek={seek} />
      ) : (
        <Alert data-color="warning">{t('demos.studioUnreadable')}</Alert>
      )}
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim()) setAsking(true);
        }}
      >
        <Textfield
          label={t('demos.studioAsk')}
          placeholder={t('demos.studioAskExample')}
          multiline
          rows={2}
          maxLength={2000}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div className="actions-row">
          <Button type="submit" data-size="sm" disabled={!instruction.trim()}>
            {t('demos.studioSend')}
          </Button>
        </div>
      </form>
      <ReasonDialog
        open={asking}
        title={t('demos.studioAsk')}
        confirmLabel={t('demos.studioSend')}
        onClose={() => {
          setAsking(false);
          setApproved(false);
        }}
        onConfirm={async (reason) => {
          if (!approved) throw new DialogError(t('demos.costApprovalMissing'));
          const queued = await queueing(t, () =>
            api.requestEdit(recording.demo, reason, recording.id, instruction.trim(), costCap),
          );
          navigate('/demos', { recording: queued.id });
        }}
      >
        <CostApproval usd={costCap} required checked={approved} onChange={setApproved} />
      </ReasonDialog>
    </section>
  );
};
