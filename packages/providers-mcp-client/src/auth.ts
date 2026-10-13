import { EgressError, type EgressGuard } from './egress.js';
import type { Connection } from './registry.js';
import type { TenantSecrets } from './secrets.js';

const tokens = new Map<string, { token: string; expires: number }>();

const clientCredentials = async (
  connection: Connection,
  auth: Extract<NonNullable<Connection['auth']>, { kind: 'oauth-client-credentials' }>,
  guard: EgressGuard,
  secret: string,
  signal?: AbortSignal,
) => {
  const key = `${connection.tenant}/${connection.id}/${auth.clientId}/${auth.scope ?? ''}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: auth.clientId,
    client_secret: secret,
    ...(auth.scope ? { scope: auth.scope } : {}),
  }).toString();
  const response = await guard.request(
    connection.allow,
    auth.tokenUrl,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    },
    signal,
  );
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (response.status !== 200 || typeof parsed.access_token !== 'string')
    throw new EgressError('network', `the token endpoint answered HTTP ${response.status}`);
  const seconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 300;
  tokens.set(key, {
    token: parsed.access_token,
    expires: Date.now() + Math.max(0, seconds - 30) * 1000,
  });
  return parsed.access_token;
};

export const authHeaders = async (
  connection: Connection,
  guard: EgressGuard,
  secrets: TenantSecrets,
  signal?: AbortSignal,
): Promise<Record<string, string>> => {
  const auth = connection.auth;
  if (!auth) return {};
  const value = await secrets.resolveFor(connection.tenant, auth.secret);
  if (auth.kind === 'bearer') return { authorization: `Bearer ${value}` };
  if (auth.kind === 'header') return { [auth.header.toLowerCase()]: value };
  return {
    authorization: `Bearer ${await clientCredentials(connection, auth, guard, value, signal)}`,
  };
};
