import { describe, expect, it } from 'vitest';
import {
  altinnDirectory,
  createMockAltinnAccessManagement,
  httpAltinnPeople,
  peopleFromTestData,
  personKeys,
  withoutTrailingSlashes,
  type AltinnPeople,
  type IdentityTestDataInput,
} from './index.js';

const RESOURCE = 'urn:altinn:resource:digdir-genai-platform';
const ORG = '991825827';
const OTHER = '889640782';
const key = personKeys('test-secret');

const testData: IdentityTestDataInput = {
  organisations: [
    { orgno: ORG, name: 'Digitaliseringsdirektoratet' },
    { orgno: OTHER, name: 'Arbeids- og velferdsetaten' },
  ],
  resourcePolicies: {
    [RESOURCE]: {
      roles: ['DAGL'],
      actions: [
        'use-services',
        'manage-services',
        'manage-datasets',
        'register-building-blocks',
        'view-usage',
      ],
    },
  },
  persons: [
    { pid: '01017012345', name: 'Kari Nordmann', parties: [{ orgno: ORG, roles: ['DAGL'] }] },
    {
      pid: '02027012345',
      name: 'Per Hansen',
      parties: [{ orgno: ORG, resources: { [RESOURCE]: ['manage-services'] } }],
    },
    { pid: '03037012345', name: 'Lars Uten', parties: [{ orgno: ORG, roles: ['LEDE'] }] },
    {
      pid: '04047012345',
      name: 'Erik Annen',
      parties: [{ orgno: OTHER, resources: { [RESOURCE]: ['use-services'] } }],
    },
  ],
};

const mockAltinn = (pageSize?: number) => {
  const mock = createMockAltinnAccessManagement(testData, pageSize ? { pageSize } : {});
  const seen: string[] = [];
  const people = httpAltinnPeople({
    baseURL: 'https://platform.altinn.test/',
    resource: RESOURCE,
    key,
    headers: async () => ({ authorization: 'Bearer system-user-token' }),
    fetch: async (url, init) => {
      const u = new URL(String(url));
      seen.push(u.pathname);
      return mock.app.request(`${u.pathname}${u.search}`, init as RequestInit);
    },
  });
  return { people, seen };
};

describe('people with platform rights in an organisation', () => {
  it('lists the people of one organisation with their rights from the test data, and nobody from another', async () => {
    const people = await peopleFromTestData(testData, { resource: RESOURCE, key }).list(ORG);

    expect(people.map((p) => p.name)).toEqual(['Kari Nordmann', 'Per Hansen']);
    expect(people[0]?.rights).toHaveLength(5);
    expect(people[1]?.rights).toEqual(['manage-services']);
  });

  it('leaves out people in the organisation who hold none of the platform rights', async () => {
    const people = await peopleFromTestData(testData, { resource: RESOURCE, key }).list(ORG);
    expect(people.some((p) => p.name === 'Lars Uten')).toBe(false);
  });

  it('identifies a person by a keyed hash, never by the national identity number', async () => {
    const people = await peopleFromTestData(testData, { resource: RESOURCE, key }).list(ORG);
    const ids = people.map((p) => p.id);
    expect(ids).toEqual([key('01017012345'), key('02027012345')]);
    expect(JSON.stringify(people)).not.toMatch(/\d{11}/);
    expect(personKeys('another-secret')('01017012345')).not.toBe(ids[0]);
  });

  it('reads the same people and rights from Altinn access management as from the test data', async () => {
    const { people } = mockAltinn();
    const local = await peopleFromTestData(testData, { resource: RESOURCE, key }).list(ORG);
    expect(await people.list(ORG)).toEqual(local);
  });

  it('follows the pages of the connections list', async () => {
    const { people, seen } = mockAltinn(1);
    expect((await people.list(ORG)).map((p) => p.name)).toEqual(['Kari Nordmann', 'Per Hansen']);
    expect(seen.filter((p) => p.endsWith('/connections')).length).toBe(3);
  });

  it('asks Altinn for the organisation the system user acts for and no other', async () => {
    const { people } = mockAltinn();
    expect((await people.list(OTHER)).map((p) => p.name)).toEqual(['Erik Annen']);
  });

  it('fails when Altinn refuses the token', async () => {
    const mock = createMockAltinnAccessManagement(testData);
    const people = httpAltinnPeople({
      baseURL: 'https://platform.altinn.test',
      resource: RESOURCE,
      key,
      headers: async () => ({}),
      fetch: async (url, init) => {
        const u = new URL(String(url));
        return mock.app.request(`${u.pathname}${u.search}`, init as RequestInit);
      },
    });
    await expect(people.list(ORG)).rejects.toThrow('Altinn access management answered 401');
  });
});

describe('the Altinn address', () => {
  it('drops trailing slashes, and does so quickly on a long run of them', () => {
    expect(withoutTrailingSlashes('https://platform.tt02.altinn.no///')).toBe(
      'https://platform.tt02.altinn.no',
    );
    expect(withoutTrailingSlashes('https://a.no/x')).toBe('https://a.no/x');
    const slashes = `https://a.no${'/'.repeat(200_000)}x${'/'.repeat(200_000)}`;
    const started = performance.now();
    expect(withoutTrailingSlashes(slashes)).toBe(`https://a.no${'/'.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('the directory in front of Altinn', () => {
  const flaky = () => {
    let calls = 0;
    let failing = false;
    const inner: AltinnPeople = {
      list: async () => {
        calls++;
        if (failing) throw new Error('Altinn is down');
        return [{ id: 'a', name: 'Kari Nordmann', rights: ['use-services'] }];
      },
    };
    return {
      inner,
      calls: () => calls,
      fail: () => {
        failing = true;
      },
    };
  };

  it('keeps an organisation list for two minutes before asking Altinn again', async () => {
    let clock = Date.parse('2026-11-18T08:15:00Z');
    const source = flaky();
    const directory = altinnDirectory(source.inner, { now: () => clock });
    await directory.read(ORG);
    clock += 119_000;
    await directory.read(ORG);
    expect(source.calls()).toBe(1);
    clock += 2_000;
    await directory.read(ORG);
    expect(source.calls()).toBe(2);
  });

  it('serves the last good list marked stale, with its time, when Altinn fails', async () => {
    let clock = Date.parse('2026-11-18T08:15:00Z');
    const source = flaky();
    const directory = altinnDirectory(source.inner, { now: () => clock });
    await directory.read(ORG);
    source.fail();
    clock += 600_000;
    const view = await directory.read(ORG);
    expect(view).toMatchObject({ stale: true, at: '2026-11-18T08:15:00.000Z' });
    expect(view.people).toHaveLength(1);
  });

  it('fails when Altinn fails and no list was ever read for the organisation', async () => {
    const source = flaky();
    source.fail();
    await expect(altinnDirectory(source.inner).read(ORG)).rejects.toThrow('Altinn is down');
  });

  it('never serves one organisation the list of another', async () => {
    const directory = altinnDirectory({
      list: async (org) => [{ id: org, name: org, rights: ['use-services'] }],
    });
    expect((await directory.read(ORG)).people[0]?.id).toBe(ORG);
    expect((await directory.read(OTHER)).people[0]?.id).toBe(OTHER);
  });
});
