import type { ScreenProps } from '../screen';
import { LiveWorkspace } from './stepflows/LiveWorkspace';

export const StepFlows = ({ api, tenant, route, live }: ScreenProps) => {
  const id = route.segments[1];
  return (
    <LiveWorkspace
      key={id ?? 'library'}
      api={api}
      tenant={tenant}
      query={route.query}
      flowId={id && id !== 'new' ? id : undefined}
      library={!id || id === 'new'}
      live={live}
    />
  );
};
