import { flagKeys, flags, isFlagKey, type FlagKey, type FlagState } from '@genai/contracts/flags';
import type { MockHandler } from '../mock';

export interface FlagsMockOptions {
  person?: Partial<Record<FlagKey, boolean>>;
  tenant?: Partial<Record<FlagKey, boolean>>;
}

export const flagsMock = (options: FlagsMockOptions = {}): MockHandler => {
  const person = new Map(Object.entries(options.person ?? {}) as [FlagKey, boolean][]);
  const tenant = new Map(Object.entries(options.tenant ?? {}) as [FlagKey, boolean][]);
  const stateOf = (key: FlagKey): FlagState => {
    const mine = person.get(key);
    const theirs = tenant.get(key);
    return {
      key,
      on: mine ?? theirs ?? false,
      source: mine !== undefined ? 'person' : theirs !== undefined ? 'tenant' : 'default',
      selfService: flags[key].selfService,
      person: mine ?? null,
      tenant: theirs ?? null,
    };
  };
  return (req) => {
    if (/^\/tenants\/[^/]+\/me\/flags$/.test(req.path) && req.method === 'GET')
      return req.json({ data: flagKeys.map(stateOf) });
    const change = /^\/tenants\/[^/]+\/(me\/)?flags\/([^/]+)$/.exec(req.path);
    if (!change || req.method !== 'PUT') return undefined;
    const key = decodeURIComponent(change[2] ?? '');
    if (!isFlagKey(key)) return req.notFound();
    const own = change[1] !== undefined;
    if (!own && !req.reason) return req.reasonMissing();
    const { on } = req.body<{ on: boolean | null }>();
    const level = own ? person : tenant;
    if (on === null) level.delete(key);
    else level.set(key, on);
    return req.json(stateOf(key));
  };
};
