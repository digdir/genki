import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient, DemoLineScore, DemoRecording } from '../../api';
import { useT, type PlainKey } from '../../i18n';
import type { Chapter, Cue, Scene, SceneKind, Timeline } from './film';
import { clock, hasFile, toneOf, useFileUrl } from './shared';

export type Selection =
  | { kind: 'line'; step: number }
  | { kind: 'scene'; n: number }
  | { kind: 'chapter'; n: number }
  | { kind: 'camera'; i: number }
  | { kind: 'music' };

export const sameSelection = (a: Selection, b: Selection) =>
  a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);

export const sceneKindLabel: Record<SceneKind, PlainKey> = {
  title: 'studio.sceneTitle',
  screen: 'studio.sceneScreen',
  board: 'studio.sceneBoard',
  code: 'studio.sceneCode',
  close: 'studio.sceneClose',
  chapter: 'studio.sceneChapter',
};

const head = 128;
const minPps = 3;
const maxPps = 60;

export const clockTenths = (seconds: number) => {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const tickStep = (pps: number) => (pps >= 28 ? 2 : pps >= 14 ? 5 : pps >= 7 ? 10 : 20);

const Track = ({
  name,
  className,
  hidden,
  onToggle,
  width,
  children,
}: {
  name: string;
  className: string;
  hidden: boolean;
  onToggle: () => void;
  width: number;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <div className={`tl-track ${className}${hidden ? ' is-hidden' : ''}`}>
      <div className="tl-head">
        <span>{name}</span>
        <button
          type="button"
          className="tl-eye"
          aria-pressed={hidden}
          aria-label={t('studio.hideTrack', { track: name })}
          onClick={onToggle}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            {hidden ? (
              <path d="M2 12 12 2" stroke="currentColor" strokeWidth="1.2" />
            ) : (
              <circle cx="7" cy="7" r="1.6" fill="currentColor" />
            )}
          </svg>
        </button>
      </div>
      <ol className="tl-lane" aria-label={name} style={{ width }}>
        {hidden ? null : children}
      </ol>
    </div>
  );
};

const Still = ({
  api,
  recording,
  step,
}: {
  api: ApiClient;
  recording: DemoRecording;
  step: number;
}) => {
  const name = `step-${step}.png`;
  const file = useFileUrl(api, hasFile(recording, name) ? recording.id : undefined, name);
  return file.status === 'ready' ? <img src={file.url} alt="" /> : null;
};

const Words = ({ words, from, to }: { words: Timeline['words']; from: number; to: number }) => {
  const span = Math.max(0.1, to - from);
  return (
    <svg className="tl-wave" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
      {words.map((w, i) => {
        const h = Math.min(14, 4 + w.text.length);
        return (
          <rect
            key={i}
            x={(100 * (w.at - from)) / span}
            y={8 - h / 2}
            width={Math.max(0.6, (100 * (w.to - w.at)) / span - 0.6)}
            height={h}
            rx="1"
          />
        );
      })}
    </svg>
  );
};

export const StudioTimeline = ({
  api,
  recording,
  timeline,
  chapters,
  scenes,
  cues,
  scoreOf,
  music,
  says,
  selection,
  onSelect,
  now,
  onSeek,
  playing,
}: {
  api: ApiClient;
  recording: DemoRecording | undefined;
  timeline: Timeline | undefined;
  chapters: Chapter[];
  scenes: Scene[];
  cues: Cue[];
  scoreOf: (step: number) => DemoLineScore | undefined;
  music: string | undefined;
  says: string[];
  selection: Selection;
  onSelect: (selection: Selection, at?: number) => void;
  now: number;
  onSeek: (seconds: number) => void;
  playing: boolean;
}) => {
  const t = useT();
  const length = timeline?.length ?? cues.at(-1)?.to ?? 0;
  const scroller = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState<number | undefined>(undefined);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const fit = () => {
    const width = scroller.current?.clientWidth ?? 0;
    if (length > 0 && width > head)
      setPps(Math.min(maxPps, Math.max(minPps, (width - head - 24) / length)));
  };
  useLayoutEffect(() => {
    if (pps === undefined) fit();
  });
  const scale = pps ?? 12;
  const x = (seconds: number) => seconds * scale;
  const width = x(length) + 40;
  const scrubbing = useRef(false);

  useEffect(() => {
    const box = scroller.current;
    if (!playing || !box) return;
    const at = head + x(now);
    if (at > box.scrollLeft + box.clientWidth - 40 || at < box.scrollLeft + head)
      box.scrollLeft = at - head - 40;
  });

  const seekAt = (event: { clientX: number; currentTarget: HTMLElement }) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(length, (event.clientX - box.left) / scale)));
  };
  const toggle = (track: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(track)) next.add(track);
      return next;
    });
  const is = (s: Selection) => sameSelection(selection, s);
  const track = (key: string, name: string, children: ReactNode) => (
    <Track
      key={key}
      name={name}
      className={`tl-${key}`}
      hidden={hidden.has(key)}
      onToggle={() => toggle(key)}
      width={width}
    >
      {children}
    </Track>
  );

  const step = tickStep(scale);
  const ticks: ReactNode[] = [];
  for (let at = 0; at <= length; at += step)
    ticks.push(
      <span key={`t${at}`} className="tl-tick" style={{ left: x(at) }}>
        {clock(at)}
      </span>,
    );
  for (let at = step / 5; at <= length; at += step / 5)
    if (Math.round(at * 1000) % Math.round(step * 1000) !== 0)
      ticks.push(<span key={`m${at}`} className="tl-tick is-minor" style={{ left: x(at) }} />);

  return (
    <section className="tl" aria-label={t('studio.timeline')}>
      <div className="tl-tools">
        <strong>{t('studio.timeline')}</strong>
        <span className="muted num">
          {timeline
            ? t('studio.timelineInfo', {
                scenes: scenes.length,
                lines: timeline.lines.length,
                length: clock(length),
              })
            : t('studio.timelineEmpty')}
        </span>
        <span className="grow" />
        {recording?.lines?.length ? (
          <span className="tl-legend">
            <span>
              <i className="is-ok" />
              {t('studio.legendClean')}
            </span>
            <span>
              <i className="is-warn" />
              {t('studio.legendSmall')}
            </span>
            <span>
              <i className="is-bad" />
              {t('studio.legendLarge')}
            </span>
          </span>
        ) : null}
        <button
          type="button"
          className="icon-button"
          aria-label={t('studio.zoomOut')}
          disabled={!timeline}
          onClick={() => setPps(Math.max(minPps, scale / 1.5))}
        >
          −
        </button>
        <input
          type="range"
          className="tl-zoom"
          aria-label={t('studio.zoom')}
          min={minPps}
          max={maxPps}
          step={1}
          value={Math.round(scale)}
          disabled={!timeline}
          onChange={(e) => setPps(Number(e.target.value))}
        />
        <button
          type="button"
          className="icon-button"
          aria-label={t('studio.zoomIn')}
          disabled={!timeline}
          onClick={() => setPps(Math.min(maxPps, scale * 1.5))}
        >
          +
        </button>
        <button type="button" className="tl-fit" disabled={!timeline} onClick={fit}>
          {t('studio.fit')}
        </button>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-inner" style={{ width: head + width }}>
          <div className="tl-track tl-ruler">
            <div className="tl-head num">{clockTenths(now)}</div>
            <div
              className="tl-lane"
              style={{ width }}
              role="slider"
              tabIndex={timeline ? 0 : -1}
              aria-label={t('studio.position')}
              aria-valuemin={0}
              aria-valuemax={Math.round(length)}
              aria-valuenow={Math.round(now)}
              aria-valuetext={clockTenths(now)}
              onPointerDown={(e) => {
                if (!timeline) return;
                scrubbing.current = true;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                seekAt(e);
              }}
              onPointerMove={(e) => scrubbing.current && seekAt(e)}
              onPointerUp={() => (scrubbing.current = false)}
              onPointerCancel={() => (scrubbing.current = false)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') onSeek(Math.min(length, now + 1));
                else if (e.key === 'ArrowLeft') onSeek(Math.max(0, now - 1));
                else return;
                e.preventDefault();
              }}
            >
              {ticks}
            </div>
          </div>
          {track(
            'chapters',
            t('studio.trackChapters'),
            chapters.map((c) => (
              <li key={c.n} style={{ left: x(c.from), width: Math.max(4, x(c.to - c.from) - 2) }}>
                <button
                  type="button"
                  className={`tl-clip is-chapter-${((c.n - 1) % 5) + 1}${is({ kind: 'chapter', n: c.n }) ? ' is-selected' : ''}`}
                  aria-label={t('studio.chapterClip', {
                    n: c.n,
                    name: c.name,
                    time: clock(c.from),
                  })}
                  onClick={() => onSelect({ kind: 'chapter', n: c.n })}
                >
                  <span className="tl-label">
                    {c.n}. {c.name}
                  </span>
                </button>
              </li>
            )),
          )}
          {track(
            'scenes',
            t('studio.trackScenes'),
            scenes.map((s) => {
              const w = x(s.to - s.from) - 2;
              const first = s.steps[0];
              return (
                <li key={s.n} style={{ left: x(s.from), width: Math.max(4, w) }}>
                  <button
                    type="button"
                    className={`tl-clip${is({ kind: 'scene', n: s.n }) ? ' is-selected' : ''}`}
                    aria-label={t('studio.sceneClip', {
                      n: s.n,
                      kind: t(sceneKindLabel[s.kind]),
                      name: s.name || t(sceneKindLabel[s.kind]),
                      time: clock(s.from),
                    })}
                    onClick={() => onSelect({ kind: 'scene', n: s.n })}
                  >
                    {w > 50 ? (
                      <span className={`tl-thumb is-${s.kind}`} aria-hidden="true">
                        {s.kind === 'screen' && recording && first !== undefined ? (
                          <Still api={api} recording={recording} step={first} />
                        ) : (
                          <span className="tl-thumb-card" />
                        )}
                      </span>
                    ) : null}
                    <span className="tl-text">
                      <span className="tl-label">{w > 30 ? `${s.n} ${s.name}`.trim() : s.n}</span>
                      {w > 110 ? <small>{t(sceneKindLabel[s.kind])}</small> : null}
                    </span>
                  </button>
                </li>
              );
            }),
          )}
          {track(
            'voice',
            t('studio.trackVoice'),
            timeline?.lines.map((l) => {
              const w = x(l.to - l.from) - 2;
              const score = scoreOf(l.step);
              return (
                <li key={l.step} style={{ left: x(l.from), width: Math.max(6, w) }}>
                  <button
                    type="button"
                    className={`tl-clip${score ? ` is-${toneOf(score.score)}` : ''}${is({ kind: 'line', step: l.step }) ? ' is-selected' : ''}`}
                    aria-label={t('studio.lineClip', {
                      n: l.step,
                      time: clock(l.from),
                      text: says[l.step - 1] ?? '',
                    })}
                    onClick={() => onSelect({ kind: 'line', step: l.step }, l.from)}
                  >
                    <span className="tl-top">
                      {score && w > 34 ? (
                        <span className={`score is-${toneOf(score.score)}`}>{score.score}</span>
                      ) : null}
                      {w > 90 ? <span className="tl-label">{says[l.step - 1]}</span> : null}
                    </span>
                    <Words
                      words={timeline.words.filter((w) => w.step === l.step)}
                      from={l.from}
                      to={l.to}
                    />
                  </button>
                </li>
              );
            }),
          )}
          {track(
            'captions',
            t('studio.trackCaptions'),
            cues.map((c, i) => (
              <li key={i} style={{ left: x(c.from), width: Math.max(4, x(c.to - c.from) - 2) }}>
                <button
                  type="button"
                  className="tl-clip"
                  aria-label={t('studio.captionClip', { time: clock(c.from), text: c.text })}
                  onClick={() => onSeek(c.from)}
                >
                  <span className="tl-label">{c.text}</span>
                </button>
              </li>
            )),
          )}
          {track(
            'camera',
            t('studio.trackCamera'),
            timeline?.camera.flatMap((c, i) => {
              const next = timeline.camera[i + 1];
              const sameScene =
                next && scenes.find((s) => s.steps.includes(c.step))?.steps.includes(next.step);
              const zoom = c.zoom.toFixed(1);
              return [
                sameScene && next ? (
                  <li
                    key={`s${i}`}
                    className="tl-cam-line"
                    style={{ left: x(c.at), width: x(next.at - c.at) }}
                    aria-hidden="true"
                  />
                ) : null,
                <li key={i} className="tl-key" style={{ left: x(c.at) }}>
                  <button
                    type="button"
                    className={is({ kind: 'camera', i }) ? 'is-selected' : undefined}
                    aria-label={t('studio.cameraClip', {
                      zoom,
                      time: clock(c.at),
                      why: c.why ?? c.word ?? '',
                    })}
                    onClick={() => onSelect({ kind: 'camera', i }, c.at)}
                  />
                  <span aria-hidden="true">{zoom}×</span>
                </li>,
              ];
            }),
          )}
          {track(
            'music',
            t('studio.trackMusic'),
            music && timeline ? (
              <li style={{ left: 0, width: x(length) - 2 }}>
                <button
                  type="button"
                  className={`tl-clip${is({ kind: 'music' }) ? ' is-selected' : ''}`}
                  onClick={() => onSelect({ kind: 'music' })}
                >
                  <svg
                    viewBox={`0 0 ${Math.max(1, length)} 30`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={[
                        '0,8',
                        ...timeline.lines.flatMap((l) => [
                          `${Math.max(0, l.from - 0.6)},8`,
                          `${l.from},22`,
                          `${l.to},22`,
                          `${l.to + 0.6},8`,
                        ]),
                        `${length},8`,
                      ].join(' ')}
                    />
                  </svg>
                  <span className="tl-label">{music}</span>
                </button>
              </li>
            ) : (
              <li className="tl-none">{t('studio.noMusic')}</li>
            ),
          )}
          {timeline ? (
            <div className="tl-playhead" style={{ left: head + x(now) }} aria-hidden="true" />
          ) : null}
        </div>
      </div>
    </section>
  );
};
