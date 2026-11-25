import type { Principal, PrincipalKind } from '@genai/contracts';
import { memberEntraScope, serviceEntraScope, trustedEntraScope } from '@genai/identity';

export const configuredCredentialScope = 'grant:configured-credential';

export { memberEntraScope, serviceEntraScope, trustedEntraScope };

type Env = Record<string, string | undefined>;

const people = new Set<PrincipalKind>(['employee', 'operator', 'citizen']);

export const isLockdown = (env: Env) => env.GENAI_LOCKDOWN === 'true';

export const isTrustedEntraLogin = (principal: Principal) =>
  principal.scopes?.includes(trustedEntraScope) ?? false;

export const isAdmittedEntraLogin = (principal: Principal) =>
  isTrustedEntraLogin(principal) ||
  (people.has(principal.kind) && (principal.scopes?.includes(memberEntraScope) ?? false));

export const isServiceLogin = (principal: Principal) =>
  people.has(principal.kind) &&
  principal.confinedTo?.service !== undefined &&
  (principal.scopes?.includes(serviceEntraScope) ?? false);

export const mayUseModels = (principal: Principal | undefined) =>
  principal !== undefined &&
  (isAdmittedEntraLogin(principal) ||
    (!people.has(principal.kind) &&
      (principal.scopes?.includes(configuredCredentialScope) ?? false)));

export const mayInvokeServices = (principal: Principal | undefined) =>
  mayUseModels(principal) || (principal !== undefined && isServiceLogin(principal));

export const withModelAdmission = (system: Principal): Principal => ({
  ...system,
  scopes: [...new Set([...(system.scopes ?? []), configuredCredentialScope])],
});

export const readOnlyInLockdown = (principal: Principal) =>
  people.has(principal.kind) && !isAdmittedEntraLogin(principal);
