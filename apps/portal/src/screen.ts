import type { ApiClient } from './api';
import type { Route } from './hooks';

export interface ScreenProps {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  route: Route;
  live: boolean;
}

export interface ServiceScreenProps extends ScreenProps {
  id: string;
}

export type SettingsContext =
  { kind: 'tenant' } | { kind: 'service'; id: string } | { kind: 'dataset'; id: string };
