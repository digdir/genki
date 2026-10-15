import type { Principal, PrincipalKind } from '@genai/contracts';

export const configuredCredentialScope = 'grant:configured-credential';

const people = new Set<PrincipalKind>(['employee', 'operator', 'citizen']);

export const isLockdown = (env: Record<string, string | undefined>) =>
  env.GENAI_LOCKDOWN === 'true';

export const mayUseModels = (principal: Principal | undefined) =>
  principal !== undefined &&
  !people.has(principal.kind) &&
  (principal.scopes?.includes(configuredCredentialScope) ?? false);
