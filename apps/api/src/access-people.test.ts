import type { Principal } from '@genai/contracts';
import {
  altinnDirectory,
  peopleFromTestData,
  personKeys,
  serviceAccessPolicy,
  type AltinnPeople,
  type IdentityTestDataInput,
} from '@genai/identity';
import type { PolicyDecisionPoint } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAccessPeopleModule,
  peopleSourceFrom,
  selectedPeople,
  type PeopleSource,
} from './access-people.js';
import { draftServices } from './access-draft-services.js';
import { platformModules } from './composition.js';
import { maskinportenClientsModule } from './maskinporten-clients.js';
import { onboardingModule } from './onboarding.js';
import { bootPlatform, digdir, fakeModels, files, readJson, testService } from './testkit.js';

const other = '889640782';

const resource = 'urn:altinn:resource:digdir-genai-platform';
const key = personKeys('test-secret');
const all = [
  'use-services',
  'manage-services',
  'manage-datasets',
  'register-building-blocks',
  'view-usage',
];

const testData: IdentityTestDataInput = {
  organisations: [
    { orgno: digdir, name: 'Digitaliseringsdirektoratet' },
    { orgno: other, name: 'Testetaten' },
  ],
  persons: [
    {
      pid: '01017012345',
      name: 'Kari Nordmann',
      parties: [{ orgno: digdir, resources: { [resource]: all } }],
    },
    {
      pid: '02027012345',
      name: 'Per Hansen',
      parties: [{ orgno: digdir, resources: { [resource]: ['manage-services'] } }],
    },
    {
      pid: '03037012345',
      name: 'Ola Annen',
      parties: [{ orgno: other, resources: { [resource]: ['use-services'] } }],
    },
  ],
};

const kariId = key('01017012345');
const perId = key('02027012345');
const olaId = key('03037012345');

const person = (subject: string, tenant: string, actions?: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  name: subject,
  tenant,
  ...(actions ? { authorizedFor: [{ org: tenant, resource, actions }] } : {}),
});

const people = {
  kari: person('Kari Nordmann', digdir),
  per: person('Per Hansen', digdir, ['use-services']),
  user: person('Ingrid Bruker', digdir, ['use-services']),
  data: person('Dag Data', digdir, ['manage-datasets']),
  ola: person('Ola Annen', other),
  operator: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir } as Principal,
};

const pids: Record<string, string> = {
  'Kari Nordmann': '01017012345',
  'Per Hansen': '02027012345',
  'Ola Annen': '03037012345',
};

const allowedByAltinn: PolicyDecisionPoint = { decide: async () => ({ allow: true }) };

const models: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(models.splice(0).map((m) => m.close()));
});

