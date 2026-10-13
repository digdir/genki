import type { Principal } from '@genai/contracts';
import { decodeJwt } from 'jose';
import { verifyApiKey, type ApiKeyStore, type KeyGrants } from './api-keys.js';
import { actingFor, AuthenticationError, type VerifiedIdentity } from './verify.js';

export interface Authenticated {
  method: 'token' | 'api-key';
  principal: Principal;
  personId?: string;
  grants?: KeyGrants;
}

export interface AuthenticatorOptions {
  verifier?: { verify(token: string): Promise<VerifiedIdentity> };
  apiKeys?: ApiKeyStore;
  onVerified?: (identity: VerifiedIdentity) => void | Promise<void>;
  actingForHeader?: string;
  now?: () => Date;
}

export type AuthenticationResult =
  { ok: true; identity: Authenticated } | { ok: false; status: 401 | 403; code: string };

const looksLikeJwt = (value: string) => {
  if (value.split('.').length !== 3) return false;
  try {
    return typeof decodeJwt(value).iss === 'string';
  } catch {
    return false;
  }
};

const bearerOf = (request: Request) => {
  const header = request.headers.get('authorization');
  if (!header || !/^bearer /i.test(header)) return undefined;
  return header.slice('bearer '.length).trim() || undefined;
};

const chooseTenant = (principal: Principal, wanted: string | undefined): Principal => {
  if (wanted === undefined) return principal;
  if (principal.confinedTo && principal.confinedTo.tenant !== wanted)
    throw new AuthenticationError('not_authorized_for_org', `not authorized to act for ${wanted}`);
  if (principal.kind === 'employee') return actingFor(principal, wanted);
  if (principal.tenant !== wanted)
    throw new AuthenticationError('not_authorized_for_org', `not authorized to act for ${wanted}`);
  return principal;
};

export const actingForHeader = 'genai-acting-for';

export const createAuthenticator = (options: AuthenticatorOptions) => {
  const header = options.actingForHeader ?? actingForHeader;

  const check = async (request: Request): Promise<AuthenticationResult> => {
    const bearer = bearerOf(request);
    const xApiKey = request.headers.get('x-api-key') ?? undefined;
    const wanted = request.headers.get(header)?.trim() || undefined;
    try {
      if (bearer && looksLikeJwt(bearer)) {
        if (xApiKey !== undefined) return { ok: false, status: 401, code: 'ambiguous_credentials' };
        if (!options.verifier) return { ok: false, status: 401, code: 'unknown_issuer' };
        const verified = await options.verifier.verify(bearer);
        await options.onVerified?.(verified);
        return {
          ok: true,
          identity: {
            method: 'token',
            principal: chooseTenant(verified.principal, wanted),
            ...(verified.personId ? { personId: verified.personId } : {}),
          },
        };
      }
      const key = xApiKey ?? bearer;
      if (key === undefined) return { ok: false, status: 401, code: 'missing_credentials' };
      if (!options.apiKeys) return { ok: false, status: 401, code: 'invalid_token' };
      const verified = await verifyApiKey(options.apiKeys, key, options.now?.());
      return {
        ok: true,
        identity: {
          method: 'api-key',
          principal: chooseTenant(verified.principal, wanted),
          grants: verified.grants,
        },
      };
    } catch (error) {
      if (error instanceof AuthenticationError)
        return {
          ok: false,
          status: error.code === 'not_authorized_for_org' ? 403 : 401,
          code: error.code,
        };
      return { ok: false, status: 401, code: 'invalid_token' };
    }
  };

  return {
    check,
    authenticate: async (request: Request): Promise<Authenticated | undefined> => {
      const result = await check(request);
      return result.ok ? result.identity : undefined;
    },
    principalOf: async (request: Request): Promise<Principal | undefined> => {
      const result = await check(request);
      return result.ok ? result.identity.principal : undefined;
    },
  };
};
