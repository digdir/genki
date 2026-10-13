import { Button, Spinner, Tag } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import type { PlaygroundResult, PlaygroundStreamEvent, RunStats } from '../../api/playground';
import { useFormat } from '@genai/i18n/react';
import { formatCount, formatSecondsShort } from '../../data/playground';
import { useT } from '../../i18n';
import { Steps } from '../../screens/log/Steps';
import { formatOffset } from '../../screens/log/format';
import type { TimelineStep } from '../../types';
import '../../screens/log.css';

export type LiveStatus = 'running' | 'completed' | 'failed';

export interface LiveRun {
  status: LiveStatus;
  startedAt: number;
  endedAt?: number;
  runId?: string;
  steps: TimelineStep[];
  stats?: RunStats;
  answer: string;
  reasoning: string;
}

export const startRun = (now: number): LiveRun => ({
  status: 'running',
  startedAt: now,
  steps: [],
  answer: '',
  reasoning: '',
});

export const runFromResult = (result: PlaygroundResult, now: number): LiveRun => ({
  status: 'completed',
  startedAt: now - result.timeMs,
  endedAt: now,
  runId: result.runId,
  steps: result.steps ?? [],
  ...(result.stats ? { stats: result.stats } : {}),
  answer: '',
  reasoning: '',
});

const upsert = (steps: TimelineStep[], step: TimelineStep) =>
  steps.some((s) => s.id === step.id)
    ? steps.map((s) => (s.id === step.id ? step : s))
    : [...steps, step];

const ended = (run: LiveRun, status: LiveStatus, now: number): LiveRun => ({
  ...run,
  status,
  endedAt: run.endedAt ?? now,
});

export const applyEvent = (run: LiveRun, event: PlaygroundStreamEvent, now: number): LiveRun => {
  switch (event.event) {
    case 'started':
      return { ...run, runId: event.runId };
    case 'status':
      return event.status === 'running'
        ? run
        : ended(run, event.status === 'completed' ? 'completed' : 'failed', now);
    case 'step': {
      const turn = event.step.type === 'model' && event.step.state === 'running';
      const known = run.steps.some((s) => s.id === event.step.id);
      return {
        ...run,
        steps: upsert(run.steps, event.step),
        ...(turn && !known ? { reasoning: '' } : {}),
      };
    }
    case 'remove':
      return { ...run, steps: run.steps.filter((s) => s.id !== event.id) };
    case 'delta':
      return event.channel === 'reasoning'
        ? { ...run, reasoning: run.reasoning + event.text }
        : { ...run, answer: run.answer + event.text };
    case 'retract':
      return { ...run, answer: '' };
    case 'stats':
      return { ...run, stats: event.stats };
    case 'result':
      return {
        ...ended(run, 'completed', now),
        runId: event.result.runId,
        ...(event.result.steps ? { steps: event.result.steps } : {}),
        ...(event.result.stats ? { stats: event.result.stats } : {}),
      };
    case 'failed':
      return ended(run, 'failed', now);
    default:
      return run;
  }
};

const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [active]);
  return now;
};

const statusTags = {
  running: ['playground.runRunning', 'info'],
  completed: ['playground.runDone', 'success'],
  failed: ['playground.runFailed', 'danger'],
} as const;

export const RunHeader = ({ run, result }: { run: LiveRun; result?: PlaygroundResult }) => {
  const t = useT();
  const f = useFormat();
  const running = run.status === 'running';
  const now = useNow(running);
  const elapsed = result ? result.timeMs : (run.endedAt ?? now) - run.startedAt;
  const stats = run.stats;
  const [label, color] = statusTags[run.status];
  const rows: [string, string][] = [
    [t('playground.metaTime'), formatSecondsShort(Math.max(0, elapsed), f, t)],
    [t('playground.metaIterations'), formatCount(stats?.iterations ?? 0, f)],
    [t('playground.metaToolCalls'), formatCount(stats?.toolCalls ?? 0, f)],
    [t('playground.metaChunksRead'), formatCount(stats?.chunksRead ?? 0, f)],
    ...(running
      ? []
      : ([
          [t('playground.metaDocuments'), formatCount(stats?.documents ?? 0, f)],
          [t('playground.metaWarnings'), formatCount(stats?.warnings.length ?? 0, f)],
        ] as [string, string][])),
  ];
  return (
    <div className="playground-run-head">
      <Tag data-size="sm" data-color={color}>
        {running ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
        {t(label)}
      </Tag>
      <dl className="playground-meta">
        {rows.map(([l, v]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

export const WhatHappened = ({ run, idPrefix }: { run: LiveRun; idPrefix: string }) => {
  const t = useT();
  const running = run.status === 'running';
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const show = expanded ?? running;
  const latest = running ? run.steps.findLast((s) => s.state === 'running')?.id : undefined;
  if (run.steps.length === 0) return null;
  const isOpen = (step: TimelineStep) =>
    opened.has(step.id) || (step.id === latest && !closed.has(step.id));
  const toggle = (index: number) => {
    const step = run.steps[index];
    if (!step) return;
    const open = isOpen(step);
    setOpened((s) => {
      const next = new Set(s);
      if (open) next.delete(step.id);
      else next.add(step.id);
      return next;
    });
    setClosed((s) => {
      const next = new Set(s);
      if (open) next.add(step.id);
      else next.delete(step.id);
      return next;
    });
  };
  const bodyId = `${idPrefix}what`;
  return (
    <div className="playground-what">
      <Button
        variant="tertiary"
        data-size="sm"
        aria-expanded={show}
        aria-controls={show ? bodyId : undefined}
        onClick={() => setExpanded(!show)}
      >
        {t('playground.whatHappenedCount', { count: run.steps.length })}
      </Button>
      {show ? (
        <div id={bodyId}>
          <Steps
            steps={run.steps}
            isOpen={isOpen}
            onToggle={toggle}
            label={t('playground.whatHappened')}
            idPrefix={idPrefix}
          />
        </div>
      ) : null}
    </div>
  );
};

export const LiveText = ({ run }: { run: LiveRun }) => {
  if (run.status !== 'running') return null;
  if (run.answer) return <div className="playground-text playground-streaming">{run.answer}</div>;
  if (run.reasoning) return <p className="log-reasoning">{run.reasoning}</p>;
  return null;
};

export const TimelinePanel = ({ run }: { run: LiveRun | undefined }) => {
  const t = useT();
  const f = useFormat();
  return (
    <section aria-labelledby="playground-timeline-heading" className="playground-timeline">
      <h3 id="playground-timeline-heading" className="playground-timeline-heading">
        {t('playground.timelineTitle')}
      </h3>
      {!run || run.steps.length === 0 ? (
        <p className="playground-timeline-empty">{t('playground.timelineEmpty')}</p>
      ) : (
        <ol className="playground-timeline-list">
          {run.steps.map((step) => (
            <li key={step.id}>
              <span className="playground-timeline-time">{formatOffset(step.at, f)}</span>
              <span className="playground-timeline-text">
                <span className="playground-timeline-label">{step.title}</span>
                <span className="playground-timeline-detail">{step.summary}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
