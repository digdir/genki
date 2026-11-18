import type { Route } from '../../hooks';

export const datasetHref = (id: string, query = '') =>
  `#/datasets/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;

export const detailTabs = ['content', 'ingestions', 'used-by', 'filters', 'source'] as const;

export type DetailTab = (typeof detailTabs)[number];

export const detailTabOf = (route: Route): DetailTab =>
  detailTabs.find((tab) => tab === route.segments[2]) ??
  detailTabs.find((tab) => tab === route.query.get('tab')) ??
  'content';

export const datasetTabPath = (id: string, tab: DetailTab, query = '') =>
  `/datasets/${encodeURIComponent(id)}/${tab}${query ? `?${query}` : ''}`;