const answer = {
  status: 200,
  json: {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'gpt',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Svar.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

const testSource = (inner?: AltinnPeople): PeopleSource => ({
  kind: 'test-data',
  key,
  directory: altinnDirectory(inner ?? peopleFromTestData(testData, { resource, key })),
});

const boot = async (source: PeopleSource = testSource(), now?: () => number) => {
  const model = await fakeHttp(() => answer);
  models.push(model);
  const booted = await bootPlatform({
    models: {
      ...fakeModels,
      endpoints: { fake: { ...fakeModels.endpoints.fake, baseURL: `${model.url}/v1` } },
    },
    people,
    services: ['rapport', 'oversetter'],
    policy: (_altinn, store) =>
      serviceAccessPolicy(allowedByAltinn, {
        selectedFor: selectedPeople(store),
        identities: { personId: async (_issuer, subject) => pids[subject] },
        key: source.key,
        draftServiceOf: draftServices.of,
      }),
    modules: [
      ...platformModules,
      onboardingModule,
      maskinportenClientsModule,
      createAccessPeopleModule(source, now),
    ],
  });
  await booted.platform.definitions.publish(
    testService('postsortering', other),
    'test',
    'test',
    files,
  );
  return booted;
};

const limit = (
  send: Awaited<ReturnType<typeof boot>>['send'],
  as: string,
  members: string[] | undefined,
  reason?: string,
) =>
  send(`/tenants/${digdir}/access/services/rapport`, as, {
    method: 'PUT',
    body: members ? { mode: 'selected', members } : { mode: 'all' },
    reason: reason ?? 'Endrer hvem som kan bruke tjenesten',
  });

describe('the people of an organisation and their rights', () => {
  it('lists the people in the organisation with their platform rights', async () => {
    const { send } = await boot();
    const res = await send(`/tenants/${digdir}/access/people`, 'user');
    expect(res.status).toBe(200);
    const view = await readJson<{ people: { name: string; rights: string[] }[]; stale: boolean }>(
      res,
    );
    expect(view.stale).toBe(false);
    expect(view.people.map((p) => [p.name, p.rights])).toEqual([
      ['Kari Nordmann', all],
      ['Per Hansen', ['manage-services']],
    ]);
  });

  it('never shows one organisation the people of another', async () => {
    const { send } = await boot();
    expect((await send(`/tenants/${digdir}/access/people`, 'ola')).status).toBe(404);
    const theirs = await readJson<{ people: { name: string }[] }>(
      await send(`/tenants/${other}/access/people`, 'ola'),
    );
    expect(theirs.people.map((p) => p.name)).toEqual(['Ola Annen']);
  });

  it('refuses a caller who is not signed in', async () => {
    const { send } = await boot();
    expect((await send(`/tenants/${digdir}/access/people`, 'nobody')).status).toBe(401);
  });

  it('sends no national identity number to the portal', async () => {
    const { send } = await boot();
    const text = await (await send(`/tenants/${digdir}/access/people`, 'kari')).text();
    expect(text).not.toMatch(/\d{11}/);
  });

  it('says Altinn is not connected when no source of people is configured', async () => {
    const { send } = await boot({ kind: 'not-configured', key });
    const res = await send(`/tenants/${digdir}/access/people`, 'kari');
    expect(res.status).toBe(503);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'altinn_not_configured' });
  });

  it('serves the last list it read, marked stale, when Altinn stops answering', async () => {
    let down = false;
    const inner = peopleFromTestData(testData, { resource, key });
    const directory = altinnDirectory(
      {
        list: async (org) => {
          if (down) throw new Error('down');
          return inner.list(org);
        },
      },
      {
        seconds: 60,
        now: () => (down ? Date.parse('2026-11-18T10:00:00Z') : Date.parse('2026-11-18T08:15:00Z')),
      },
    );
    const { send } = await boot({ kind: 'altinn', key, directory });
    await send(`/tenants/${digdir}/access/people`, 'kari');
    down = true;
    const view = await readJson<{ stale: boolean; at: string; people: unknown[] }>(
      await send(`/tenants/${digdir}/access/people`, 'kari'),
    );
    expect(view).toMatchObject({ stale: true, at: '2026-11-18T08:15:00.000Z' });
    expect(view.people).toHaveLength(2);
  });

  it('says Altinn did not answer when it fails before any list was read', async () => {
    const { send } = await boot(
      testSource({
        list: async () => {
          throw new Error('down');
        },
      }),
    );
    const res = await send(`/tenants/${digdir}/access/people`, 'kari');
    expect(res.status).toBe(503);
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'altinn_unavailable' });
  });

  it('does not write to the audit log when people are read', async () => {
    const { send } = await boot();
    await send(`/tenants/${digdir}/access/people`, 'kari');
    await send(`/tenants/${digdir}/access/services`, 'kari');
    const audit = await readJson<{ total: number }>(await send(`/tenants/${digdir}/audit`, 'kari'));
    expect(audit.total).toBe(0);
  });
});

