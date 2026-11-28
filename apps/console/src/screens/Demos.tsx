import type { ApiClient } from '../api';
import { DemoEditor } from './demos/Editor';
import { DemoSettingsScreen } from './demos/DemoSettings';
import { Library } from './demos/Library';
import { RecordingScreen } from './demos/Recording';
import { SoundScreen } from './demos/Sound';
import { DemoStudio } from './demos/Studio';
import './demos.css';

export { clock, demoState } from './demos/shared';

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
  if (demo && params.get('sound')) return <SoundScreen api={api} id={demo} />;
  return demo ? <DemoStudio key={demo} api={api} id={demo} /> : <Library api={api} />;
};
