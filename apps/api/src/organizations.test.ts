import { describe, expect, it } from 'vitest';
import { organizationLookup } from './organizations.js';

const tenants = async () => [{ orgNumber: '991825827', name: 'Digitaliseringsdirektoratet' }];

const registry = (reply: (url: string) => Response) => {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    asked.push(String(input));
    return reply(String(input));
  };
  return { asked, fetch };
};

describe('organisation lookup', () => {
  it('finds a registered tenant without asking Enhetsregisteret', async () => {
    const brreg = registry(() => new Response('{}'));
    const lookup = organizationLookup({
      tenants,
      registryUrl: 'https://brreg.example/enheter',
      fetch: brreg.fetch,
    });

    expect(await lookup('991825827')).toEqual({
      orgNumber: '991825827',
      name: 'Digitaliseringsdirektoratet',
      source: 'platform',
    });
    expect(brreg.asked).toEqual([]);
  });

  it('asks Enhetsregisteret for a tenant that is registered only by its number', async () => {
    const brreg = registry(() =>
      Response.json({ organisasjonsnummer: '974760673', navn: 'BRØNNØYSUNDREGISTRENE' }),
    );
    const lookup = organizationLookup({
      tenants: async () => [{ orgNumber: '974760673', name: '974760673' }],
      registryUrl: 'https://brreg.example/enheter',
      fetch: brreg.fetch,
    });

    expect(await lookup('974760673')).toEqual({
      orgNumber: '974760673',
      name: 'BRØNNØYSUNDREGISTRENE',
      source: 'enhetsregisteret',
    });
  });

  it('knows only registered tenants when Enhetsregisteret is not configured', async () => {
    expect(await organizationLookup({ tenants })('974760673')).toBeUndefined();
  });

  it('asks Enhetsregisteret when configured and says where the name came from', async () => {
    const brreg = registry((url) =>
      url.endsWith('/974760673')
        ? Response.json({ organisasjonsnummer: '974760673', navn: 'BRØNNØYSUNDREGISTRENE' })
        : new Response('', { status: 404 }),
    );
    const lookup = organizationLookup({
      tenants,
      registryUrl: 'https://brreg.example/enheter/',
      fetch: brreg.fetch,
    });

    expect(await lookup('974760673')).toEqual({
      orgNumber: '974760673',
      name: 'BRØNNØYSUNDREGISTRENE',
      source: 'enhetsregisteret',
    });
    expect(brreg.asked).toEqual(['https://brreg.example/enheter/974760673']);
    expect(await lookup('921444555')).toBeUndefined();
  });

  it('treats a failing or mismatching registry answer as unknown', async () => {
    const failing = organizationLookup({
      tenants,
      registryUrl: 'https://brreg.example/enheter',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    const mismatch = organizationLookup({
      tenants,
      registryUrl: 'https://brreg.example/enheter',
      fetch: async () => Response.json({ organisasjonsnummer: '111111111', navn: 'Feil' }),
    });

    expect(await failing('974760673')).toBeUndefined();
    expect(await mismatch('974760673')).toBeUndefined();
  });
});
