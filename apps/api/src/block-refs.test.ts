import { join } from 'node:path';
import {
  blockCatalogue,
  enBuilder,
  nameKey,
  nbBuilder,
  settingsSchema,
} from '@genai/ui-blocks/builder';
import { describe, expect, it } from 'vitest';
import {
  localDefinitionSources,
  readGitDefinitions,
  seedDefinitions,
} from './definition-sources.js';
import type { PublishedVersion } from '@genai/definitions';
import { blockRefProblems } from './interface-catalogue.js';
import { bootPlatform, digdir, files, other, principals, testService } from './testkit.js';

const block = (tenant: string, id: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id, name: id },
  spec: {
    tier: 'built-in',
    builtIn: 'chat',
    title: { nb: 'Chat', en: 'Chat' },
    zones: ['main', 'secondary'],
    sharing: 'everyone',
    ...spec,
  },
});

const pinning = (id: string, tenant: string, main: Record<string, unknown>[]) => {
  const service = testService(id, tenant);
  return {
    ...service,
    spec: {
      ...service.spec,
      interface: {
        layout: { version: 1, zones: { primary: [{ block: 'threads' }], main, secondary: [] } },
      },
    },
  };
};

const refPath = 'spec.interface.layout.zones.main[0].ref';

const boot = async () => {
  const booted = await bootPlatform({ people: principals });
  for (const orgNumber of [digdir, other])
    await booted.platform.directory.ensure(
      { orgNumber, name: orgNumber, status: 'active' },
      'platform:seed',
    );
  const seed = async (definition: unknown) => {
    const published = await booted.platform.definitions.publish(
      definition,
      'platform:seed',
      'genkis egne blokker',
    );
    if (!published.ok) throw new Error(JSON.stringify(published.errors));
  };
  await seed(block(digdir, 'chat'));
  const publish = (who: string, definition: unknown) =>
    booted.send('/definitions', who, {
      body: { definition, files },
      reason: 'første versjon',
    });
  const validate = (who: string, definition: unknown) =>
    booted.send('/definitions/validate', who, { body: { definition, files } });
  const errorsOf = async (response: Response) =>
    ((await response.json()) as { errors?: { path: string; message: string }[] }).errors ?? [];
  return { ...booted, seed, publish, validate, errorsOf };
};

