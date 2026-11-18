import { createHash, createHmac } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { resourceId } from './claims.js';
import { platformRightsFromActions, type PlatformRight } from './platform-rights.js';
import {
  identityTestData,
  rightsFor,
  type IdentityTestData,
  type IdentityTestDataInput,
} from './testdata.js';

export interface OrgPerson {
  id: string;
  name: string;
  rights: PlatformRight[];
}

export interface AltinnPeople {
  list(org: string): Promise<OrgPerson[]>;
}

export type PersonKey = (personId: string) => string;

/** A pseudonymous id for a person, so neither the portal nor the stores see a national identity number. */
export const personKeys =
  (secret: string): PersonKey =>
  (personId) =>
    createHmac('sha256', secret).update(personId).digest('base64url').slice(0, 22);

const byName = (a: OrgPerson, b: OrgPerson) => a.name.localeCompare(b.name, 'nb');

const withRights = (people: OrgPerson[]) => people.filter((p) => p.rights.length > 0).sort(byName);

export const peopleFromTestData = (
  testData: IdentityTestDataInput,
  options: { resource: string; key: PersonKey },
): AltinnPeople => {
  const data = identityTestData.parse(testData);
  return {
    list: async (org) =>
      withRights(
        data.persons.flatMap((person) =>
          person.parties
            .filter((party) => party.orgno === org)
            .map((party) => ({
              id: options.key(person.pid),
              name: person.name,
              rights: platformRightsFromActions(rightsFor(data, party, options.resource)),
            })),
        ),
      ),
  };
};

const uuidOf = (text: string) => {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const accessManagement = '/accessmanagement/api/v1/enduser';

/** Serves the Altinn 3 end-user access management reads that `httpAltinnPeople` uses, from the test data. */
export const createMockAltinnAccessManagement = (
  testData: IdentityTestDataInput,
  options: { pageSize?: number } = {},
) => {
  const data: IdentityTestData = identityTestData.parse(testData);
  const pageSize = options.pageSize ?? 100;
  const orgByUuid = new Map(data.organisations.map((o) => [uuidOf(`org:${o.orgno}`), o]));
  const personByUuid = new Map(data.persons.map((p) => [uuidOf(`person:${p.pid}`), p]));
  const app = new Hono();
  const authorized = (c: Context) => /^bearer \S+/i.test(c.req.header('authorization') ?? '');

  app.get(`${accessManagement}/authorizedparties`, (c) => {
    if (!authorized(c)) return c.body(null, 401);
    return c.json({
      data: data.organisations.map((o) => ({
        partyUuid: uuidOf(`org:${o.orgno}`),
        name: o.name,
        organizationNumber: o.orgno,
        partyId: o.partyId ?? 0,
        type: 'Organization',
      })),
    });
  });

  app.get(`${accessManagement}/connections`, (c) => {
    if (!authorized(c)) return c.body(null, 401);
    const party = c.req.query('party') ?? '';
    const org = orgByUuid.get(party);
    if (!org || c.req.query('from') !== party) return c.json({ data: [] });
    const page = Number(c.req.header('X-Page-Number') ?? '0');
    const all = data.persons
      .filter((p) => p.parties.some((x) => x.orgno === org.orgno))
      .map((p) => {
        const own = p.parties.find((x) => x.orgno === org.orgno);
        return {
          party: {
            id: uuidOf(`person:${p.pid}`),
            name: p.name,
            type: 'Person',
            personIdentifier: p.pid,
          },
          roles: (own?.roles ?? []).map((code) => ({ code })),
        };
      });
    const slice = all.slice(page * pageSize, (page + 1) * pageSize);
    const more = (page + 1) * pageSize < all.length;
    return c.json({
      data: slice,
      links: { next: more ? `${accessManagement}/connections?page=${page + 1}` : null },
    });
  });

  app.get(`${accessManagement}/connections/resources/rights`, (c) => {
    if (!authorized(c)) return c.body(null, 401);
    const org = orgByUuid.get(c.req.query('party') ?? '');
    const person = personByUuid.get(c.req.query('to') ?? '');
    const resource = `urn:altinn:resource:${resourceId(c.req.query('resource') ?? '')}`;
    const party = person?.parties.find((x) => x.orgno === org?.orgno);
    if (!party) return c.json({ title: 'Not found', status: 404 }, 404);
    const right = (action: string) => ({
      right: {
        key: action,
        action: { type: 'urn:oasis:names:tc:xacml:1.0:action:action-id', value: action },
      },
    });
    const direct = party.resources[resource] ?? [];
    const indirect = rightsFor(data, party, resource).filter((a) => !direct.includes(a));
    return c.json({
      resource: { refId: resourceId(resource) },
      directRights: direct.map(right),
      indirectRights: indirect.map(right),
    });
  });

  return { app };
};

export interface HttpAltinnPeopleOptions {
  baseURL: string;
  resource: string;
  key: PersonKey;
  headers(org: string): Promise<Record<string, string>>;
  fetch?: typeof fetch;
  concurrency?: number;
  maxPages?: number;
}

interface Connection {
  party?: {
    id?: string;
    name?: string | null;
    type?: string | null;
    personIdentifier?: string | null;
  };
}
interface RightEntry {
  right?: { action?: { value?: string | null } | null } | null;
}

export class AltinnPeopleError extends Error {
  constructor(readonly status: number) {
    super(`Altinn access management answered ${status}`);
    this.name = 'AltinnPeopleError';
  }
}

const inBatches = async <T, R>(items: T[], size: number, work: (item: T) => Promise<R>) => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
};

