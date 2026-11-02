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

/** Where an old Integrasjoner address lives now, keeping which row was open or saved. */
export const developerHashFor = ({ segments, query }: Route) => {
  if (segments[1] === 'code') return '#/developer/api/code';
  if (segments[1] === 'hooks' && segments[2])
    return `#/developer/hooks/${encodeURIComponent(segments[2])}`;
  const rest = new URLSearchParams(query);
  rest.delete('tab');
  const search = rest.toString();
  return `#/developer/${developerPageFor(query.get('tab'))}${search ? `?${search}` : ''}`;
};
