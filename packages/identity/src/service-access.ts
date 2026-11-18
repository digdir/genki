import type { Principal, Ref } from '@genai/contracts';
import type { PolicyDecisionPoint } from '@genai/kernel';
import type { PersonKey } from './altinn-people.js';
import { platformRightsOf } from './platform-rights.js';
import type { IdentityLookup } from './policy.js';

export interface ServiceAccessOptions {
  selectedFor(tenant: string, service: string): Promise<readonly string[] | undefined>;
  identities: IdentityLookup;
  key: PersonKey;
  draftServiceOf?: (capability: string) => ServiceTarget | undefined;
}

export interface ServiceTarget {
  tenant: string;
  service: string;
}

export const serviceOfCapability = (resource: Ref) => {
  const [owner, service] = resource.id.split('/');
  if (resource.kind !== 'capability' || !owner || !service) return undefined;
  return { tenant: owner, service };
};

/** Limits invoking a service to the people its tenant selected; machines and operators are not people and pass through. */
export const serviceAccessPolicy = (
  inner: PolicyDecisionPoint,
  options: ServiceAccessOptions,
): PolicyDecisionPoint => ({
  decide: async (principal: Principal, action, resource) => {
    if (action !== 'invoke' || principal.kind !== 'employee')
      return inner.decide(principal, action, resource);
    const draft =
      resource.kind === 'capability' ? options.draftServiceOf?.(resource.id) : undefined;
    const target = draft ?? serviceOfCapability(resource);
    if (!target || principal.tenant !== target.tenant)
      return inner.decide(principal, action, resource);
    if (draft && platformRightsOf(principal, target.tenant).includes('manage-services'))
      return inner.decide(principal, action, resource);
    let selected: readonly string[] | undefined;
    try {
      selected = await options.selectedFor(target.tenant, target.service);
    } catch {
      return { allow: false, reason: 'the access list for this service could not be read' };
    }
    if (selected === undefined) return inner.decide(principal, action, resource);
    const personId = await options.identities.personId(principal.issuer, principal.subject);
    if (!personId || !selected.includes(options.key(personId)))
      return {
        allow: false,
        reason: 'the organisation has limited this service to selected people',
      };
    return inner.decide(principal, action, resource);
  },
});