describe('a layout that pins a Block definition by ref', () => {
  it("publishes a service of another organisation that pins genki's block shared with everyone", async () => {
    const { publish, send } = await boot();

    const published = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/chat@1` }]),
    );

    expect(published.status).toBe(201);
    const stored = (await (
      await send(`/tenants/${other}/definitions/services/klarsprak`, 'ola')
    ).json()) as { latest: { definition: { spec: { interface: unknown } } } };
    expect(stored.latest.definition.spec.interface).toMatchObject({
      layout: { zones: { main: [{ block: 'chat', ref: `${digdir}/chat@1` }] } },
    });
  });

  it('refuses a ref to a block that is not published', async () => {
    const { publish, errorsOf } = await boot();

    const refused = await publish(
      'kari',
      pinning('klarsprak', digdir, [{ block: 'chat', ref: `${digdir}/kart@1` }]),
    );

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      {
        path: refPath,
        message: `no published block ${digdir}/kart that this organisation may use`,
      },
    ]);
  });

  it("refuses a ref to another organisation's block that is not shared with everyone, as if it were not published", async () => {
    const { publish, seed, errorsOf } = await boot();
    await seed(block(digdir, 'intern-chat', { sharing: 'organisation' }));

    const refused = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/intern-chat@1` }]),
    );

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      {
        path: refPath,
        message: `no published block ${digdir}/intern-chat that this organisation may use`,
      },
    ]);
  });

  it('refuses a ref to a version another organisation shared only later, so a pin never reaches an unshared version', async () => {
    const { publish, seed, errorsOf } = await boot();
    await seed(block(digdir, 'delt-chat', { sharing: 'private' }));
    await seed(block(digdir, 'delt-chat', { sharing: 'everyone' }));

    const refused = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/delt-chat@1` }]),
    );
    const allowed = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/delt-chat@2` }]),
    );

    expect(refused.status).toBe(422);
    expect((await errorsOf(refused))[0]?.path).toBe(refPath);
    expect(allowed.status).toBe(201);
  });

  it("lets a service pin its own organisation's block that is not shared", async () => {
    const { publish, seed } = await boot();
    await seed(block(digdir, 'egen-chat', { sharing: 'private' }));

    const published = await publish(
      'kari',
      pinning('klarsprak', digdir, [{ block: 'chat', ref: `${digdir}/egen-chat@1` }]),
    );

    expect(published.status).toBe(201);
  });

  it('refuses a ref to a version that is not published', async () => {
    const { publish, errorsOf } = await boot();

    const refused = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/chat@2` }]),
    );

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      {
        path: refPath,
        message: `block ${digdir}/chat has no version 2 that this organisation may use`,
      },
    ]);
  });

  it('refuses a ref whose block draws something other than the block the layout names', async () => {
    const { publish, errorsOf } = await boot();

    const refused = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'sources', ref: `${digdir}/chat@1` }]),
    );

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      { path: refPath, message: `${digdir}/chat@1 is drawn as chat, so its block must be chat` },
    ]);
  });
});

describe('where and how a pinned edition stands', () => {
  it('refuses a ref placed in a zone the block does not allow', async () => {
    const { publish, seed, errorsOf } = await boot();
    await seed(block(digdir, 'side-chat', { zones: ['secondary'] }));

    const refused = await publish(
      'ola',
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/side-chat@1` }]),
    );

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      {
        path: refPath,
        message: `${digdir}/side-chat@1 cannot stand in main; it may stand in secondary`,
      },
    ]);
  });

  it('refuses ref as a block without a ref', async () => {
    const { publish, errorsOf } = await boot();

    const refused = await publish('ola', pinning('klarsprak', other, [{ block: 'ref' }]));

    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toEqual([
      {
        path: 'spec.interface.layout.zones.main[0].block',
        message: 'ref as a block needs a ref to the block it draws',
      },
    ]);
  });

  it('refuses a setting the pinned edition has no prop for, or of another type', async () => {
    const { publish, seed, errorsOf } = await boot();
    await seed(
      block(digdir, 'innstilt-chat', {
        props: {
          type: 'object',
          properties: {
            copy: { type: 'boolean' },
            tone: { type: 'string', enum: ['formell', 'uformell'] },
          },
        },
      }),
    );
    const placed = (settings: Record<string, unknown>) =>
      pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/innstilt-chat@1`, settings }]);
    const at = 'spec.interface.layout.zones.main[0].settings';

    const unknown = await publish('ola', placed({ fargerik: true }));
    const wrongType = await publish('ola', placed({ copy: 'ja', tone: 'streng' }));
    const allowed = await publish('ola', placed({ copy: false, tone: 'formell' }));

    expect(await errorsOf(unknown)).toEqual([
      { path: `${at}.fargerik`, message: `${digdir}/innstilt-chat@1 has no setting fargerik` },
    ]);
    expect((await errorsOf(wrongType)).map((e) => e.path)).toEqual([`${at}.copy`, `${at}.tone`]);
    expect(allowed.status).toBe(201);
  });

  it('draws a declarative or code edition only as block ref', async () => {
    const edition = (tier: string) =>
      ({
        version: 1,
        definition: {
          kind: 'Block',
          metadata: { tenant: digdir, id: 'kort' },
          spec: { tier, title: { nb: 'Kort' }, zones: ['main'], sharing: 'everyone' },
        },
      }) as unknown as PublishedVersion;
    const placed = (tier: string, main: Record<string, unknown>[]) =>
      blockRefProblems(
        { versions: async () => [edition(tier)] },
        pinning('klarsprak', other, main) as never,
      );

    for (const tier of ['declarative', 'code']) {
      expect(await placed(tier, [{ block: 'chat', ref: `${digdir}/kort@1` }])).toEqual([
        { path: refPath, message: `${digdir}/kort@1 is a ${tier} block, so its block must be ref` },
      ]);
      expect(await placed(tier, [{ block: 'ref', ref: `${digdir}/kort@1` }])).toEqual([]);
    }
  });
});

describe('every path that publishes a layout checks its refs', () => {
  const unknown = () => pinning('klarsprak', digdir, [{ block: 'chat', ref: `${digdir}/kart@1` }]);

  it('refuses an unpublished ref on validate, as on publish', async () => {
    const { validate, errorsOf } = await boot();

    const refused = await validate('kari', unknown());

    expect(refused.status).toBe(422);
    expect((await errorsOf(refused)).map((e) => e.path)).toEqual([refPath]);
  });

  it('reports an unpublished ref in the checks of a draft', async () => {
    const { send } = await boot();
    const draft = `/tenants/${digdir}/services/klarsprak/draft`;
    await send(draft, 'kari', {
      method: 'PUT',
      body: { definition: unknown(), files },
      reason: 'Utkast i testen',
    });

    const checked = (await (await send(`${draft}/checks`, 'kari')).json()) as {
      ready: boolean;
      problems: { path: string }[];
    };

    expect(checked.ready).toBe(false);
    expect(checked.problems.map((p) => p.path)).toContain(refPath);
  });

  it('refuses an import with an unpublished ref before it writes anything', async () => {
    const { send, errorsOf } = await boot();
    const bundle = {
      format: 'genai-tenant-export/v1',
      tenant: digdir,
      exportedAt: '2026-10-06T10:00:00.000Z',
      definitions: [
        { definition: testService('forste', digdir), files },
        { definition: unknown(), files },
      ],
      settings: { values: {}, pins: {} },
    };

    const dryRun = await send(`/tenants/${digdir}/import?dryRun=true`, 'kari', {
      body: bundle,
      reason: 'flytter tjenester',
    });
    const applied = await send(`/tenants/${digdir}/import`, 'kari', {
      body: bundle,
      reason: 'flytter tjenester',
    });

    expect(dryRun.status).toBe(422);
    expect(applied.status).toBe(422);
    expect((await errorsOf(applied)).map((e) => e.path)).toEqual([`Service:klarsprak.${refPath}`]);
    expect((await send(`/tenants/${digdir}/definitions/services/forste`, 'kari')).status).toBe(404);
  });
});

describe("genki's own blocks", () => {
  const configDir = join(import.meta.dirname, '..', 'config', 'local');
  const seeds = () =>
    readGitDefinitions(localDefinitionSources(configDir, {})).definitions.filter(
      (d) => d.kind === 'Block',
    );

  it('seeds every built catalogue block as a built-in Block shared with everyone, as the catalogue describes it', () => {
    const built = blockCatalogue.filter((spec) => spec.status === 'built');
    const word = (catalogue: Record<string, string>, id: (typeof built)[number]['id'], end = '') =>
      catalogue[`${nameKey(id).slice('builder.'.length)}${end}`];

    expect(seeds().map((d) => d.definition)).toEqual(
      expect.arrayContaining(
        built.map((spec) => {
          const { properties } = settingsSchema(spec.id);
          return expect.objectContaining({
            metadata: expect.objectContaining({ id: spec.id }),
            spec: {
              tier: 'built-in',
              builtIn: spec.id,
              title: { nb: word(nbBuilder, spec.id), en: word(enBuilder, spec.id) },
              summary: {
                nb: word(nbBuilder, spec.id, 'Help'),
                en: word(enBuilder, spec.id, 'Help'),
              },
              zones: [...spec.zones],
              sharing: 'everyone',
              ...(Object.keys(properties).length > 0
                ? { props: { type: 'object', properties } }
                : {}),
            },
          });
        }),
      ),
    );
    expect(seeds()).toHaveLength(built.length);
  });

  it('seeds the blocks before the services, so a seeded layout can pin them', async () => {
    const { admin, platform, publish } = await boot();
    const read = readGitDefinitions(localDefinitionSources(configDir, {})).definitions;
    expect(read.findIndex((d) => d.kind !== 'Block')).toBe(seeds().length);

    const outcomes = await seedDefinitions(admin, platform.definitions, seeds());

    expect(outcomes.filter((o) => o.state === 'skipped')).toEqual([]);
    expect(
      (
        await publish(
          'ola',
          pinning('klarsprak', other, [{ block: 'chat', ref: `${digdir}/chat@1` }]),
        )
      ).status,
    ).toBe(201);
  });
});
