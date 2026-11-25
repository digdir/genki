import { Alert, Button, Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient, type DemoDetail, type DemoRecording } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { EmptyState, ErrorState, Loading } from '../../states';
import { DialogError, Flash, ReasonDialog, useFlash } from '../../ui';
import { commandLine, describeCommand, parseCommands } from './commands';
import {
  actorName,
  Crumbs,
  demoHref,
  editHref,
  hasFile,
  isOpen,
  stepsDone,
  useFileUrl,
} from './shared';

const pollMs = 2000;

const Screenshot = ({
  api,
  recording,
  name,
  alt,
  empty,
}: {
  api: ApiClient;
  recording: string;
  name: string | undefined;
  alt: string;
  empty: string;
}) => {
  const t = useT();
  const file = useFileUrl(api, name ? recording : undefined, name);
  if (file.status === 'missing') return <Paragraph className="muted">{empty}</Paragraph>;
  if (file.status === 'error') return <Alert data-color="danger">{t('demos.sampleFailed')}</Alert>;
  if (file.status !== 'ready') return <div className="demo-shot demo-shot-empty" />;
  return <img className="demo-shot" src={file.url} alt={alt} />;
};

type StepStatus = 'done' | 'now' | 'waiting';

const statusKey = {
  done: 'demos.stepDone',
  now: 'demos.stepNow',
  waiting: 'demos.stepWaiting',
} as const;