describe('limiting a service to selected people', () => {
  it('limits a service to the chosen people and lists the limit with names', async () => {
    const { send } = await boot();
    const res = await limit(send, 'kari', [perId]);
    expect(res.status).toBe(200);
    const listed = await readJson<{ services: { id: string; mode: string; members: unknown }[] }>(
      await send(`/tenants/${digdir}/access/services`, 'user'),
    );
    expect(listed.services).toEqual([
      expect.objectContaining({
        id: 'rapport',
        mode: 'selected',
        members: [{ id: perId, name: 'Per Hansen' }],
        byName: 'Kari Nordmann',
      }),
    ]);
  });

  it('records every change in the audit log with its reason', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [perId], 'Bare piloten i november');
    await limit(send, 'kari', undefined, 'Piloten er ferdig nå');
    const audit = await readJson<{ data: { action: string; reason: string; target: string }[] }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(audit.data.map((e) => [e.action, e.reason, e.target])).toEqual([
      ['platform.service.access', 'Bare piloten i november', `service:${digdir}/rapport`],
      ['platform.service.access', 'Piloten er ferdig nå', `service:${digdir}/rapport`],
    ]);
  });

  it('keeps only person ids, not names, in the audit entry', async () => {
    const { send, admin } = await boot();
    const res = await limit(send, 'kari', [perId]);
    const events = await admin.events(String(res.headers.get('genai-task')));
    const change = events.find((e) => 'after' in (e.data as object))?.data;
    expect(change).toMatchObject({
      before: { mode: 'all', members: [] },
      after: { mode: 'selected', members: [perId] },
    });
    expect(JSON.stringify(events)).not.toContain('Per Hansen');
  });

  it('opens the service to everyone with use-services again', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [perId]);
    const res = await limit(send, 'kari', undefined);
    expect(await readJson(res)).toMatchObject({ mode: 'all', members: [] });
    const listed = await readJson<{ services: unknown[] }>(
      await send(`/tenants/${digdir}/access/services`, 'kari'),
    );
    expect(listed.services).toEqual([]);
  });

  it('needs the right to manage services to change who may use a service', async () => {
    const { send } = await boot();
    expect((await limit(send, 'user', [perId])).status).toBe(403);
  });

  it('refuses a person from another organisation', async () => {
    const { send } = await boot();
    const res = await limit(send, 'kari', [kariId, olaId]);
    expect(res.status).toBe(400);
  });

  it('refuses a limit with nobody on it', async () => {
    const { send } = await boot();
    expect((await limit(send, 'kari', [])).status).toBe(400);
  });

  it('refuses a service the organisation does not have', async () => {
    const { send } = await boot();
    const res = await send(`/tenants/${digdir}/access/services/ukjent`, 'kari', {
      method: 'PUT',
      body: { mode: 'all' },
      reason: 'Åpner tjenesten for alle',
    });
    expect(res.status).toBe(404);
  });

  it('never lets another organisation change or see the limits on a service', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [perId]);
    expect((await limit(send, 'ola', [olaId])).status).toBe(404);
    const theirs = await readJson<{ services: unknown[] }>(
      await send(`/tenants/${other}/access/services`, 'ola'),
    );
    expect(theirs.services).toEqual([]);
  });

  it('keeps a chosen person who has since lost their Altinn rights when the list is saved again', async () => {
    let gone = false;
    const inner = peopleFromTestData(testData, { resource, key });
    const { send } = await boot(
      testSource({
        list: async (org) => (await inner.list(org)).filter((p) => !gone || p.id !== perId),
      }),
    );
    await limit(send, 'kari', [perId]);
    gone = true;
    const res = await send(`/tenants/${digdir}/access/services/rapport`, 'kari', {
      method: 'PUT',
      body: { mode: 'selected', members: [perId, kariId] },
      reason: 'Legger til Kari i piloten',
    });
    expect(res.status).toBe(200);
  });
});

describe('choosing people from a stale list', () => {
  const chosenAfter = async (hours: number) => {
    const at = Date.parse('2026-11-18T08:00:00Z');
    let down = false;
    const inner = peopleFromTestData(testData, { resource, key });
    const directory = altinnDirectory(
      {
        list: async (org) => {
          if (down) throw new Error('down');
          return inner.list(org);
        },
      },
      { seconds: 60, now: () => (down ? at + hours * 3_600_000 : at) },
    );
    const { send } = await boot({ kind: 'altinn', key, directory }, () => at + hours * 3_600_000);
    await send(`/tenants/${digdir}/access/people`, 'kari');
    down = true;
    return (await limit(send, 'kari', [perId])).status;
  };

  it('lets people be chosen from a list Altinn gave less than a day ago', async () => {
    expect(await chosenAfter(23)).toBe(200);
  });

  it('refuses new people from a list older than a day while Altinn is down', async () => {
    expect(await chosenAfter(25)).toBe(400);
  });
});

