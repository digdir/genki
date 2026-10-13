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
