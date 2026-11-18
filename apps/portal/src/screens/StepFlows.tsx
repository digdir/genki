import { useEffect } from 'react';
import type { ScreenProps } from '../screen';
import { LiveWorkspace } from './stepflows/LiveWorkspace';

export const flowEditPath = (id: string) =>
  `/building-blocks/step_flow/${encodeURIComponent(id)}/edit`;

export const StepFlows = ({ api, tenant, route, live }: ScreenProps) => {
  const id = route.segments[1];
  const search = route.query.toString();
  const moved = id && id !== 'new' ? `${flowEditPath(id)}${search ? `?${search}` : ''}` : undefined;
  useEffect(() => {
    if (moved) window.location.replace(`#${moved}`);
  }, [moved]);
  if (moved) return null;
  return (
    <LiveWorkspace
      key={id ?? 'library'}
      api={api}
      tenant={tenant}
      query={route.query}
      library
      live={live}
    />
  );
};

export const StepFlowEditor = ({ api, tenant, route, live, id }: ScreenProps & { id: string }) => (
  <LiveWorkspace
    key={id}
    api={api}
    tenant={tenant}
    query={route.query}
    flowId={id}
    library={false}
    live={live}
  />
);
