import type { AltinnAuthorization } from './altinn.js';
import type { ActionLookup } from './cache.js';
import { resourceId } from './claims.js';
import { PLATFORM_RIGHTS } from './platform-rights.js';
import type { VerifiedIdentity } from './verify.js';

export const PDP_ACTIONS: readonly string[] = ['read', 'write', ...PLATFORM_RIGHTS];

export const altinnActionLookup =
  (altinn: AltinnAuthorization, actions: readonly string[] = PDP_ACTIONS): ActionLookup =>
  async (personId, party, resource) => {
    const decisions = await Promise.all(
      actions.map((action) => altinn.decide({ subject: { personId }, action, resource, party })),
    );
    return actions.filter((_, i) => decisions[i] === 'Permit');
  };

export interface AltinnActionsOptions {
  lookup: ActionLookup;
  resource: string;
  onError?: (error: unknown) => void;
}

export const withAltinnActions = <V extends { verify(token: string): Promise<VerifiedIdentity> }>(
  verifier: V,
  options: AltinnActionsOptions,
): V => ({
  ...verifier,
  verify: async (token: string) => {
    const verified = await verifier.verify(token);
    const { personId, partiesWithoutActions: listed = [] } = verified;
    const entries = verified.principal.authorizedFor;
    if (!personId || !entries || listed.length === 0) return verified;
    const asks = (entry: (typeof entries)[number]) =>
      entry.resource !== undefined &&
      resourceId(entry.resource) === resourceId(options.resource) &&
      listed.some((p) => p.org === entry.org && p.resource === entry.resource);
    const authorizedFor = await Promise.all(
      entries.map(async (entry) => {
        if (!asks(entry)) return entry;
        try {
          return {
            ...entry,
            actions: await options.lookup(personId, entry.org, entry.resource as string),
          };
        } catch (error) {
          options.onError?.(error);
          return { ...entry, actions: [] };
        }
      }),
    );
    return { ...verified, principal: { ...verified.principal, authorizedFor } };
  },
});
