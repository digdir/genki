import type { UserPreferences } from '../api/preferences';
import type { MockHandler } from '../mock';

export const preferencesMock = (initial: Partial<UserPreferences> = {}): MockHandler => {
  let current: UserPreferences = { writtenStandard: null, language: null, ...initial };
  return (req) => {
    if (!/^\/tenants\/[^/]+\/me\/preferences$/.test(req.path)) return undefined;
    if (req.method === 'GET') return req.json(current);
    if (req.method !== 'PUT') return undefined;
    if (!req.reason) return req.reasonMissing();
    current = { ...current, ...req.body<Partial<UserPreferences>>() };
    return req.json(current);
  };
};
