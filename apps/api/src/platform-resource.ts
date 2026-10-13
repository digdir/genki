import type { VerifiedIdentity } from '@genai/identity';
import { PLATFORM_RESOURCE } from '@genai/identity';

const idOf = (urn: string) => urn.replace(/^urn:altinn:resource:/, '');

export const asPlatformResource = <V extends { verify(token: string): Promise<VerifiedIdentity> }>(
  verifier: V,
  configured: string,
): V => {
  if (idOf(configured) === idOf(PLATFORM_RESOURCE)) return verifier;
  return {
    ...verifier,
    verify: async (token: string) => {
      const verified = await verifier.verify(token);
      const authorizedFor = verified.principal.authorizedFor?.map((entry) =>
        entry.resource !== undefined && idOf(entry.resource) === idOf(configured)
          ? { ...entry, resource: PLATFORM_RESOURCE }
          : entry,
      );
      return authorizedFor
        ? { ...verified, principal: { ...verified.principal, authorizedFor } }
        : verified;
    },
  };
};