const Progress = ({
  recording,
  demo,
}: {
  recording: DemoRecording;
  demo: DemoDetail | undefined;
}) => {
  const t = useT();
  const done = stepsDone(recording);
  const status = (n: number): StepStatus =>
    n <= done ? 'done' : n === done + 1 && recording.status === 'running' ? 'now' : 'waiting';
  return (
    <section aria-labelledby="recording-steps" className="card stack">
      <Heading level={2} data-size="sm" id="recording-steps">
        {t('demos.progressHeading')}
      </Heading>
      <ol className="demo-progress">
        {Array.from({ length: recording.steps }, (_, i) => {
          const n = i + 1;
          const s = status(n);
          return (
            <li key={n} className={`demo-progress-step is-${s}`}>
              <span className="demo-progress-mark" aria-hidden="true">
                {s === 'done' ? '✓' : n}
              </span>
              <span className="demo-progress-text">
                <span>{demo?.steps[i]?.say ?? t('demos.stepHeading', { n })}</span>
                <span className="muted">{t(statusKey[s])}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const Running = ({
  api,
  recording,
  demo,
  onCancelled,
}: {
  api: ApiClient;
  recording: DemoRecording;
  demo: DemoDetail | undefined;
  onCancelled: () => void;
}) => {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const done = stepsDone(recording);
  return (
    <>
      <div className="page-header">
        <div className="demo-tags">
          <Tag data-color="info" data-size="sm">
            {recording.status === 'queued' ? t('demos.resultQueued') : t('demos.stateRecording')}
          </Tag>
        </div>
        <Heading level={1} data-size="lg">
          {recording.status === 'queued'
            ? t('demos.recordingQueuedTitle')
            : t('demos.recordingRunningTitle')}
        </Heading>
        <p className="intro">
          {recording.status === 'queued'
            ? t(
                demo?.recorder === 'scheduled'
                  ? 'demos.recordingQueuedTextScheduled'
                  : 'demos.recordingQueuedText',
              )
            : t('demos.recordingProgress', { done, steps: recording.steps })}
        </p>
      </div>
      <div className="actions-row">
        <Button
          data-size="sm"
          variant="secondary"
          data-color="danger"
          onClick={() => setAsking(true)}
        >
          {t('demos.cancel')}
        </Button>
      </div>
      <ReasonDialog
        open={asking}
        title={t('demos.cancelTitle')}
        text={t('demos.cancelText')}
        confirmLabel={t('demos.cancelConfirm')}
        onClose={() => setAsking(false)}
        onConfirm={async (reason) => {
          try {
            await api.cancelRecording(recording.id, reason);
          } catch (error) {
            if (error instanceof ApiError && error.status === 409)
              throw new DialogError(t('demos.recordedText'));
            throw error;
          }
          onCancelled();
        }}
      />
      <div className="demo-detail">
        <section aria-labelledby="recording-shot" className="stack">
          <Heading level={2} data-size="sm" id="recording-shot">
            {t('demos.screenshotNow')}
          </Heading>
          <Screenshot
            api={api}
            recording={recording.id}
            name={done > 0 ? `step-${done}.png` : undefined}
            alt={t('demos.screenshotAlt', { n: done })}
            empty={t('demos.noScreenshot')}
          />
        </section>
        <Progress recording={recording} demo={demo} />
      </div>
    </>
  );
};

const Failed = ({
  api,
  recording,
  demo,
}: {
  api: ApiClient;
  recording: DemoRecording;
  demo: DemoDetail | undefined;
}) => {
  const t = useT();
  const failure = recording.failure ?? { step: 0, message: '' };
  const step = failure.step > 0 ? demo?.steps[failure.step - 1] : undefined;
  const parsed = failure.command ? parseCommands(failure.command) : undefined;
  const command = parsed?.ok ? parsed.commands[0] : undefined;
  const shot = `failed-step-${failure.step}.png`;
  return (
    <>
      <div className="page-header">
        <div className="demo-tags">
          <Tag data-color="danger" data-size="sm">
            {t('demos.stateFailed')}
          </Tag>
        </div>
        <Heading level={1} data-size="lg">
          {failure.step === 0
            ? t('demos.failedStartTitle')
            : t('demos.failedTitle', { step: failure.step, steps: recording.steps })}
        </Heading>
        {failure.step === 0 && demo?.ready ? (
          <p className="intro">{t('demos.failedStartText', { ready: demo.ready })}</p>
        ) : null}
      </div>
      <div className="actions-row">
        <Button asChild data-size="sm">
          <a href={editHref(recording.demo, failure.step || undefined)}>{t('demos.editStep')}</a>
        </Button>
      </div>
      <div className="demo-detail">
        <section aria-labelledby="failure-found" className="stack">
          <Heading level={2} data-size="sm" id="failure-found">
            {t('demos.foundHeading')}
          </Heading>
          <Screenshot
            api={api}
            recording={recording.id}
            name={hasFile(recording, shot) ? shot : undefined}
            alt={t('demos.foundAlt', { step: failure.step })}
            empty={t('demos.noFailureShot')}
          />
        </section>
        <aside className="stack">
          {step ? (
            <section aria-labelledby="failure-step" className="card stack">
              <Heading level={2} data-size="sm" id="failure-step">
                {t('demos.failedStep')}
              </Heading>
              <Paragraph>{step.say}</Paragraph>
            </section>
          ) : null}
          {failure.command ? (
            <section aria-labelledby="failure-looked" className="card stack">
              <Heading level={2} data-size="sm" id="failure-looked">
                {t('demos.lookedFor')}
              </Heading>
              {command ? <Paragraph>{describeCommand(command, t)}</Paragraph> : null}
              <code className="demo-command">
                {command ? commandLine(command) : failure.command}
              </code>
            </section>
          ) : null}
          {failure.message ? (
            <section aria-labelledby="failure-message" className="card stack">
              <Heading level={2} data-size="sm" id="failure-message">
                {t('demos.errorMessage')}
              </Heading>
              <code className="demo-command">{failure.message}</code>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
};

export const RecordingScreen = ({ api, id }: { api: ApiClient; id: string }) => {
  const t = useT();
  const flash = useFlash();
  const [state, retry] = useAsync((signal) => api.recording(id, signal), [api, id]);
  const recording = state.status === 'ready' ? state.data : undefined;
  const [demoState] = useAsync(
    (signal) =>
      recording
        ? api.demo(recording.demo, signal)
        : Promise.resolve<DemoDetail | undefined>(undefined),
    [api, recording?.demo],
  );
  const demo = demoState.status === 'ready' ? demoState.data : undefined;
  const open = recording ? isOpen(recording) : false;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(retry, pollMs);
    return () => clearInterval(timer);
  }, [open, retry]);

  const crumbs = (
    <Crumbs title={demo?.title} {...(recording ? { href: demoHref(recording.demo) } : {})} />
  );
  if (state.status === 'loading')
    return (
      <>
        {crumbs}
        <Loading label={t('demos.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {crumbs}
        {(state.error as { status?: number }).status === 404 ? (
          <EmptyState title={t('demos.notFoundTitle')} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </>
    );
  const found = state.data;
  return (
    <>
      {crumbs}
      <Flash message={flash.message} />
      {demo ? (
        <Paragraph data-size="sm" className="muted">
          {t('demos.recordingTitle', { title: demo.title })}
          {found.upTo ? ` · ${t('demos.trialOf', { upTo: found.upTo })}` : ''}
        </Paragraph>
      ) : null}
      {isOpen(found) ? (
        <Running
          api={api}
          recording={found}
          demo={demo}
          onCancelled={() => {
            flash.show(t('demos.cancelled'));
            retry();
          }}
        />
      ) : found.status === 'failed' ? (
        <Failed api={api} recording={found} demo={demo} />
      ) : found.status === 'cancelled' ? (
        <EmptyState title={t('demos.cancelledTitle')}>
          <Paragraph>{t('demos.cancelledText', { who: actorName(found.cancelledBy) })}</Paragraph>
          <Link href={demoHref(found.demo)}>{t('demos.toDemo')}</Link>
        </EmptyState>
      ) : (
        <EmptyState title={t('demos.recordedTitle')}>
          <Paragraph>{t('demos.recordedText')}</Paragraph>
          <Link href={demoHref(found.demo)}>{t('demos.toDemo')}</Link>
        </EmptyState>
      )}
    </>
  );
};
