import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import { timedSteps, timelineBars } from '../../data/playground';
import { useT } from '../../i18n';
import { Steps } from '../../screens/log/Steps';
import { formatDuration } from '../../screens/log/format';
import type { TimelineStep } from '../../types';

const stepName = (step: TimelineStep) =>
  step.model ? `${step.title} · ${step.model}` : step.title;

export const RunTimeline = ({ steps }: { steps: TimelineStep[] }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  const opened = steps.find((s) => s.id === open);
  return (
    <section aria-labelledby={`${id}-title`} className="playground-gantt">
      <div className="playground-gantt-head">
        <h3 id={`${id}-title`} className="playground-gantt-title">
          {t('playground.timelineAnswer')}
        </h3>
        <span className="playground-subtle">{t('playground.timelineHint')}</span>
      </div>
      {steps.length === 0 ? (
        <p className="playground-subtle">{t('playground.timelineNoSteps')}</p>
      ) : (
        <ol className="playground-gantt-list">
          {timelineBars(steps).map(({ step, left, width }) => (
            <li key={step.id}>
              <button
                type="button"
                className="playground-gantt-row"
                aria-expanded={open === step.id}
                aria-controls={open === step.id ? `${id}-detail` : undefined}
                onClick={() => setOpen(open === step.id ? null : step.id)}
              >
                <span className="playground-gantt-name">
                  {step.title}
                  {step.model ? <span className="playground-subtle"> · {step.model}</span> : null}
                </span>
                <span className="playground-gantt-track" aria-hidden="true">
                  <span
                    className="playground-gantt-bar"
                    data-type={step.type}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </span>
                <span className="playground-gantt-time">
                  {step.durationSeconds === undefined
                    ? ''
                    : formatDuration(step.durationSeconds, f, t)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {opened ? (
        <div id={`${id}-detail`} className="playground-gantt-detail">
          <Steps
            steps={[opened]}
            isOpen={() => true}
            onToggle={() => setOpen(null)}
            label={stepName(opened)}
            idPrefix={`${id}-`}
          />
        </div>
      ) : null}
    </section>
  );
};

export const TimelineStrip = ({ steps, side }: { steps: TimelineStep[]; side: string }) => {
  const t = useT();
  const f = useFormat();
  const timed = timedSteps(steps);
  if (timed.length === 0) return null;
  const total = timed.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  const summary = timed
    .map((s) => `${s.title} ${formatDuration(s.durationSeconds ?? 0, f, t)}`)
    .join(' · ');
  return (
    <div className="playground-strip-wrap">
      <div
        role="img"
        aria-label={t('playground.timelineSide', { key: side, summary })}
        className="playground-strip"
      >
        {timed.map((s) => (
          <span
            key={s.id}
            data-type={s.type}
            style={{ width: `${((s.durationSeconds ?? 0) / total) * 100}%` }}
          />
        ))}
      </div>
      <span className="playground-subtle" aria-hidden="true">
        {summary}
      </span>
    </div>
  );
};
