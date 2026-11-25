import { createHash, timingSafeEqual } from 'node:crypto';
import { remoteJwks } from '@genai/identity';
import { guidPattern } from '@genai/kernel';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface BinderTrust {
  principalId: string;
  tenantId: string;
  audience: string;
  keys: JWTVerifyGetKey;
  now?: () => Date;
}

export const binderTrustFrom = (
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
): BinderTrust | undefined => {
  const principalId = env.GENAI_HOSTNAME_BINDER_PRINCIPAL_ID?.trim().toLowerCase();
  const tenantId = env.GENAI_HOSTNAME_BINDER_TENANT_ID?.trim().toLowerCase();
  const audience = env.GENAI_HOSTNAME_BINDER_AUDIENCE?.trim();
  if (!principalId || !tenantId || !audience) return undefined;
  if (!guidPattern.test(principalId) || !guidPattern.test(tenantId)) return undefined;
  return {
    principalId,
    tenantId,
    audience,
    keys: remoteJwks(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`, fetchFn),
  };
};

const sameValue = (a: string, b: string) => {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
};

export const isBinder = async (
  trust: BinderTrust | undefined,
  authorization: string | undefined,
): Promise<boolean> => {
  if (!trust || !authorization?.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length).trim();
  try {
    const { payload } = await jwtVerify(token, trust.keys, {
      issuer: [
        `https://login.microsoftonline.com/${trust.tenantId}/v2.0`,
        `https://sts.windows.net/${trust.tenantId}/`,
      ],
      audience: trust.audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat'],
      clockTolerance: 30,
      ...(trust.now ? { currentDate: trust.now() } : {}),
    });
    if (typeof payload.tid !== 'string' || payload.tid.toLowerCase() !== trust.tenantId)
      return false;
    if (payload.scp !== undefined) return false;
    if (typeof payload.oid !== 'string') return false;
    return sameValue(payload.oid.toLowerCase(), trust.principalId);
  } catch {
    return false;
  }
};
