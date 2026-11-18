import { PlaygroundPanel } from '../components/playground/PlaygroundPanel';
import type { ScreenProps } from '../screen';

export const Playground = ({ api, tenant, tenantName }: ScreenProps) => (
  <PlaygroundPanel layout="page" api={api} tenant={tenant} tenantName={tenantName} />
);
