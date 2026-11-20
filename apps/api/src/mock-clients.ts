import { oidcAudienceOf, type createMockAnsattporten } from '@genai/identity';
import type { ClientListener } from './frontends.js';

type MockClients = ReturnType<typeof createMockAnsattporten>['clients'];

/** Keeps the dev-mode mock login's clients in step with genki's; a hosted client signs in with its tenant secret. */
export const mockClientSync = (
  mock: MockClients,
  apiAudience: string,
  secretOf: (tenant: string, name: string) => Promise<string | undefined>,
): ClientListener => ({
  saved: async (client, before) => {
    const oidc = client.spec.oidc;
    if (before?.spec.oidc && before.spec.oidc.clientId !== oidc?.clientId)
      mock.remove(before.spec.oidc.clientId);
    if (!oidc) return;
    const secret =
      client.spec.hosted && oidc.secret
        ? await secretOf(client.metadata.tenant, oidc.secret).catch(() => undefined)
        : undefined;
    mock.register({
      clientId: oidc.clientId,
      redirectUris: oidc.redirectUris,
      postLogoutRedirectUris: oidc.postLogoutRedirectUris,
      audience: oidcAudienceOf(client) ?? oidc.clientId,
      audiences: [apiAudience],
      ...(secret
        ? { tokenEndpointAuthMethod: 'client_secret_basic', clientSecret: secret }
        : { tokenEndpointAuthMethod: 'none' }),
    });
  },
  removed: (client) => {
    if (client.spec.oidc) mock.remove(client.spec.oidc.clientId);
  },
});
