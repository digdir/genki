import { clientDefinition, createMockAnsattporten, createSigningKey } from '@genai/identity';
import { describe, expect, it } from 'vitest';
import { mockClientSync } from './mock-clients.js';

const client = (id: string, hosted: boolean) =>
  clientDefinition.parse({
    apiVersion: 'genai/v1',
    kind: 'Client',
    metadata: { tenant: '991825827', id },
    spec: {
      service: 'kunnskapsassistenten',
      kind: 'browser',
      channels: ['openai'],
      allowedOrigins: [`https://${id}.example.no`],
      oidc: {
        clientId: id,
        redirectUris: [`https://${id}.example.no/auth/callback`],
        ...(hosted ? { secret: 'login-secret' } : {}),
      },
      ...(hosted ? { hosted: true, hostnames: [{ hostname: `${id}.example.no` }] } : {}),
    },
  });

describe('the dev-mode mock login', () => {
  it('lets a hosted client sign in with its tenant secret, as the BFF does, and every other client as a public one', async () => {
    const mock = createMockAnsattporten({
      issuer: 'http://localhost:8080/mock/ansattporten',
      key: await createSigningKey('test'),
      testData: {},
    });
    const asked: string[] = [];
    const sync = mockClientSync(mock.clients, 'digdir:genai', async (tenant, name) => {
      asked.push(`${tenant}/${name}`);
      return 'the-secret';
    });

    await sync.saved?.(client('hosted-host', true));
    await sync.saved?.(client('browser-app', false));

    const registered = (id: string) => mock.testData.clients.find((c) => c.clientId === id);
    expect(registered('hosted-host')).toMatchObject({
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecret: 'the-secret',
    });
    expect(registered('browser-app')?.tokenEndpointAuthMethod).toBe('none');
    expect(asked).toEqual(['991825827/login-secret']);
  });

  it('keeps a hosted client public while its secret is not set', async () => {
    const mock = createMockAnsattporten({
      issuer: 'http://localhost:8080/mock/ansattporten',
      key: await createSigningKey('test'),
      testData: {},
    });
    await mockClientSync(mock.clients, 'digdir:genai', async () => undefined).saved?.(
      client('hosted-host', true),
    );
    expect(
      mock.testData.clients.find((c) => c.clientId === 'hosted-host')?.tokenEndpointAuthMethod,
    ).toBe('none');
  });
});
