import type { Principal } from '@genai/contracts';
import {
  actingFor,
  actingForHeader,
  AuthenticationError,
  type createTokenVerifier,
} from '@genai/identity';
import type { Authenticator } from './http.js';

export const bearerAuthenticator = (
  verifier: ReturnType<typeof createTokenVerifier>,
  operators: (principal: Principal) => boolean = () => false,
): Authenticator => ({
  authenticate: async (request) => {
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1]) return undefined;
    try {
      const { principal } = await verifier.verify(match[1]);
      if (principal.confinedTo) return undefined;
      const org = request.headers.get(actingForHeader);
      const acting = org && org !== principal.tenant ? actingFor(principal, org) : principal;
      return operators(acting) ? { ...acting, kind: 'operator' } : acting;
    } catch (error) {
      if (error instanceof AuthenticationError) return undefined;
      throw error;
    }
  },
});
