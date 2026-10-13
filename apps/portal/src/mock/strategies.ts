import type { StrategyEntry } from '../data/strategies';
import catalogue from './strategies.json';
import served from './strategy-schemas.json';

export const platformStrategies = catalogue.data as StrategyEntry[];

export const strategyRoutes = (path: string): unknown => {
  if (/^\/tenants\/[^/]+\/definitions\/strategies$/.test(path)) return { data: platformStrategies };
  if (path === '/schemas') return { data: served.list };
  return (served.schemas as Record<string, unknown>)[path];
};
