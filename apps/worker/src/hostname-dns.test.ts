import { describe, expect, it } from 'vitest';
import { InMemoryHostnameClaims, type HostnameClaim } from '@genai/kernel';
import { checkHostnames, type DnsAnswers, type HostnameAudit } from './hostname-dns.js';

const start = Date.parse('2026-11-25T10:00:00Z');
const day = 24 * 3600_000;
const target = {
  fqdn: 'genki-assistant.example.azurecontainerapps.io',
  verificationId: 'ABCDEF0123456789ABCDEF0123456789',
  staticIp: '20.1.2.3',
};

const claimOf = (over: Partial<HostnameClaim>): HostnameClaim => {
  const at = new Date(start).toISOString();
  return {
    id: over.id ?? 'c1',
    tenant: '991825827',
    client: 'klarsprak-host',
    service: 'klarsprak',
    hostname: 'ka.example.no',
    environment: 'prod',
    apex: false,
    assigned: false,
    token: 'riktig-token-0123456789',
    state: 'pending-dns',
    step: 'add',
    stateSince: at,
    createdAt: at,
    createdBy: 'test',
    updatedAt: at,
    version: 1,
    ...over,
  };
};

const fakeDns = (zone: Record<string, { txt?: string[]; cname?: string; a?: string[] }>) => {
  const asked: string[] = [];
  const answers: DnsAnswers = {
    txt: async (name) => (asked.push(name), zone[name]?.txt ?? []),
    cname: async (name) => (asked.push(name), zone[name]?.cname),
    a: async (name) => (asked.push(name), zone[name]?.a ?? []),
  };
  return { answers, asked };
};

const pointed = (hostname: string, token: string) => ({
  [`_genki-challenge.${hostname}`]: { txt: [token] },
  [`asuid.${hostname}`]: { txt: [target.verificationId] },
  [hostname]: { cname: `${target.fqdn}.` },
});

const setup = (dns: DnsAnswers) => {
  const claims = new InMemoryHostnameClaims();
  const audit: HostnameAudit[] = [];
  let clock = start;
  const run = () =>
    checkHostnames({
      claims,
      dns,
      target,
      audit: async (entry) => {
        audit.push(entry);
      },
      now: () => new Date(clock),
      log: () => undefined,
    });
  return {
    claims,
    audit,
    run,
    tick: (ms: number) => {
      clock += ms;
    },
  };
};

const stateOf = async (claims: InMemoryHostnameClaims, id: string) =>
  (await claims.find(id))?.state;