export const withoutTrailingSlashes = (url: string) => {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
};

/** Lists who in an organisation holds the platform's rights, through Altinn 3 access management (end-user API, system user token). */
export const httpAltinnPeople = (options: HttpAltinnPeopleOptions): AltinnPeople => {
  const base = withoutTrailingSlashes(options.baseURL);
  const call = async (org: string, path: string, query: Record<string, string>, page = 0) => {
    const url = `${base}${accessManagement}${path}?${new URLSearchParams(query)}`;
    const response = await (options.fetch ?? fetch)(url, {
      headers: {
        accept: 'application/json',
        ...(page > 0 ? { 'X-Page-Number': String(page) } : {}),
        ...(await options.headers(org)),
      },
    });
    return response;
  };
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) throw new AltinnPeopleError(response.status);
    return (await response.json()) as T;
  };

  const partyOf = async (org: string) => {
    const body = await json<{ data?: unknown } | unknown[]>(
      await call(org, '/authorizedparties', {}),
    );
    const list = (Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? [])) as {
      partyUuid?: string;
      organizationNumber?: string | null;
    }[];
    const found = list.find((p) => p.organizationNumber === org)?.partyUuid;
    if (!found) throw new AltinnPeopleError(403);
    return found;
  };

  const connections = async (org: string, party: string) => {
    const found: Connection[] = [];
    for (let page = 0; page < (options.maxPages ?? 50); page++) {
      const body = await json<{ data?: Connection[] | null; links?: { next?: string | null } }>(
        await call(org, '/connections', { party, from: party }, page),
      );
      found.push(...(body.data ?? []));
      if (!body.links?.next) break;
    }
    return found;
  };

  const actionsOf = async (org: string, party: string, person: string) => {
    const response = await call(org, '/connections/resources/rights', {
      party,
      from: party,
      to: person,
      resource: resourceId(options.resource),
    });
    if (response.status === 404) return [];
    const body = await json<{
      directRights?: RightEntry[] | null;
      indirectRights?: RightEntry[] | null;
    }>(response);
    return [...(body.directRights ?? []), ...(body.indirectRights ?? [])].flatMap((r) =>
      r.right?.action?.value ? [r.right.action.value] : [],
    );
  };

  return {
    list: async (org) => {
      const party = await partyOf(org);
      const people = new Map<string, { uuid: string; name: string; pid: string }>();
      for (const connection of await connections(org, party)) {
        const p = connection.party;
        if (p?.type?.toLowerCase() !== 'person' || !p.id || !p.personIdentifier) continue;
        people.set(p.id, { uuid: p.id, name: p.name ?? '', pid: p.personIdentifier });
      }
      const listed = await inBatches([...people.values()], options.concurrency ?? 8, async (p) => ({
        id: options.key(p.pid),
        name: p.name,
        rights: platformRightsFromActions(await actionsOf(org, party, p.uuid)),
      }));
      return withRights(listed);
    },
  };
};

export interface PeopleView {
  people: OrgPerson[];
  at: string;
  stale: boolean;
}

export interface AltinnDirectory {
  read(org: string): Promise<PeopleView>;
}

/** Caches each organisation's list for a while, and serves the last good list, marked stale, when Altinn fails. */
export const altinnDirectory = (
  inner: AltinnPeople,
  options: { seconds?: number; now?: () => number } = {},
): AltinnDirectory => {
  const seconds = options.seconds ?? 120;
  const now = options.now ?? Date.now;
  const lastGood = new Map<string, { people: OrgPerson[]; at: number }>();
  const pending = new Map<string, Promise<PeopleView>>();
  const fetchFresh = async (org: string): Promise<PeopleView> => {
    try {
      const people = await inner.list(org);
      const at = now();
      lastGood.set(org, { people, at });
      return { people, at: new Date(at).toISOString(), stale: false };
    } catch (error) {
      const known = lastGood.get(org);
      if (!known) throw error;
      return { people: known.people, at: new Date(known.at).toISOString(), stale: true };
    }
  };
  return {
    read: (org) => {
      const known = lastGood.get(org);
      if (known && now() - known.at < seconds * 1000)
        return Promise.resolve({
          people: known.people,
          at: new Date(known.at).toISOString(),
          stale: false,
        });
      const running = pending.get(org);
      if (running) return running;
      const next = fetchFresh(org).finally(() => pending.delete(org));
      pending.set(org, next);
      return next;
    },
  };
};