describe('where the people come from', () => {
  it('uses the local test data only in dev mode', () => {
    expect(peopleSourceFrom({ GENAI_DEV_MODE: 'true' }, testData, resource).kind).toBe('test-data');
    expect(peopleSourceFrom({}, testData, resource).kind).toBe('not-configured');
  });

  it('refuses to start against Altinn without the settings it needs', () => {
    expect(() =>
      peopleSourceFrom(
        { ALTINN_PEOPLE_URL: 'https://platform.tt02.altinn.no' },
        testData,
        resource,
      ),
    ).toThrow(/ACCESS_PERSON_KEY_SECRET/);
  });

  it('refuses to start against Altinn with a person key secret shorter than 32 characters', () => {
    const settings = {
      ALTINN_PEOPLE_URL: 'https://platform.tt02.altinn.no',
      ALTINN_SUBSCRIPTION_KEY: 'k',
      MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
      ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: 'c',
      ALTINN_PEOPLE_MASKINPORTEN_KEY: '{"kty":"RSA","d":"x"}',
    };
    expect(() =>
      peopleSourceFrom({ ...settings, ACCESS_PERSON_KEY_SECRET: 'kort' }, testData, resource),
    ).toThrow('ACCESS_PERSON_KEY_SECRET must be at least 32 characters');
    expect(
      peopleSourceFrom(
        { ...settings, ACCESS_PERSON_KEY_SECRET: 'x'.repeat(32) },
        testData,
        resource,
      ).kind,
    ).toBe('altinn');
  });

  it('refuses an Altinn address that is not HTTPS', () => {
    expect(() =>
      peopleSourceFrom(
        {
          ALTINN_PEOPLE_URL: 'http://platform.tt02.altinn.no',
          ACCESS_PERSON_KEY_SECRET: 's',
          ALTINN_SUBSCRIPTION_KEY: 'k',
          MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
          ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: 'c',
          ALTINN_PEOPLE_MASKINPORTEN_KEY: '{"kty":"RSA","d":"x"}',
        },
        testData,
        resource,
      ),
    ).toThrow('ALTINN_PEOPLE_URL must use HTTPS');
  });
});

const ask = (send: Awaited<ReturnType<typeof boot>>['send'], as: string, service: string) =>
  send('/v1/chat/completions', as, {
    body: { model: `${service}__default`, messages: [{ role: 'user', content: 'Hei' }] },
  });

const downSource = (): PeopleSource =>
  testSource({
    list: async () => {
      throw new Error('down');
    },
  });

const staleSource = (): PeopleSource => {
  let down = false;
  const inner = peopleFromTestData(testData, { resource, key });
  let clock = Date.parse('2026-11-18T08:00:00Z');
  const directory = altinnDirectory(
    {
      list: async (org) => {
        if (down) throw new Error('down');
        down = true;
        clock += 3_600_000;
        return inner.list(org);
      },
    },
    { seconds: 60, now: () => clock },
  );
  return { kind: 'altinn', key, directory };
};

describe('who may use a service', () => {
  it('leaves a service with no limit open when Altinn is not connected, down or stale, even to a login with no known person', async () => {
    for (const source of [
      { kind: 'not-configured', key } as PeopleSource,
      downSource(),
      staleSource(),
    ]) {
      const { send } = await boot(source);
      await send(`/tenants/${digdir}/access/people`, 'kari');
      expect((await ask(send, 'user', 'rapport')).status, source.kind).toBe(200);
      expect((await ask(send, 'kari', 'rapport')).status, source.kind).toBe(200);
    }
  });

  it('leaves the other services open when one service is limited', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [kariId]);
    expect((await ask(send, 'user', 'oversetter')).status).toBe(200);
    expect((await ask(send, 'per', 'oversetter')).status).toBe(200);
  });

  it('refuses a person not on the list of a limited service and lets one on it through', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [kariId]);
    expect((await ask(send, 'per', 'rapport')).status).toBe(403);
    expect((await ask(send, 'user', 'rapport')).status).toBe(403);
    expect((await ask(send, 'kari', 'rapport')).status).toBe(200);
  });

  it('keeps enforcing a limit while Altinn is down', async () => {
    let down = false;
    const inner = peopleFromTestData(testData, { resource, key });
    const { send } = await boot(
      testSource({
        list: async (org) => {
          if (down) throw new Error('down');
          return inner.list(org);
        },
      }),
    );
    await limit(send, 'kari', [kariId]);
    down = true;
    expect((await ask(send, 'per', 'rapport')).status).toBe(403);
    expect((await ask(send, 'kari', 'rapport')).status).toBe(200);
  });

  it('lets operators through a limited service', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [kariId]);
    expect((await ask(send, 'operator', 'rapport')).status).not.toBe(403);
  });
});

