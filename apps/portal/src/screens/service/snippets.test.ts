import { describe, expect, it } from 'vitest';
import type { ClientSpec } from '../../types';
import { browserSnippet } from './snippets';

const spec: ClientSpec = {
  service: 'kunnskapsassistenten',
  kind: 'browser',
  channels: ['openai'],
  allowedOrigins: ['https://app.example.no'],
  oidc: { clientId: 'app-client', redirectUris: ['https://app.example.no/callback'] },
};

describe('the browser frontend snippet', () => {
  it('asks for the platform Altinn resource when genki names one', () => {
    const snippet = browserSnippet('https://api.example.no', 'kunnskapsassistenten', spec, {
      issuer: 'https://ansattporten.no',
      altinnResource: 'urn:altinn:resource:digdir-genai-platform',
    });

    expect(snippet).toContain(
      "{ type: 'ansattporten:altinn:resource', resource: 'urn:altinn:resource:digdir-genai-platform' }",
    );
  });

  it('asks for no Altinn resource when rights come from Entra groups', () => {
    const snippet = browserSnippet('https://api.example.no', 'kunnskapsassistenten', spec, {
      issuer: 'https://ansattporten.no',
    });

    expect(snippet).not.toContain('authorization_details');
    expect(snippet).toContain("client_id: 'app-client',");
  });
});
