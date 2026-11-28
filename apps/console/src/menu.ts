import type { FlagKey } from '@genai/contracts/flags';
import type { PlainKey } from './i18n';

export interface MenuPage {
  path: string;
  tab?: string;
  label: PlainKey;
  flag?: FlagKey;
}

export interface MenuItem {
  id: string;
  label: PlainKey;
  icon: string;
  path: string;
  pages?: MenuPage[];
  also?: string[];
}

export interface MenuGroup {
  id: string;
  label: PlainKey;
  items: MenuItem[];
}

export const menu: MenuGroup[] = [
  {
    id: 'work',
    label: 'frame.groupWork',
    items: [
      {
        id: 'queue',
        label: 'frame.itemQueue',
        icon: 'M2.5 10h4l1 2h3l1-2h4M2.5 10 4.5 3.5h9l2 6.5v5h-13z',
        path: '/queue',
        pages: [
          { path: '/queue', label: 'frame.pageQueueDecisions' },
          { path: '/quota-requests', label: 'frame.pageQueueQuota' },
        ],
      },
      {
        id: 'tenants',
        label: 'frame.itemTenants',
        icon: 'M3 15.5V3h7v12.5M10 7h5v8.5M1.5 15.5h15M5.5 6h2M5.5 9h2M5.5 12h2M12 10h1M12 12.5h1',
        path: '/tenants',
        pages: [
          { path: '/tenants', label: 'frame.pageTenantsAll' },
          { path: '/onboarding', label: 'frame.pageTenantsOnboarding' },
        ],
        also: ['/tenants/services', '/support-access'],
      },
      {
        id: 'operations',
        label: 'frame.itemOperations',
        icon: 'M1.5 9h3l2-5 4 10 2-5h4',
        path: '/operations',
        also: ['/diagnostics'],
      },
      {
        id: 'audit',
        label: 'frame.itemAudit',
        icon: 'M6 4h10M6 9h10M6 14h10M2.5 4h.01M2.5 9h.01M2.5 14h.01',
        path: '/audit',
      },
    ],
  },
  {
    id: 'platform',
    label: 'frame.groupPlatform',
    items: [
      {
        id: 'models',
        label: 'frame.itemModels',
        icon: 'M5 5h8v8H5zM7 2v3M11 2v3M7 13v3M11 13v3M2 7h3M2 11h3M13 7h3M13 11h3',
        path: '/models',
        pages: [
          { path: '/models', label: 'frame.pageModelsModels' },
          { path: '/models', tab: 'connections', label: 'frame.pageModelsConnections' },
          { path: '/catalog', label: 'frame.pageModelsEndpoints' },
          { path: '/search-engines', label: 'frame.pageModelsEngines' },
        ],
        also: ['/model-operations'],
      },
      {
        id: 'catalog',
        label: 'frame.itemCatalog',
        icon: 'M9 2 13 6 9 10 5 6zM9 10l4 4-4 4-4-4z',
        path: '/building-blocks',
        pages: [
          { path: '/building-blocks', label: 'frame.pageCatalogAll' },
          { path: '/block-reviews', label: 'frame.pageCatalogReviews', flag: 'blockStudio' },
        ],
      },
      {
        id: 'shared',
        label: 'frame.itemSharedServices',
        icon: 'M6.5 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 15c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M12 8.5a2 2 0 1 0 0-4M13.5 11c1.6.4 2.5 1.8 2.5 4',
        path: '/shared-services',
      },
      {
        id: 'quality',
        label: 'frame.itemQuality',
        icon: 'M3 9.5 7 13.5 15 4.5',
        path: '/quality',
        pages: [
          { path: '/quality', label: 'frame.pageQualityOverview' },
          { path: '/quality-matrix', label: 'frame.pageQualityMatrix' },
          { path: '/policies', label: 'frame.pageQualityPolicies' },
          { path: '/tracing', label: 'frame.pageQualityTracing' },
        ],
      },
      {
        id: 'flags',
        label: 'frame.itemFlags',
        icon: 'M6 5.5h6a3.5 3.5 0 0 1 0 7H6a3.5 3.5 0 0 1 0-7zM12 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
        path: '/flags',
      },
      {
        id: 'demos',
        label: 'frame.itemDemos',
        icon: 'M3 3h12v12H3zM7.5 6.5v5l4-2.5z',
        path: '/demos',
      },
      {
        id: 'settings',
        label: 'frame.itemSettings',
        icon: 'M9 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4',
        path: '/settings',
        pages: [
          { path: '/settings', label: 'frame.pageSettingsDefaults' },
          { path: '/platform-secrets', label: 'frame.pageSettingsSecrets' },
          { path: '/state-register', label: 'frame.pageSettingsStateRegister' },
        ],
        also: ['/platform-defaults'],
      },
    ],
  },
];

const routesOf = (item: MenuItem) => [
  item.path,
  ...(item.pages ?? []).map((p) => p.path),
  ...(item.also ?? []),
];

export const menuItemFor = (path: string): MenuItem | undefined =>
  menu.flatMap((g) => g.items).find((item) => routesOf(item).includes(path));
