import type { Assurance, Principal } from '@genai/contracts';
import {
  createLocalJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  fromOrgNo,
  INTERNAL_GRANT_PREFIX,
  type AltinnResourceDetail,
  type OrgNo,
  type SystemUserDetail,
} from './claims.js';

export type AuthenticationErrorCode =
  | 'unknown_issuer'
  | 'invalid_token'
  | 'insufficient_assurance'
  | 'missing_scope'
  | 'missing_role'
  | 'not_authorized_for_org';

export class AuthenticationError extends Error {
  constructor(
    readonly code: AuthenticationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface RegisteredClient {
  clientId: string;
  audience: string;
  tenant: string;
  service: string;
  client: string;
}

export interface ClientRegistry {
  byClientId(clientId: string): Promise<RegisteredClient | undefined>;
}

export type TrustedIssuer =
  | {
      kind: 'ansattporten';
      issuer: string;
      audience: string;
      keys: JWTVerifyGetKey;
      minAssurance?: 'substantial' | 'high';
      acceptEntraId?: boolean;
      registeredClients?: ClientRegistry;
    }
  | {
      kind: 'maskinporten';
      issuer: string;
      audience: string;
      keys: JWTVerifyGetKey;
      requiredScopes?: string[];
    }
  | {
      kind: 'entra';
      issuer: string;
      tenantId: string;
      audience: string;
      keys: JWTVerifyGetKey;
      roles: Record<string, string>;
      allowApplications?: boolean;
    };

export interface VerifiedIdentity {
  principal: Principal;
  personId?: string;
}

export interface TokenVerifierOptions {
  issuers: TrustedIssuer[];
  clockToleranceSeconds?: number;
}

export const remoteJwks = (
  uri: string,
  fetchFn: typeof fetch = fetch,
  refetchCooldownMs = 30_000,
): JWTVerifyGetKey => {
  let keys: ReturnType<typeof createLocalJWKSet> | undefined;
  let fetchedAt = 0;
  const load = async () => {
    const response = await fetchFn(uri);
    if (!response.ok) throw new Error(`JWKS ${uri} answered ${response.status}`);
    keys = createLocalJWKSet((await response.json()) as JSONWebKeySet);
    fetchedAt = Date.now();
    return keys;
  };
  return async (header, token) => {
    const current = keys ?? (await load());
    try {
      return await current(header, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey && Date.now() - fetchedAt > refetchCooldownMs)
        return (await load())(header, token);
      throw error;
    }
  };
};

const assuranceOf = (acr: unknown): Assurance | undefined => {
  if (acr === 'high' || acr === 'idporten-loa-high') return 'high';
  if (acr === 'substantial' || acr === 'idporten-loa-substantial') return 'substantial';
  if (acr === 'entraid') return 'entraid';
  return undefined;
};

const expiresAt = (payload: JWTPayload) =>
  payload.exp === undefined ? {} : { expiresAt: new Date(payload.exp * 1000).toISOString() };

const employee = (
  issuer: Extract<TrustedIssuer, { kind: 'ansattporten' }>,
  payload: JWTPayload,
): VerifiedIdentity => {
  const assurance = assuranceOf(payload.acr);
  if (!assurance) throw new AuthenticationError('insufficient_assurance', 'unknown acr');
  if (assurance === 'entraid' && !issuer.acceptEntraId)
    throw new AuthenticationError('insufficient_assurance', 'Entra ID logins are not accepted');
  if (issuer.minAssurance === 'high' && assurance !== 'high')
    throw new AuthenticationError('insufficient_assurance', 'this service requires high assurance');

  const details = Array.isArray(payload.authorization_details)
    ? (payload.authorization_details as AltinnResourceDetail[])
    : [];
  const authorizedFor = details
    .filter((d) => d.type === 'ansattporten:altinn:resource')
    .flatMap((d) =>
      (d.authorized_parties ?? []).flatMap((p) => {
        const org = fromOrgNo(p.orgno);
        return org ? [{ org, resource: d.resource, actions: p.actions ?? [] }] : [];
      }),
    );
  const orgs = [...new Set(authorizedFor.map((a) => a.org))];
  const pid = typeof payload.pid === 'string' ? payload.pid : undefined;

  return {
    principal: {
      kind: 'employee',
      issuer: issuer.issuer,
      subject: payload.sub as string,
      assurance,
      authorizedFor,
      ...(orgs.length === 1 ? { tenant: orgs[0] } : {}),
      ...expiresAt(payload),
    },
    ...(pid ? { personId: pid } : {}),
  };
};

const system = (
  issuer: Extract<TrustedIssuer, { kind: 'maskinporten' }>,
  payload: JWTPayload,
): VerifiedIdentity => {
  const scopes =
    typeof payload.scope === 'string'
      ? payload.scope.split(' ').filter((s) => s && !s.startsWith(INTERNAL_GRANT_PREFIX))
      : [];
  const missing = (issuer.requiredScopes ?? []).filter((s) => !scopes.includes(s));
  if (missing.length > 0)
    throw new AuthenticationError('missing_scope', `missing scope ${missing.join(', ')}`);
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : undefined;
  const consumer = fromOrgNo(payload.consumer as OrgNo | undefined);
  if (!clientId || !consumer)
    throw new AuthenticationError('invalid_token', 'missing client_id or consumer');
  const supplier = fromOrgNo(payload.supplier as OrgNo | undefined);
  const systemUser = (
    Array.isArray(payload.authorization_details) ? payload.authorization_details : []
  ).find((d: { type?: string }) => d.type === 'urn:altinn:systemuser') as
    SystemUserDetail | undefined;

  if (systemUser) {
    const customer = fromOrgNo(systemUser.systemuser_org);
    const id = systemUser.systemuser_id[0];
    if (!customer || !id) throw new AuthenticationError('invalid_token', 'incomplete system user');
    return {
      principal: {
        kind: 'vendor-system',
        issuer: issuer.issuer,
        subject: id,
        tenant: customer,
        client: clientId,
        supplier: consumer,
        systemUser: id,
        scopes,
        ...expiresAt(payload),
      },
    };
  }

  const vendor = supplier !== undefined && supplier !== consumer;
  return {
    principal: {
      kind: vendor ? 'vendor-system' : 'agency-system',
      issuer: issuer.issuer,
      subject: clientId,
      tenant: consumer,
      client: clientId,
      scopes,
      ...(vendor ? { supplier } : {}),
      ...expiresAt(payload),
    },
  };
};

const operator = (
  issuer: Extract<TrustedIssuer, { kind: 'entra' }>,
  payload: JWTPayload,
): VerifiedIdentity => {
  if (payload.tid !== issuer.tenantId)
    throw new AuthenticationError('invalid_token', 'the token is from another Entra tenant');
  if (typeof payload.oid !== 'string')
    throw new AuthenticationError('invalid_token', 'missing oid');
  if (typeof payload.scp !== 'string' && !issuer.allowApplications)
    throw new AuthenticationError('invalid_token', 'application tokens are not accepted');
  const granted = Array.isArray(payload.roles)
    ? payload.roles.filter((r) => typeof r === 'string')
    : [];
  const roles = [
    ...new Set(
      granted.flatMap((r: string) =>
        Object.hasOwn(issuer.roles, r) ? [issuer.roles[r] as string] : [],
      ),
    ),
  ];
  if (roles.length === 0)
    throw new AuthenticationError('missing_role', 'the token carries no platform role');
  return {
    principal: {
      kind: 'operator',
      issuer: issuer.issuer,
      subject: payload.oid,
      assurance: 'entraid',
      roles,
      ...expiresAt(payload),
    },
  };
};

const confineToClient = (
  identity: VerifiedIdentity,
  client: RegisteredClient,
): VerifiedIdentity => {
  if (!identity.principal.authorizedFor?.some((a) => a.org === client.tenant))
    throw new AuthenticationError(
      'not_authorized_for_org',
      `the login does not carry rights for ${client.tenant}`,
    );
  return {
    ...identity,
    principal: {
      ...identity.principal,
      tenant: client.tenant,
      client: client.clientId,
      confinedTo: { tenant: client.tenant, service: client.service, client: client.client },
    },
  };
};

export const createTokenVerifier = (options: TokenVerifierOptions) => ({
  verify: async (token: string): Promise<VerifiedIdentity> => {
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      throw new AuthenticationError('invalid_token', 'not a JWT');
    }
    const iss = unverified.iss;
    const issuer = options.issuers.find((i) => i.issuer === iss);
    if (!issuer) throw new AuthenticationError('unknown_issuer', 'the token issuer is not trusted');
    const registered =
      issuer.kind === 'ansattporten' && typeof unverified.client_id === 'string'
        ? await issuer.registeredClients?.byClientId(unverified.client_id)
        : undefined;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, issuer.keys, {
        issuer: issuer.issuer,
        audience: registered ? [issuer.audience, registered.audience] : issuer.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat'],
        clockTolerance: options.clockToleranceSeconds ?? 30,
      }));
    } catch (error) {
      throw new AuthenticationError(
        'invalid_token',
        error instanceof Error ? error.message : 'invalid token',
      );
    }
    if (issuer.kind === 'ansattporten') {
      if (typeof payload.sub !== 'string')
        throw new AuthenticationError('invalid_token', 'missing sub');
      const verified = employee(issuer, payload);
      return registered ? confineToClient(verified, registered) : verified;
    }
    if (issuer.kind === 'entra') return operator(issuer, payload);
    return system(issuer, payload);
  },
});

export const actingFor = (principal: Principal, org: string): Principal => {
  if (!principal.authorizedFor?.some((a) => a.org === org))
    throw new AuthenticationError('not_authorized_for_org', `not authorized to act for ${org}`);
  return { ...principal, tenant: org };
};
