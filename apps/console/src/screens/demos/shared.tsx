import { Link, Tag } from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type Demo,
  type DemoApp,
  type DemoAudience,
  type DemoRecording,
  type RecorderMode,
} from '../../api';
import { useT, type PlainKey } from '../../i18n';
import { DialogError, useFlash } from '../../ui';

export type DemoState = 'ready' | 'outdated' | 'failed' | 'none';

export const states: DemoState[] = ['ready', 'outdated', 'failed', 'none'];

export const stateLabel: Record<DemoState, PlainKey> = {
  ready: 'demos.stateReady',
  outdated: 'demos.stateOutdated',
  failed: 'demos.stateFailed',
  none: 'demos.stateNone',
};

const stateColor: Record<DemoState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ready: 'success',
  outdated: 'warning',
  failed: 'danger',
  none: 'neutral',
};

export const appLabel: Record<DemoApp, PlainKey> = {
  portal: 'demos.appPortal',
  console: 'demos.appConsole',
  workspace: 'demos.appWorkspace',
};

export const audienceLabel: Record<DemoAudience, PlainKey> = {
  municipality: 'demos.audienceMunicipality',
  'state-agency': 'demos.audienceStateAgency',
  internal: 'demos.audienceInternal',
};

export const demoState = (demo: Demo, genkiVersion: string | null): DemoState => {
  if (demo.latest?.status === 'failed') return 'failed';
  if (!demo.recorded) return 'none';
  return genkiVersion && demo.recorded.genkiVersion !== genkiVersion ? 'outdated' : 'ready';
};

export const clock = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const hasFile = (recording: DemoRecording | undefined, name: string) =>
  recording?.files.some((f) => f.name === name) ?? false;

export const stepsDone = (recording: Pick<DemoRecording, 'files'>) =>
  Math.max(
    0,
    ...recording.files.flatMap((f) => {
      const found = /^step-(\d{1,2})\.png$/.exec(f.name);
      return found ? [Number(found[1])] : [];
    }),
  );

export const canRecord = (recorder: RecorderMode | undefined) =>
  recorder === 'job' || recorder === 'scheduled';

export const isOpen = (recording: Pick<DemoRecording, 'status'>) =>
  recording.status === 'queued' || recording.status === 'running';

export const actorName = (actor: string | undefined) =>
  (actor ?? '').replace(/^(operator|employee|platform):(test:)?/, '');

export const demoHref = (id: string) => `#/demos?demo=${encodeURIComponent(id)}`;
export const recordingHref = (id: string) => `#/demos?recording=${encodeURIComponent(id)}`;
export const editHref = (id: string, step?: number) =>
  `#/demos?edit=${encodeURIComponent(id)}${step ? `&step=${step}` : ''}`;

export const workflowUrl = 'https://github.com/digdir/genki/actions/workflows/demos.yml';

const demoLink = (id: string) =>
  `${window.location.origin}${window.location.pathname}${demoHref(id)}`;

const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const useActions = (api: ApiClient) => {
  const t = useT();
  const flash = useFlash();
  return {
    flash,
    download: async (recording: DemoRecording, name: string) => {
      try {
        save(await api.demoFile(recording.id, name), `${recording.demo}-${name}`);
      } catch {
        flash.show(t('demos.downloadFailed'), 'danger');
      }
    },
    copy: async (id: string) => {
      try {
        await navigator.clipboard.writeText(demoLink(id));
        flash.show(t('demos.linkCopied'));
      } catch {
        flash.show(t('demos.linkNotCopied'), 'danger');
      }
    },
  };
};

export const StateTag = ({ state }: { state: DemoState }) => {
  const t = useT();
  return (
    <Tag data-color={stateColor[state]} data-size="sm">
      {t(stateLabel[state])}
    </Tag>
  );
};

export const RecordingTag = () => {
  const t = useT();
  return (
    <Tag data-color="info" data-size="sm">
      {t('demos.stateRecording')}
    </Tag>
  );
};

export const progressText = (
  recording: DemoRecording,
  t: ReturnType<typeof useT>,
  recorder?: RecorderMode,
) =>
  recording.status === 'queued'
    ? t(recorder === 'scheduled' ? 'demos.recordingQueuedScheduled' : 'demos.recordingQueued')
    : t('demos.recordingProgress', { done: stepsDone(recording), steps: recording.steps });

export const Crumbs = ({ title, href }: { title?: string | undefined; href?: string }) => {
  const t = useT();
  return (
    <nav aria-label={t('demos.breadcrumb')} className="demo-crumbs">
      <Link href="#/demos">{t('demos.back')}</Link>
      {title ? (
        <>
          <span aria-hidden="true">/</span>
          {href ? <Link href={href}>{title}</Link> : <span aria-current="page">{title}</span>}
        </>
      ) : null}
    </nav>
  );
};

export type FileState =
  { status: 'loading' | 'missing' | 'error' } | { status: 'ready'; url: string };

export const useFileUrl = (
  api: ApiClient,
  recording: string | undefined,
  name: string | undefined,
) => {
  const [state, setState] = useState<FileState>({ status: 'loading' });
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!recording || !name) {
      setState({ status: 'missing' });
      return;
    }
    const controller = new AbortController();
    void api.demoFile(recording, name, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        const previous = current.current;
        current.current = URL.createObjectURL(blob);
        setState({ status: 'ready', url: current.current });
        if (previous) URL.revokeObjectURL(previous);
      },
      () => !controller.signal.aborted && setState({ status: 'error' }),
    );
    return () => controller.abort();
  }, [api, recording, name]);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  return state;
};

export const requestRecording = async (
  api: ApiClient,
  id: string,
  reason: string,
  t: ReturnType<typeof useT>,
  upTo?: number,
) => {
  try {
    return await api.requestRecording(id, reason, upTo);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      throw new DialogError(t('demos.recordingBusy'));
    if (error instanceof ApiError && error.status === 503)
      throw new DialogError(t('demos.recordingNotSetUp'));
    throw error;
  }
};
