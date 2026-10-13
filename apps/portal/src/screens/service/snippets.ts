import type { PlainKey } from '../../i18n';
import { publicApiBase } from '../../public-api';
import type { ClientChannel, ClientSpec, ClientsView } from '../../types';

export const channelKeys: Record<ClientChannel, PlainKey> = {
  mcp: 'serviceChannels.channelMcp',
  openai: 'serviceChannels.channelOpenai',
  rest: 'serviceChannels.channelRest',
  conversations: 'serviceChannels.channelConversations',
  feedback: 'serviceChannels.channelFeedback',
  facets: 'serviceChannels.channelFacets',
};

export const channelOrder = Object.keys(channelKeys) as ClientChannel[];

export const defaultApiBase = publicApiBase;

export const serverSnippet = (apiBase: string, model: string, channels: ClientChannel[]) => {
  if (channels.includes('mcp'))
    return [
      `curl -X POST ${apiBase}/api/mcp \\`,
      '  -H "X-API-Key: $GENAI_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${model}","arguments":{"query":"Hva sier tildelingsbrevet?"}}}'`,
    ].join('\n');
  return [
    `curl -X POST ${apiBase}/v1/chat/completions \\`,
    '  -H "X-API-Key: $GENAI_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"Hva sier tildelingsbrevet?"}]}'`,
  ].join('\n');
};

export const browserSnippet = (
  apiBase: string,
  model: string,
  spec: ClientSpec,
  oidc: ClientsView['oidc'],
) =>
  [
    'const login = {',
    `  authority: '${oidc.issuer ?? 'https://test.ansattporten.no'}',`,
    `  client_id: '${spec.oidc?.clientId ?? ''}',`,
    `  redirect_uri: '${spec.oidc?.redirectUris[0] ?? ''}',`,
    "  response_type: 'code',",
    "  scope: 'openid profile',",
    '  authorization_details: JSON.stringify([',
    `    { type: 'ansattporten:altinn:resource', resource: '${oidc.altinnResource ?? ''}' },`,
    '  ]),',
    '};',
    '',
    `const svar = await fetch('${apiBase}/v1/chat/completions', {`,
    "  method: 'POST',",
    '  headers: {',
    '    Authorization: `Bearer ${accessToken}`,',
    "    'Content-Type': 'application/json',",
    '  },',
    `  body: JSON.stringify({ model: '${model}', messages: [{ role: 'user', content: 'Hei' }] }),`,
    '});',
  ].join('\n');
