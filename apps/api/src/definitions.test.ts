import { describe, expect, it } from 'vitest';
import { digdir, files, klarsprak, klarsprakYaml, other, setup } from './testkit.js';

describe('definitions API', () => {
  it('shows the name the person signed in with next to who published a version', async () => {
    const { send } = setup();
    const published = await send('/definitions', 'kari', {
      body: { definition: klarsprak(), files },
      reason: 'første versjon',
      name: 'Kari Testansatt',
    });
    expect(published.status).toBe(201);

    const overview = (await (
      await send(`/tenants/${digdir}/definitions/services/klarsprak`, 'kari')
    ).json()) as {
      latest: { publishedBy: string; publishedByName?: string };
      versions: { publishedByName?: string }[];
    };

    expect(overview.latest.publishedBy).toBe('employee:test:kari');
    expect(overview.latest.publishedByName).toBe('Kari Testansatt');
    expect(overview.versions[0]?.publishedByName).toBe('Kari Testansatt');
  });

  it('words the reason of a seeded version in the language of the person', async () => {
    const { app, store } = setup();
    await store.publish(klarsprak(), 'platform:seed', 'local configuration', files);
    const read = async (language: string) =>
      (
        (await (
          await app.request(`/tenants/${digdir}/definitions/services/klarsprak`, {
            headers: { authorization: 'Bearer kari', 'accept-language': language },
          })
        ).json()) as { versions: { reason: string }[] }
      ).versions[0]?.reason;

    expect(await read('nb')).toBe('Lastet fra den lokale konfigurasjonen');
    expect(await read('en')).toBe('Loaded from the local configuration');
  });

  it('never invents a name for someone who has not sent one', async () => {
    const { send } = setup();
    await send('/definitions', 'kari', {
      body: { definition: klarsprak(), files },
      reason: 'første versjon',
    });
    const overview = (await (
      await send(`/tenants/${digdir}/definitions/services/klarsprak`, 'kari')
    ).json()) as { latest: Record<string, unknown> };
    expect(overview.latest).not.toHaveProperty('publishedByName');
  });

  it('validates a YAML definition without saving it', async () => {
    const { send } = setup();

    const res = await send('/definitions/validate', 'kari', {
      body: { definition: klarsprakYaml, files },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
    expect(await (await send(`/tenants/${digdir}/definitions`, 'kari')).json()).toEqual({
      data: [],
    });
  });

  it('warns that a public agent card stays hidden while A2A is off', async () => {
    const { send } = setup();
    const lonely = {
      ...klarsprak(),
      spec: { ...klarsprak().spec, exposure: { a2a: false, a2aPublicCard: true } },
    };

    const res = await send('/definitions/validate', 'kari', {
      body: { definition: lonely, files },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      valid: true,
      warnings: [
        {
          path: 'spec.exposure.a2aPublicCard',
          message: expect.stringContaining('exposure.a2a'),
        },
      ],
    });
  });

  it('reports invalid definitions as problem+json with the paths that failed', async () => {
    const { send } = setup();
    const broken = { ...klarsprak(), spec: { ...klarsprak().spec, colour: 'red' } };

    const res = await send('/definitions/validate', 'kari', { body: broken });

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { title: string; errors: { path: string }[] };
    expect(body.title).toBe('Invalid definition');
    expect(body.errors.map((e) => e.path)).toEqual(['spec']);
  });

  it('refuses unreadable bodies and unauthenticated callers', async () => {
    const { send } = setup();

    expect((await send('/definitions/validate', 'kari', { yaml: 'a: [unclosed' })).status).toBe(
      400,
    );
    expect((await send('/definitions/validate', undefined, { yaml: klarsprakYaml })).status).toBe(
      401,
    );
    expect((await send(`/tenants/${digdir}/definitions`, undefined)).status).toBe(401);
  });

  it('publishes a definition and returns it with who published it and why', async () => {
    const { send, publish } = setup();

    const res = await publish('kari', klarsprak());

    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe(
      `/tenants/${digdir}/definitions/services/klarsprak/versions/1`,
    );
    expect(await res.json()).toMatchObject({
      kind: 'Service',
      tenant: digdir,
      id: 'klarsprak',
      version: 1,
      publishedBy: 'employee:test:kari',
      publishedAt: '2026-10-06T10:00:00.000Z',
      reason: 'første versjon',
    });
    const version = await send(
      `/tenants/${digdir}/definitions/services/klarsprak/versions/1`,
      'kari',
    );
    expect(
      ((await version.json()) as { definition: { metadata: { version: number } } }).definition
        .metadata.version,
    ).toBe(1);
  });

  it('assigns the next version on each publish and keeps the history', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());
    await publish('kari', klarsprak(), 'strammere instruksjoner');

    const res = await send(`/tenants/${digdir}/definitions/services/klarsprak`, 'kari');
    const body = (await res.json()) as {
      latest: { version: number };
      versions: { version: number; reason: string }[];
    };

    expect(body.latest.version).toBe(2);
    expect(body.versions.map((v) => [v.version, v.reason])).toEqual([
      [1, 'første versjon'],
      [2, 'strammere instruksjoner'],
    ]);
    expect(await (await send(`/tenants/${digdir}/definitions`, 'kari')).json()).toEqual({
      data: [{ kind: 'Service', id: 'klarsprak', latestVersion: 2 }],
    });
  });

  it('requires a reason to publish', async () => {
    const { send } = setup();

    const res = await send('/definitions', 'kari', { body: klarsprak() });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('answers 404 for a definition or version that does not exist', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());

    expect((await send(`/tenants/${digdir}/definitions/services/nothing`, 'kari')).status).toBe(
      404,
    );
    expect(
      (await send(`/tenants/${digdir}/definitions/services/klarsprak/versions/9`, 'kari')).status,
    ).toBe(404);
  });

  it("keeps each tenant out of other tenants' definitions without revealing what exists", async () => {
    const { send, publish } = setup();
    await publish(
      'kari',
      klarsprak({ variants: [{ id: 'default', aliases: ['klarsprak-gammel'] }] }),
    );

    expect((await publish('ola', klarsprak())).status).toBe(403);
    expect((await send(`/tenants/${digdir}/definitions`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/definitions/services/klarsprak`, 'ola')).status).toBe(
      404,
    );
    expect((await send(`/tenants/${digdir}/definitions/services/nothing`, 'ola')).status).toBe(404);
    const hidden = await send('/services/by-name/klarsprak-gammel', 'ola');
    const missing = await send('/services/by-name/finnes-ikke', 'ola');
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it("does not name another tenant's service when a public name is taken", async () => {
    const { publish } = setup();
    await publish('kari', klarsprak({ variants: [{ id: 'default', publicName: 'klarsprak' }] }));

    const res = await publish(
      'ola',
      klarsprak({
        tenant: other,
        id: 'sprakvask',
        variants: [{ id: 'default', publicName: 'klarsprak' }],
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { message: string }[] };
    expect(body.errors.map((e) => e.message)).toEqual(['public name klarsprak is already taken']);
    expect(JSON.stringify(body)).not.toContain(digdir);
  });

  it('refuses a definition whose prompt file is missing', async () => {
    const { send } = setup();

    const res = await send('/definitions/validate', 'kari', { yaml: klarsprakYaml });

    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { message: string }[] }).errors).toEqual([
      {
        path: 'spec.strategy.config.instructions',
        message: 'missing prompt file prompts/klarsprak.nb.md',
      },
    ]);
  });

  it('returns the prompt files with the published version', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());

    const res = await send(`/tenants/${digdir}/definitions/services/klarsprak/versions/1`, 'kari');

    expect(((await res.json()) as { files: unknown }).files).toEqual(files);
  });

  it('resolves a public name or an alias to the service variant', async () => {
    const { send, publish } = setup();
    await publish(
      'kari',
      klarsprak({ variants: [{ id: 'default', aliases: ['builtin.klarsprak'] }] }),
    );

    const byAlias = await send('/services/by-name/builtin.klarsprak', 'kari');
    const byName = await send('/services/by-name/klarsprak__default', 'kari');

    expect(byAlias.status).toBe(200);
    expect(await byAlias.json()).toEqual({
      name: 'builtin.klarsprak',
      publicName: 'klarsprak__default',
      aliases: ['builtin.klarsprak'],
      tenant: digdir,
      service: 'klarsprak',
      variant: 'default',
      version: 1,
    });
    expect(((await byName.json()) as { publicName: string }).publicName).toBe('klarsprak__default');
  });

  it('refuses a skill on the general publish route and points to the skills route', async () => {
    const { send } = setup();
    const skill = {
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant: digdir, id: 'klarsprak-sjekk' },
      spec: { description: 'Sjekker klarspråk.', instructions: 'Pek på lange setninger.' },
    };

    const res = await send('/definitions', 'kari', { body: skill, reason: 'uten testsett' });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      errors: [
        {
          path: 'kind',
          message: `skills are published through /tenants/${digdir}/skills/klarsprak-sjekk/publish, which checks their test set`,
        },
      ],
    });
    expect(await (await send(`/tenants/${digdir}/definitions`, 'kari')).json()).toEqual({
      data: [],
    });
  });

  it('refuses a limited-risk service that nobody has confirmed the risk class for', async () => {
    const { publish } = setup();
    const service = klarsprak();
    service.spec.riskClass = 'limited';

    const res = await publish('kari', service);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ errors: [{ path: 'spec.riskConfirmation' }] });
  });

  it('records the publisher as the risk confirmer, whatever the client sent', async () => {
    const { publish } = setup();
    const service = {
      ...klarsprak(),
      spec: {
        ...klarsprak().spec,
        riskClass: 'limited',
        riskConfirmation: {
          by: 'employee:ansattporten:kari',
          at: '2020-01-01T00:00:00.000Z',
          reasons: ['Svarer innbyggere'],
        },
      },
    };

    const res = await publish('ola', {
      ...service,
      metadata: { ...service.metadata, tenant: other },
    });
    const body = (await res.json()) as {
      definition: { spec: { riskConfirmation: Record<string, unknown> } };
    };

    expect(res.status).toBe(201);
    expect(body.definition.spec.riskConfirmation).toMatchObject({
      by: 'employee:test:ola',
      reasons: ['Svarer innbyggere'],
      riskClass: 'limited',
    });
    expect(body.definition.spec.riskConfirmation.at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('validates and publishes a risk confirmation sent without by and at', async () => {
    const { publish, send } = setup();
    const service = {
      ...klarsprak(),
      spec: {
        ...klarsprak().spec,
        riskClass: 'limited',
        riskConfirmation: { reasons: ['Svarer innbyggere'], riskClass: 'limited' },
      },
    };

    const validated = await send('/definitions/validate', 'kari', {
      body: { definition: service, files },
    });
    const res = await publish('kari', service);
    const body = (await res.json()) as {
      definition: { spec: { riskConfirmation: Record<string, unknown> } };
    };

    expect(validated.status).toBe(200);
    expect(res.status).toBe(201);
    expect(body.definition.spec.riskConfirmation).toMatchObject({
      by: 'employee:test:kari',
      reasons: ['Svarer innbyggere'],
      riskClass: 'limited',
    });
    expect(typeof body.definition.spec.riskConfirmation.at).toBe('string');
  });

  it('refuses a confirmation made for another risk class than the service has', async () => {
    const { publish } = setup();
    const service = {
      ...klarsprak(),
      spec: {
        ...klarsprak().spec,
        riskClass: 'limited',
        riskConfirmation: { by: 'x', at: 'x', riskClass: 'minimal' },
      },
    };

    const res = await publish('kari', service);

    expect(res.status).toBe(422);
  });

  it('serves a published skill under the skills segment', async () => {
    const { send, store } = setup();
    const skill = {
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: { tenant: digdir, id: 'klarsprak-sjekk', name: 'Klarspråksjekk' },
      spec: {
        description: 'Bruk når teksten skal sjekkes for klarspråk.',
        instructions: 'Pek på lange setninger.',
      },
    };

    const saved = await store.publish(skill, 'employee:test:kari', 'første versjon');
    const latest = await send(`/tenants/${digdir}/definitions/skills/klarsprak-sjekk`, 'kari');
    const version = await send(
      `/tenants/${digdir}/definitions/skills/klarsprak-sjekk/versions/1`,
      'kari',
    );

    expect(saved.ok).toBe(true);
    expect(await latest.json()).toMatchObject({
      kind: 'Skill',
      id: 'klarsprak-sjekk',
      versions: [{ version: 1, reason: 'første versjon' }],
    });
    expect(await version.json()).toMatchObject({ kind: 'Skill', version: 1 });
    expect(await (await send(`/tenants/${digdir}/definitions`, 'kari')).json()).toEqual({
      data: [{ kind: 'Skill', id: 'klarsprak-sjekk', latestVersion: 1 }],
    });
  });

  it('describes the definition routes in the OpenAPI document', async () => {
    const { send } = setup();

    const doc = (await (await send('/openapi.json', undefined)).json()) as {
      paths: Record<string, unknown>;
    };

    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/definitions/validate',
        '/definitions',
        '/tenants/{tenant}/definitions',
        '/tenants/{tenant}/definitions/{kind}/{id}',
        '/tenants/{tenant}/definitions/{kind}/{id}/versions/{version}',
        '/services/by-name/{name}',
      ]),
    );
  });
});
