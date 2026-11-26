import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { changeReason, problemContent } from '../http.js';

const tenant = z.string().openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const request = z.string().openapi({ param: { name: 'request', in: 'path' } });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const OAuthError = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .openapi('OAuthError');
const oauthError = (description: string) => json(OAuthError, description);
const form = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/x-www-form-urlencoded': { schema } },
});
const Tokens = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    refresh_token: z.string(),
    scope: z.literal('design'),
  })
  .openapi('DesignConnectorTokens');
const JsonRpc = z.record(z.string(), z.unknown());
const studioOff =
  'Not signed in as a person, blockStudio is off for the caller, or the tenant is not reachable';

/** The design connector of ADR 0073, served on the API's own host when GENAI_PUBLIC_API_URL is set. */
export const designConnectorRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/.well-known/oauth-protected-resource/mcp/design',
    summary: 'RFC 9728 metadata of the design connector: its resource and authorization server',
    responses: {
      200: json(
        z.object({
          resource: z.string(),
          authorization_servers: z.array(z.string()),
          scopes_supported: z.array(z.string()),
          bearer_methods_supported: z.array(z.string()),
        }),
        'The protected resource metadata',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/.well-known/oauth-authorization-server/oauth/design',
    summary:
      'RFC 8414 metadata of the design connector authorization server: authorization code with S256 PKCE, refresh tokens and dynamic client registration',
    responses: {
      200: json(z.record(z.string(), z.unknown()), 'The authorization server metadata'),
    },
  }),
  ...(['oauth-protected-resource', 'oauth-authorization-server'] as const).map((name) =>
    createRoute({
      method: 'get',
      path: `/.well-known/${name}`,
      summary: `The ${name} metadata of the design connector, at the root for clients that do not insert the path`,
      responses: { 200: json(z.record(z.string(), z.unknown()), 'The metadata') },
    }),
  ),
  createRoute({
    method: 'post',
    path: '/oauth/design/register',
    summary:
      "RFC 7591 dynamic client registration. Takes only Claude's callback or a loopback callback, and keeps nothing: the client id is the sealed registration. 20 a minute per address",
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              redirect_uris: z.array(z.string()),
              client_name: z.string().optional(),
              token_endpoint_auth_method: z
                .enum(['none', 'client_secret_post', 'client_secret_basic'])
                .optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(
        z.object({ client_id: z.string(), client_secret: z.string().optional() }).loose(),
        'The registered client',
      ),
      400: oauthError('A redirect URI that is not allowed, or metadata genki does not support'),
      429: oauthError('Too many registrations'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/oauth/design/authorize',
    summary:
      'Starts a connection: checks the client, its redirect URI and the S256 code challenge, then sends the person to Block Studio to approve it there, with an HttpOnly cookie that binds the request to this browser for five minutes. A request it cannot trust is answered with a page, never redirected',
    request: {
      query: z.object({
        response_type: z.literal('code'),
        client_id: z.string(),
        redirect_uri: z.string(),
        code_challenge: z.string(),
        code_challenge_method: z.literal('S256'),
        state: z.string().optional(),
        scope: z.string().optional(),
        resource: z.string().optional(),
      }),
    },
    responses: {
      302: {
        description: 'To Block Studio, or back to the client with an OAuth error',
        headers: { 'set-cookie': { schema: { type: 'string' } } },
      },
      400: {
        description: 'The client or its redirect URI is not known',
        content: { 'text/html': { schema: z.string() } },
      },
      429: {
        description: 'Too many authorizations from this address',
        content: { 'text/html': { schema: z.string() } },
      },
    },
  }),
  createRoute({
    method: 'get',
    path: '/oauth/design/finish/{request}',
    summary:
      'Finishes an approved connection in the browser that started it: checks the HttpOnly cookie /oauth/design/authorize set, then sends the code to Claude. Without that cookie the request is ended and no code is issued',
    request: { params: z.object({ request }) },
    responses: {
      302: { description: "To the client's redirect URI with the code" },
      403: {
        description: 'Another browser finished it; the request is ended',
        content: { 'text/html': { schema: z.string() } },
      },
      404: {
        description: 'Not approved, expired or already finished',
        content: { 'text/html': { schema: z.string() } },
      },
      429: {
        description: 'Too many requests from this address',
        content: { 'text/html': { schema: z.string() } },
      },
    },
  }),
  createRoute({
    method: 'post',
    path: '/oauth/design/token',
    summary:
      'Swaps a code for tokens, with its PKCE verifier, or a refresh token for new ones. Access tokens last 15 minutes and a grant 8 hours; a refresh token used twice ends the grant',
    request: {
      body: form(
        z.object({
          grant_type: z.enum(['authorization_code', 'refresh_token']),
          code: z.string().optional(),
          code_verifier: z.string().optional(),
          redirect_uri: z.string().optional(),
          refresh_token: z.string().optional(),
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          resource: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(Tokens, 'The tokens'),
      400: oauthError(
        'invalid_grant when the code, verifier or refresh token does not hold; invalid_target, unsupported_grant_type or invalid_request otherwise',
      ),
      401: oauthError('The client is not known or its secret does not hold'),
      429: oauthError('Too many token requests from this client'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/oauth/design/revoke',
    summary: 'RFC 7009 revocation: ends the grant of an access or refresh token',
    request: { body: form(z.object({ token: z.string(), client_id: z.string().optional() })) },
    responses: {
      200: { description: 'Revoked, or nothing to revoke' },
      400: oauthError('Not form urlencoded'),
      401: oauthError('The client is not known'),
    },
  }),
  ...(['get', 'delete'] as const).map((method) =>
    createRoute({
      method,
      path: '/mcp/design',
      summary: 'Not allowed; the design connector takes POST only',
      responses: { 405: json(JsonRpc, 'Method not allowed') },
    }),
  ),
  createRoute({
    method: 'post',
    path: '/mcp/design',
    summary:
      'The design connector: MCP over streamable HTTP with list_design_elements, get_design_element and import_design, as the person who approved the connection, in that organisation only. An import is a new edition shared with the organisation, which no service uses until a person pins it. 120 calls and 10 imports a minute per grant',
    request: {
      headers: z.object({ authorization: z.string().openapi({ example: 'Bearer <token>' }) }),
      body: { required: true, content: { 'application/json': { schema: JsonRpc } } },
    },
    responses: {
      200: json(JsonRpc, 'Result or JSON-RPC error'),
      202: { description: 'A notification was accepted' },
      400: json(JsonRpc, 'Not one JSON-RPC request'),
      401: json(JsonRpc, 'No live access token; WWW-Authenticate names the resource metadata'),
      413: json(JsonRpc, 'Body over 1 MiB'),
      429: json(
        JsonRpc,
        'Too many calls for the grant, or too many unknown tokens from this address, which is refused before any lookup',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/design-connector',
    summary:
      "The design connector's address for Block Studio's guide. Only while blockStudio is on for the caller. Needs manage-services",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ url: z.string() }), 'The MCP address to add in Claude'),
      403: problem('Missing manage-services'),
      404: problem(studioOff),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/design-connector/requests/{request}',
    summary:
      'A pending connection for the person to approve: the client name it registered and where the code would go. Needs manage-services',
    request: { params: z.object({ tenant, request }) },
    responses: {
      200: json(
        z.object({
          client: z.string().openapi({ description: 'Chosen by the client; untrusted text' }),
          redirect: z.string().openapi({ description: 'claude.ai, claude.com or loopback' }),
          scope: z.literal('design'),
          startedAt: z.string().openapi({ description: 'When the connection was started' }),
        }),
        'The pending connection',
      ),
      403: problem('Missing manage-services'),
      404: problem(`${studioOff}, or the request has expired or been used`),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/design-connector/requests/{request}',
    summary:
      'Approves or declines a pending connection, once. Approval grants the client the design tools as the caller in this organisation only, never as an operator, and is audited as platform.design-connector.connect. Answers where the browser goes next: on allow the API /oauth/design/finish/{request}, which issues the code only in the browser that started the connection; on deny back to Claude. A request lasts five minutes. Needs manage-services',
    request: {
      params: z.object({ tenant, request }),
      headers: changeReason,
      body: {
        required: true,
        content: {
          'application/json': { schema: z.object({ decision: z.enum(['allow', 'deny']) }) },
        },
      },
    },
    responses: {
      200: json(z.object({ redirect: z.string() }), 'Where the browser goes next'),
      400: problem('decision is not allow or deny, or the change-reason is missing'),
      403: problem('Missing manage-services'),
      404: problem(`${studioOff}, or the request has expired or been used`),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/design-connector/grant-check',
    summary:
      "Answers 204 while a design connector grant's person may still manage services here with blockStudio on; the connector calls it in-process on every refresh and ends the grant otherwise. Only for the connector's own calls",
    request: { params: z.object({ tenant }) },
    responses: {
      204: { description: 'The grant may go on' },
      403: problem('Missing manage-services'),
      404: problem(studioOff),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/design-connector/grants',
    summary:
      '«Koble fra Claude»: ends every design connector grant, token and unspent code of the caller, in every organisation. Audited as platform.design-connector.disconnect in this one. Needs use-services',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ ended: z.number().int() }), 'How many grants, tokens and codes ended'),
      403: problem('Not a member of the organisation'),
      404: problem(studioOff),
    },
  }),
];
