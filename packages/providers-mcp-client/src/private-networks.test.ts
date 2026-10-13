import { describe, expect, it } from 'vitest';
import { EgressGuard, privateNetworkEntry } from './egress.js';

const names: Record<string, string[]> = {
  'fagsystem.intern': ['10.20.0.5'],
  'arkiv.intern': ['192.168.4.9'],
  'metadata.intern': ['169.254.169.254'],
  'db.platform.intern': ['10.20.0.99'],
  'public.example.no': ['93.184.216.34'],
};

const guard = (platformHosts: string[] = []) =>
  new EgressGuard({ lookup: async (host) => names[host] ?? [], platformHosts });

describe('private networks for database connections', () => {
  it('refuses a private address by default', async () => {
    await expect(guard().address('fagsystem.intern')).rejects.toMatchObject({
      code: 'private_address',
    });
    expect(await guard().network('fagsystem.intern')).toEqual({
      network: 'private',
      allowed: false,
    });
  });

  it('allows a private address inside an allowed CIDR or by allowed host name', async () => {
    expect(await guard().address('fagsystem.intern', ['10.20.0.0/16'])).toBe('10.20.0.5');
    expect(await guard().address('arkiv.intern', ['arkiv.intern'])).toBe('192.168.4.9');
    expect(await guard().network('fagsystem.intern', ['10.20.0.0/16'])).toEqual({
      network: 'private',
      allowed: true,
    });
    await expect(guard().address('arkiv.intern', ['10.20.0.0/16'])).rejects.toMatchObject({
      code: 'private_address',
    });
  });

  it('always refuses loopback, link-local metadata and the platform own hosts', async () => {
    const wide = ['10.0.0.0/8', '192.168.0.0/16', 'metadata.intern', 'localhost'];
    for (const host of ['127.0.0.1', '::1', '169.254.169.254', 'metadata.intern', '0.0.0.0'])
      await expect(guard().address(host, wide)).rejects.toMatchObject({
        code: 'private_address',
      });
    expect(await guard().network('169.254.169.254', wide)).toEqual({
      network: 'blocked',
      allowed: false,
    });
    await expect(guard(['db.platform.intern']).address('10.20.0.99', wide)).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(
      guard(['db.platform.intern']).address('db.platform.intern', wide),
    ).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('leaves public hosts alone', async () => {
    expect(await guard().network('public.example.no')).toEqual({
      network: 'public',
      allowed: true,
    });
  });

  it('accepts only private ranges and plain host names as entries', () => {
    for (const ok of ['10.20.0.0/16', '192.168.4.9', 'fd12:3456::/48', 'fagsystem.intern'])
      expect(privateNetworkEntry(ok).ok).toBe(true);
    for (const bad of [
      '0.0.0.0/0',
      '10.0.0.0/4',
      '127.0.0.0/8',
      '169.254.169.254',
      '169.254.0.0/16',
      '100.64.0.0/10',
      '8.8.8.0/24',
      'fe80::/10',
      'localhost',
      'db.localhost',
      '10.0.0.0/33',
      'not a host',
    ])
      expect(privateNetworkEntry(bad).ok, bad).toBe(false);
  });
});