describe('trying a limited service in the playground', () => {
  const tryOut = (send: Awaited<ReturnType<typeof boot>>['send'], as: string, service: string) =>
    send(`/tenants/${digdir}/playground/runs`, as, {
      body: {
        setup: { service: { id: service, version: 1 }, output: 'text' },
        input: { text: 'Hei' },
      },
    });

  it('refuses the playground run of a limited service to a person not on its list', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [kariId]);
    const refused = await tryOut(send, 'data', 'rapport');
    expect(refused.status).toBe(403);
    expect((await tryOut(send, 'data', 'oversetter')).status).toBe(200);
  });

  it('refuses the streamed playground run of a limited service to a person not on its list', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [kariId]);
    const stream = await (
      await send(`/tenants/${digdir}/playground/runs/stream`, 'data', {
        body: {
          setup: { service: { id: 'rapport', version: 1 }, output: 'text' },
          input: { text: 'Hei' },
        },
      })
    ).text();
    expect(stream).toContain('event: failed');
    expect(stream).toContain('"status":403');
    expect(stream).not.toContain('event: result');
  });

  it('lets a person who manages services try a limited service in the playground', async () => {
    const { send } = await boot();
    await limit(send, 'kari', [perId]);
    expect((await tryOut(send, 'kari', 'rapport')).status).toBe(200);
  });
});

describe('changing access to a service that is not the caller’s', () => {
  it('answers a service of another organisation exactly as one that does not exist', async () => {
    const { send } = await boot();
    const put = (tenant: string, service: string) =>
      send(`/tenants/${tenant}/access/services/${service}`, 'kari', {
        method: 'PUT',
        body: { mode: 'selected', members: [kariId] },
        reason: 'Prøver en annen tjeneste',
      });
    const theirs = await put(digdir, 'postsortering');
    const missing = await put(digdir, 'finnesikke');
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    const body = (res: Response, id: string) =>
      res.text().then((text) => text.replaceAll(id, '{id}'));
    expect(await body(theirs, 'postsortering')).toBe(await body(missing, 'finnesikke'));
  });

  it('answers a write to another organisation exactly as one to an organisation that does not exist', async () => {
    const { send } = await boot();
    const put = (tenant: string) =>
      send(`/tenants/${tenant}/access/services/postsortering`, 'kari', {
        method: 'PUT',
        body: { mode: 'all' },
        reason: 'Prøver en annen virksomhet',
      });
    const theirs = await put(other);
    const unknown = await put('999999999');
    expect(theirs.status).toBe(unknown.status);
    expect([403, 404]).toContain(theirs.status);
    expect((await theirs.text()).replaceAll(other, '{org}')).toBe(
      (await unknown.text()).replaceAll('999999999', '{org}'),
    );
    const audit = await readJson<{ total: number }>(await send(`/tenants/${other}/audit`, 'ola'));
    expect(audit.total).toBe(0);
  });
});

describe('personal data around access', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts no national identity number or person key secret in any response, log line or audit entry', async () => {
    const secret = 'person-key-secret-for-test';
    const secretKey = personKeys(secret);
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    const { send } = await boot({
      kind: 'test-data',
      key: secretKey,
      directory: altinnDirectory(peopleFromTestData(testData, { resource, key: secretKey })),
    });
    const texts: string[] = [];
    const read = async (res: Response | Promise<Response>) => texts.push(await (await res).text());
    await read(send(`/tenants/${digdir}/access/people`, 'kari'));
    await read(
      send(`/tenants/${digdir}/access/services/rapport`, 'kari', {
        method: 'PUT',
        body: { mode: 'selected', members: [secretKey('01017012345')] },
        reason: 'Bare Kari i piloten',
      }),
    );
    await read(send(`/tenants/${digdir}/access/services`, 'user'));
    await read(ask(send, 'per', 'rapport'));
    await read(ask(send, 'kari', 'rapport'));
    await read(send(`/tenants/${digdir}/audit`, 'kari'));
    const everything = [...texts, ...lines].join('\n');
    for (const pid of Object.values(pids)) expect(everything).not.toContain(pid);
    expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/\b\d{11}\b/);
  });
});
