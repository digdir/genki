import { createContext } from 'react';
import type { Route } from '../hooks';

/** The Integrasjoner tab each developer tools page shows, by page id. */
export const developerTabs: Readonly<Record<string, string>> = {
  keys: 'keys',
  frontends: 'frontends',
  systems: 'systems',
  triggers: 'triggers',
  hooks: 'hooks',
  runs: 'tracing',
  api: 'docs',
};

export const IntegrationTab = createContext<string | undefined>(undefined);

export const developerPageFor = (tab: string | null) =>
  Object.keys(developerTabs).find((page) => developerTabs[page] === (tab ?? 'systems')) ??
  'systems';

const withQuery = (hash: string, query: URLSearchParams) => {
  const search = query.toString();
  return `${hash}${search ? `?${search}` : ''}`;
};

/** Where an old Integrasjoner address lives now, keeping which row was open or saved. */
export const developerHashFor = ({ segments, query }: Route) => {
  if (segments[1] === 'code') return '#/developer/api';
  if (segments[1] === 'hooks' && segments[2])
    return `#/developer/hooks/${encodeURIComponent(segments[2])}`;
  const rest = new URLSearchParams(query);
  rest.delete('tab');
  return withQuery(`#/developer/${developerPageFor(query.get('tab'))}`, rest);
};

/** The service whose Utviklerverktøy tab shows the integrations, when it is one service's tab. */
export const IntegrationService = createContext<{ id: string; name: string } | undefined>(
  undefined,
);

export const apiReferenceHashFor = ({ query }: Route) =>
  withQuery('#/developer/api/reference', query);
