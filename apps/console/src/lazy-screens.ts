import { lazy, type ComponentType } from 'react';
import { withTexts, type Area } from './i18n/areas';

const screen = <P extends object>(area: Area, load: () => Promise<ComponentType<P>>) => {
  const preload = withTexts(area, load);
  return Object.assign(
    lazy(() => preload().then((component) => ({ default: component }))),
    { preload },
  );
};

export const Atlas = screen('atlas', () => import('./screens/Atlas').then((m) => m.Atlas));
export const Audit = screen('audit', () => import('./screens/Audit').then((m) => m.Audit));
export const BlockReviews = screen('blockReviews', () =>
  import('./screens/BlockReviews').then((m) => m.BlockReviews),
);
export const BuildingBlocks = screen('buildingBlocks', () =>
  import('./screens/BuildingBlocks').then((m) => m.BuildingBlocks),
);
export const Catalog = screen('catalog', () => import('./screens/Catalog').then((m) => m.Catalog));
export const Demos = screen('demos', () => import('./screens/Demos').then((m) => m.Demos));
export const Diagnostics = screen('diagnostics', () =>
  import('./screens/Diagnostics').then((m) => m.Diagnostics),
);
export const Flags = screen('flags', () => import('./screens/Flags').then((m) => m.Flags));
export const Inbox = screen('inbox', () => import('./screens/inbox/Inbox').then((m) => m.Inbox));
export const Models = screen('models', () => import('./screens/Models').then((m) => m.Models));
export const Onboarding = screen('onboarding', () =>
  import('./screens/Onboarding').then((m) => m.Onboarding),
);
export const Operations = screen('operations', () =>
  import('./screens/Operations').then((m) => m.Operations),
);
export const OrgPage = screen('orgPage', () =>
  import('./screens/org/OrgPage').then((m) => m.OrgPage),
);
export const PlatformDefaults = screen('platformDefaults', () =>
  import('./screens/PlatformDefaults').then((m) => m.PlatformDefaults),
);
export const PlatformSecrets = screen('platformSecrets', () =>
  import('./screens/PlatformSecrets').then((m) => m.PlatformSecrets),
);
export const Policies = screen('policies', () =>
  import('./screens/Policies').then((m) => m.Policies),
);
export const Quality = screen('quality', () => import('./screens/Quality').then((m) => m.Quality));
export const QualityMatrix = screen('qualityMatrix', () =>
  import('./screens/QualityMatrix').then((m) => m.QualityMatrix),
);
export const Queue = screen('queue', () => import('./screens/Queue').then((m) => m.Queue));
export const QuotaRequests = screen('quotaRequests', () =>
  import('./screens/QuotaRequests').then((m) => m.QuotaRequests),
);
export const Run = screen('run', () => import('./screens/operate/Run').then((m) => m.Run));
export const Schemas = screen('schemas', () => import('./screens/Schemas').then((m) => m.Schemas));
export const SearchEngines = screen('searchEngines', () =>
  import('./screens/SearchEngines').then((m) => m.SearchEngines),
);
export const Settings = screen('settings', () =>
  import('./screens/Settings').then((m) => m.Settings),
);
export const SharedServices = screen('sharedServices', () =>
  import('./screens/SharedServices').then((m) => m.SharedServices),
);
export const StateRegister = screen('stateRegister', () =>
  import('./screens/StateRegister').then((m) => m.StateRegister),
);
export const TenantServices = screen('tenantServices', () =>
  import('./screens/TenantServices').then((m) => m.TenantServices),
);
export const Tenants = screen('tenants', () => import('./screens/Tenants').then((m) => m.Tenants));
export const Tracing = screen('tracing', () => import('./screens/Tracing').then((m) => m.Tracing));