describe('the worker checks hostnames in DNS', () => {
  it('moves a claim whose three records are in place to binding, and audits it', async () => {
    const { answers } = fakeDns(pointed('ka.example.no', 'riktig-token-0123456789'));
    const t = setup(answers);
    await t.claims.create(claimOf({}));

    await t.run();

    expect(await stateOf(t.claims, 'c1')).toBe('binding');
    expect(t.audit.map((a) => a.action)).toEqual(['platform.client.hostnames.verify']);
  });

  it('leaves a claim pending when only genki’s verification id is there, since the token is per claim', async () => {
    const { answers } = fakeDns({
      ...pointed('ka.example.no', 'en-annen-token'),
    });
    const t = setup(answers);
    await t.claims.create(claimOf({}));

    await t.run();

    expect(await stateOf(t.claims, 'c1')).toBe('pending-dns');
    expect((await t.claims.find('c1'))?.check).toMatchObject({
      challenge: false,
      asuid: true,
      target: true,
    });
  });

  it('pending claims on one name do not block each other, and the first verified wins', async () => {
    const { answers } = fakeDns(pointed('ka.example.no', 'riktig-token-0123456789'));
    const t = setup(answers);
    await t.claims.create(claimOf({ id: 'a', tenant: '991825827' }));
    await t.claims.create(
      claimOf({ id: 'b', tenant: '999888777', token: 'annen-token-987654321' }),
    );

    await t.run();
    await t.claims.update({
      ...((await t.claims.find('b')) as HostnameClaim),
      token: 'riktig-token-0123456789',
      version: ((await t.claims.find('b')) as HostnameClaim).version + 1,
    });
    await t.run();

    expect(await stateOf(t.claims, 'a')).toBe('binding');
    expect((await t.claims.find('b'))?.state).toBe('failed');
    expect((await t.claims.find('b'))?.failure).toBe('not_verified');
  });

  it('verifies an apex hostname by its A record and TXT records at the apex', async () => {
    const { answers } = fakeDns({
      '_genki-challenge.kunnskap.example.no': { txt: ['riktig-token-0123456789'] },
      'asuid.kunnskap.example.no': { txt: [target.verificationId] },
      'kunnskap.example.no': { a: ['20.1.2.3'] },
    });
    const t = setup(answers);
    await t.claims.create(claimOf({ hostname: 'kunnskap.example.no', apex: true }));

    await t.run();

    expect(await stateOf(t.claims, 'c1')).toBe('binding');
  });

  it('expires a claim not verified in 7 days', async () => {
    const t = setup(fakeDns({}).answers);
    await t.claims.create(claimOf({}));

    t.tick(7 * day);
    await t.run();

    expect((await t.claims.find('c1'))?.failure).toBe('expired');
  });

  it('never asks DNS about a name genki assigned itself', async () => {
    const dns = fakeDns({});
    const t = setup(dns.answers);
    await t.claims.create(
      claimOf({
        hostname: 'klarsprak.apps.genki-test.digdir.cloud',
        assigned: true,
        state: 'active',
      }),
    );

    t.tick(30 * day);
    await t.run();

    expect(dns.asked).toEqual([]);
    expect(await stateOf(t.claims, 'c1')).toBe('active');
  });

  it('lapses an active hostname whose records have been gone 7 days in a row, and unbinds it 30 days later', async () => {
    const zone: Record<string, { txt?: string[]; cname?: string }> = pointed(
      'ka.example.no',
      'riktig-token-0123456789',
    );
    const t = setup(fakeDns(zone).answers);
    await t.claims.create(claimOf({ state: 'active', step: 'done' }));
    delete zone['ka.example.no'];

    await t.run();
    t.tick(3 * day);
    await t.run();
    expect(await stateOf(t.claims, 'c1')).toBe('active');
    t.tick(4 * day);
    await t.run();
    expect(await stateOf(t.claims, 'c1')).toBe('lapsed');
    t.tick(30 * day);
    await t.run();

    expect(await t.claims.find('c1')).toMatchObject({ state: 'removing', step: 'unbind' });
    expect(t.audit.map((a) => a.action)).toEqual([
      'platform.client.hostnames.lapse',
      'platform.client.hostnames.remove',
    ]);
  });

  it('removes a lapsed hostname without unbinding it when another claim holds the name by then', async () => {
    const t = setup(fakeDns({}).answers);
    await t.claims.create(claimOf({ state: 'lapsed', step: 'done' }));
    await t.claims.create(
      claimOf({ id: 'c2', tenant: '999888777', state: 'active', step: 'done' }),
    );

    t.tick(30 * day);
    await t.run();

    expect(await t.claims.find('c1')).toMatchObject({ state: 'removed', step: 'done' });
  });

  it.each([
    ['a CNAME to another host', { cname: 'annen.example.net.' }],
    ['no asuid record', { noAsuid: true }],
  ])('leaves a claim pending with %s', async (_, wrong: { cname?: string; noAsuid?: boolean }) => {
    const zone: Record<string, { txt?: string[]; cname?: string }> = pointed(
      'ka.example.no',
      'riktig-token-0123456789',
    );
    if (wrong.cname) zone['ka.example.no'] = { cname: wrong.cname };
    if (wrong.noAsuid) delete zone['asuid.ka.example.no'];
    const t = setup(fakeDns(zone).answers);
    await t.claims.create(claimOf({}));

    await t.run();

    expect(await stateOf(t.claims, 'c1')).toBe('pending-dns');
  });

  it('forgets a gap once the records come back', async () => {
    const zone: Record<string, { txt?: string[]; cname?: string }> = pointed(
      'ka.example.no',
      'riktig-token-0123456789',
    );
    const t = setup(fakeDns(zone).answers);
    await t.claims.create(claimOf({ state: 'active', step: 'done' }));
    const record = zone['ka.example.no'];
    delete zone['ka.example.no'];
    await t.run();
    t.tick(day);
    zone['ka.example.no'] = record ?? {};
    await t.run();
    delete zone['ka.example.no'];
    t.tick(6 * day + 1);
    await t.run();

    expect(await stateOf(t.claims, 'c1')).toBe('active');
  });

  it('checks an active hostname once a day, not every run', async () => {
    const dns = fakeDns(pointed('ka.example.no', 'riktig-token-0123456789'));
    const t = setup(dns.answers);
    await t.claims.create(claimOf({ state: 'active', step: 'done' }));

    await t.run();
    const asked = dns.asked.length;
    t.tick(3600_000);
    await t.run();

    expect(dns.asked.length).toBe(asked);
  });
});
