import { isDevMode } from '@genai/composition';

export interface DesignConnectorSettings {
  /** The API's public origin, where Claude reaches the connector. */
  origin: string;
  /** The MCP endpoint, which is also the OAuth resource. */
  resource: string;
  issuer: string;
  /** The portal, where a person approves a connection. */
  portal: string;
}

export const mcpPath = '/mcp/design';
export const oauthPath = '/oauth/design';

export const servedByConnector = (pathname: string) =>
  pathname === mcpPath ||
  pathname.startsWith(`${oauthPath}/`) ||
  pathname.startsWith('/.well-known/oauth-');

const localhost = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

/** On only when `GENAI_PUBLIC_API_URL` and the portal's origin are set; http only on localhost in dev mode. */
export const designConnectorFrom = (
  env: NodeJS.ProcessEnv,
  portal: string | undefined,
): DesignConnectorSettings | undefined => {
  const given = env.GENAI_PUBLIC_API_URL?.trim();
  if (!given || !portal) return undefined;
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (
    !url ||
    url.origin !== given.replace(/\/$/, '').toLowerCase() ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && localhost(url) && isDevMode(env)))
  )
    throw new Error(
      'GENAI_PUBLIC_API_URL must be an https origin, or http on localhost in dev mode',
    );
  return {
    origin: url.origin,
    resource: `${url.origin}${mcpPath}`,
    issuer: `${url.origin}${oauthPath}`,
    portal,
  };
};
