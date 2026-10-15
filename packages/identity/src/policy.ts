import type { Principal, Ref } from '@genai/contracts';
import type { Decision, PolicyAction, PolicyDecisionPoint } from '@genai/kernel';
import type { AltinnAuthorization, AltinnDecisionRequest } from './altinn.js';
import { capabilityModes, grantsOf, keyReaches, keyReachesMode } from './api-keys.js';
import { trustedEntraScope } from './claims.js';
import type { VerifiedIdentity } from './verify.js';

export interface IdentityLookup {
  personId(issuer: string, subject: string): Promise<string | undefined>;
}

export class InMemoryIdentities implements IdentityLookup {
  readonly #people = new Map<string, string>();

  remember(identity: VerifiedIdentity): void {
    if (identity.personId)
      this.#people.set(
        `${identity.principal.issuer} ${identity.principal.subject}`,
        identity.personId,
      );
  }

  async personId(issuer: string, subject: string): Promise<string | undefined> {
    return this.#people.get(`${issuer} ${subject}`);
  }
}

export interface ServiceRequirement {
  resource: string;
  action: string;
  scope?: string;
}

export interface AltinnPolicyOptions {
  altinn: AltinnAuthorization;
  identities: IdentityLookup;
  requirementFor(capability: Ref): ServiceRequirement | undefined;
  otherActions?: PolicyDecisionPoint;
}

const deny = (reason: string): Decision => ({ allow: false, reason });

export const altinnPolicy = (options: AltinnPolicyOptions): PolicyDecisionPoint => {
  const subjectOf = async (
    principal: Principal,
    tenant: string,
    requirement: ServiceRequirement,
  ): Promise<AltinnDecisionRequest['subject'] | Decision> => {
    if (principal.scopes?.includes(trustedEntraScope))
      return principal.authorizedFor?.some(
        (a) => a.org === tenant && a.actions?.includes(requirement.action),
      )
        ? { allow: true }
        : deny(`the Entra login carries no ${requirement.action} right for ${tenant}`);
    if (principal.kind === 'employee') {
      if (!principal.authorizedFor?.some((a) => a.org === tenant))
        return deny(`the login does not carry rights for ${tenant}`);
      const personId = await options.identities.personId(principal.issuer, principal.subject);
      return personId ? { personId } : deny('unknown person');
    }
    if (requirement.scope && !principal.scopes?.includes(requirement.scope))
      return deny(`missing scope ${requirement.scope}`);
    if (principal.kind === 'vendor-system' && principal.systemUser)
      return { systemUserId: principal.systemUser };
    if (principal.kind === 'agency-system' && requirement.scope) return { allow: true };
    return deny(`${principal.kind} principals cannot invoke this service`);
  };

  return {
    decide: async (
      principal: Principal,
      action: PolicyAction,
      resource: Ref,
    ): Promise<Decision> => {
      if (action !== 'invoke')
        return options.otherActions?.decide(principal, action, resource) ?? { allow: true };
      const requirement = options.requirementFor(resource);
      if (!requirement) return deny('no Altinn requirement is configured for this service');
      const tenant = principal.tenant;
      if (!tenant) return deny('choose which organisation you act for');
      try {
        const subject = await subjectOf(principal, tenant, requirement);
        if ('allow' in subject) return subject;
        const decision = await options.altinn.decide({
          subject,
          action: requirement.action,
          resource: requirement.resource,
          party: tenant,
        });
        return decision === 'Permit' ? { allow: true } : deny(`Altinn answered ${decision}`);
      } catch {
        return deny('the authorization service is unavailable');
      }
    },
  };
};

export const confinedPolicy = (inner: PolicyDecisionPoint): PolicyDecisionPoint => ({
  decide: async (principal, action, resource) => {
    const confined = principal.confinedTo;
    if (!confined) return inner.decide(principal, action, resource);
    if (principal.tenant !== confined.tenant)
      return deny(`this credential only acts for ${confined.tenant}`);
    if (action === 'invoke' && confined.service !== undefined) {
      const [owner, service] = resource.id.split('/');
      if (
        resource.kind !== 'capability' ||
        owner !== confined.tenant ||
        service !== confined.service
      )
        return deny(`this credential only reaches the service ${confined.service}`);
    }
    return inner.decide(principal, action, resource);
  },
});

export const keyGrantPolicy = (
  inner: PolicyDecisionPoint,
  namesOf: (capability: Ref) => string[] | Promise<string[]>,
): PolicyDecisionPoint => ({
  decide: async (principal, action, resource) => {
    if (action === 'invoke' && resource.kind === 'capability' && grantsOf(principal)) {
      const names = await namesOf(resource);
      if (!keyReaches(principal, 'query', { agents: names }))
        return deny('the API key is not granted this service');
      if (!keyReachesMode(principal, capabilityModes(resource.id, names)))
        return deny('the API key is not granted this mode');
    }
    return inner.decide(principal, action, resource);
  },
});
