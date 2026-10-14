import type { AltinnAuthorization, AltinnDecision, AltinnDecisionRequest } from './altinn.js';

export interface DecisionCacheOptions {
  permitSeconds?: number;
  denySeconds?: number;
  maxEntries?: number;
  now?: () => number;
}

const keyOf = (r: AltinnDecisionRequest) =>
  JSON.stringify([
    'personId' in r.subject ? 'person' : 'system-user',
    'personId' in r.subject ? r.subject.personId : r.subject.systemUserId,
    r.resource,
    r.action,
    r.party,
  ]);

export const cachedAltinnAuthorization = (
  inner: AltinnAuthorization,
  options: DecisionCacheOptions = {},
): AltinnAuthorization => {
  const permitSeconds = options.permitSeconds ?? 120;
  const denySeconds = options.denySeconds ?? 5;
  if (permitSeconds < 60 || permitSeconds > 300)
    throw new RangeError('permitSeconds must be between 60 and 300');
  if (denySeconds < 0 || denySeconds > 30)
    throw new RangeError('denySeconds must be between 0 and 30');
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { decision: AltinnDecision; until: number }>();

  return {
    decide: async (request) => {
      const key = keyOf(request);
      const hit = entries.get(key);
      if (hit && hit.until > now()) return hit.decision;
      entries.delete(key);
      const decision = await inner.decide(request);
      const ttl =
        decision === 'Permit' ? permitSeconds : decision === 'Indeterminate' ? 0 : denySeconds;
      if (ttl > 0) {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
        entries.set(key, { decision, until: now() + ttl * 1000 });
      }
      return decision;
    },
  };
};

export type ActionLookup = (personId: string, party: string, resource: string) => Promise<string[]>;

export interface ActionCacheOptions {
  seconds?: number;
  maxEntries?: number;
  now?: () => number;
}

export const cachedActionLookup = (
  inner: ActionLookup,
  options: ActionCacheOptions = {},
): ActionLookup => {
  const seconds = options.seconds ?? 120;
  if (seconds < 60 || seconds > 300) throw new RangeError('seconds must be between 60 and 300');
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { actions: Promise<string[]>; until: number }>();

  return (personId, party, resource) => {
    const key = JSON.stringify([personId, party, resource]);
    const hit = entries.get(key);
    if (hit && hit.until > now()) return hit.actions;
    entries.delete(key);
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
    const actions = inner(personId, party, resource);
    entries.set(key, { actions, until: now() + seconds * 1000 });
    actions.catch(() => {
      if (entries.get(key)?.actions === actions) entries.delete(key);
    });
    return actions;
  };
};
