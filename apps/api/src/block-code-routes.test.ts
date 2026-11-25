import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { definitionBodyLimit, sha256Of } from './block-bundles.js';
import { bundleText, codeBlock } from './block-code.test-utils.js';
import {
  bootPlatform,
  digdir,
  files as serviceFiles,
  other,
  setup,
  testService,
} from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
};

const origin = 'https://blocks.example.test';

const boot = (blockOrigin: string | undefined, studio = true) =>
  bootPlatform({
    people,
    ...(blockOrigin ? { blockOrigin } : {}),
    ...(studio ? { envFlags: ['blockStudio' as const] } : {}),
    policy: () => ({ decide: async () => ({ allow: true }) }),
  });

const turn = (send: Awaited<ReturnType<typeof boot>>['send'], on: boolean | null, level = 'me/') =>
  send(`/tenants/${digdir}/${level}flags/blockStudio`, 'kari', {
    method: 'PUT',
    body: { on },
    reason: 'prøver ny utforming',
  });

const imported = (definition: unknown, files: Record<string, string>) => ({
  format: 'genai-tenant-export/v1',
  tenant: digdir,
  exportedAt: '2026-11-21T09:00:00.000Z',
  definitions: [{ definition, files }],
  settings: { values: {}, pins: {} },
});

const saving = (send: Awaited<ReturnType<typeof boot>>['send']) => ({
  validate: (definition: unknown, files: Record<string, string>) =>
    send('/definitions/validate', 'kari', { body: { definition, files } }),
  publish: (definition: unknown, files: Record<string, string>) =>
    send('/definitions', 'kari', { body: { definition, files }, reason: 'første utgave' }),
  preview: (definition: unknown, files: Record<string, string>) =>
    send(`/tenants/${digdir}/blocks/preview`, 'kari', { body: { definition, files } }),
  dryRun: (definition: unknown, files: Record<string, string>) =>
    send(`/tenants/${digdir}/import?dryRun=true`, 'kari', {
      body: imported(definition, files),
      reason: 'flytter figuren',
    }),
  import: (definition: unknown, files: Record<string, string>) =>
    send(`/tenants/${digdir}/import`, 'kari', {
      body: imported(definition, files),
      reason: 'flytter figuren',
    }),
});

const errorsOf = async (response: Response) =>
  ((await response.json()) as { errors?: { path: string }[] }).errors?.map((e) => e.path) ?? [];

describe('code blocks through the definition API', () => {
  it('publishes a code block once a block origin is set', async () => {
    const { send } = await boot(origin);
    const { validate, publish } = saving(send);

    const files = { 'block/bundle.js': bundleText };
    expect((await validate(codeBlock(digdir), files)).status).toBe(200);
    expect((await publish(codeBlock(digdir), files)).status).toBe(201);
  });

  it('refuses a code block while no block origin is set, on validate, preview, import and publish', async () => {
    const { send } = await boot(undefined);
    const { validate, publish, preview, import: load } = saving(send);
    const files = { 'block/bundle.js': bundleText };

    for (const response of [
      await validate(codeBlock(digdir), files),
      await publish(codeBlock(digdir), files),
    ]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ errors: [{ path: 'spec.tier' }] });
    }
    expect(await errorsOf(await preview(codeBlock(digdir), files))).toContain('spec.tier');
    const loaded = await load(codeBlock(digdir), files);
    expect(loaded.status).toBe(422);
    expect(JSON.stringify(await loaded.json())).toContain('spec.tier');
    expect((await send(`/tenants/${digdir}/definitions/blocks/figur`, 'kari')).status).toBe(404);
  });

  it('refuses a code block while blockStudio is off, on validate, preview, import, its dry run and publish', async () => {
    const { send } = await boot(origin, false);
    const { validate, publish, preview, import: load, dryRun } = saving(send);
    const files = { 'block/bundle.js': bundleText };

    for (const response of [
      await validate(codeBlock(digdir), files),
      await publish(codeBlock(digdir), files),
    ]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ errors: [{ path: 'spec.tier' }] });
    }
    expect(await errorsOf(await preview(codeBlock(digdir), files))).toContain('spec.tier');
    const loaded = await load(codeBlock(digdir), files);
    expect(loaded.status).toBe(422);
    expect(JSON.stringify(await loaded.json())).toContain('spec.tier');
    expect(JSON.stringify(await (await dryRun(codeBlock(digdir), files)).json())).toContain(
      'Block:figur.spec.tier',
    );
    expect((await send(`/tenants/${digdir}/definitions/blocks/figur`, 'kari')).status).toBe(404);
  });

  it('hides code editions and the review from the block list, detail and pins while blockStudio is off', async () => {
    const { send } = await boot(origin, false);
    await turn(send, true);
    await saving(send).publish(codeBlock(digdir), { 'block/bundle.js': bundleText });
    await send('/definitions', 'kari', {
      body: { definition: testService('klarsprak', digdir), files: serviceFiles },
      reason: 'ny tjeneste',
    });
    await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari', {
      body: { version: 1 },
      reason: 'del figuren med alle',
    });
    const seen = async () => {
      const detail = await send(`/tenants/${digdir}/blocks/${digdir}/figur`, 'kari');
      const list = (await (await send(`/tenants/${digdir}/blocks`, 'kari')).json()) as {
        data: { id: string }[];
      };
      return {
        detail: detail.status === 200 ? ((await detail.json()) as { review?: unknown }) : undefined,
        listed: list.data.some((b) => b.id === 'figur'),
      };
    };
    const pin = () =>
      send(`/tenants/${digdir}/services/klarsprak/draft/blocks/${digdir}/figur`, 'kari', {
        method: 'PUT',
        body: { version: 1, zone: 'main' },
        reason: 'figuren under svaret',
      });
    const on = await seen();

    await turn(send, false);
    const off = await seen();

    expect(on.listed).toBe(true);
    expect(on.detail?.review).toMatchObject({ status: 'pending' });
    expect(off.listed).toBe(false);
    expect(off.detail).toBeUndefined();
    expect((await pin()).status).toBe(404);
    await turn(send, true);
    expect((await pin()).status).not.toBe(404);
  });

  it("leaves a code edition's review out of a block's detail while blockStudio is off", async () => {
    const { send } = await boot(origin, false);
    await turn(send, true);
    await saving(send).publish(codeBlock(digdir), { 'block/bundle.js': bundleText });
    await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari', {
      body: { version: 1 },
      reason: 'del figuren med alle',
    });
    await saving(send).publish(
      codeBlock(digdir, bundleText, {
        tier: 'declarative',
        code: undefined,
        events: ['ask'],
        states: ['filled'],
        texts: { nb: { label: 'Figur' }, en: { label: 'Figure' } },
        template: {
          version: 1,
          root: { type: 'card', children: [{ type: 'paragraph', text: [{ t: 'label' }] }] },
        },
      }),
      {},
    );
    const review = async () =>
      (
        (await (await send(`/tenants/${digdir}/blocks/${digdir}/figur`, 'kari')).json()) as {
          review?: unknown;
        }
      ).review;
    const on = await review();

    await turn(send, false);
    const off = await review();

    expect(on).toMatchObject({ status: 'pending', version: 1 });
    expect(off).toBeUndefined();
  });

  it("draws a service's code block only while blockStudio is on for the organisation", async () => {
    const { send } = await boot(origin, false);
    await turn(send, true);
    await saving(send).publish(codeBlock(digdir), { 'block/bundle.js': bundleText });
    const ref = `${digdir}/figur@1`;
    const service = testService('klarsprak', digdir);
    const published = await send('/definitions', 'kari', {
      body: {
        definition: {
          ...service,
          spec: {
            ...service.spec,
            interface: {
              layout: {
                version: 1,
                zones: {
                  primary: [{ block: 'threads' }],
                  main: [{ block: 'chat' }, { block: 'ref', ref }],
                  secondary: [],
                },
              },
            },
          },
        },
        files: serviceFiles,
      },
      reason: 'figuren under svaret',
    });
    expect(published.status).toBe(201);
    const frame = async () =>
      (
        (await (await send('/v1/models/klarsprak__default/interface', 'kari')).json()) as {
          blocks: Record<string, { frame?: unknown }>;
        }
      ).blocks[ref]?.frame;

    const forKariOnly = await frame();
    await turn(send, true, '');
    const forEveryone = await frame();

    expect(forKariOnly).toBeUndefined();
    expect(forEveryone).toMatchObject({ sha256: sha256Of(bundleText) });
  });

  it('refuses a code block whose bundle does not match its sha256 on import', async () => {
    const { send } = await boot(origin);
    const swapped = { 'block/bundle.js': bundleText.replace('Figur', 'Fugls') };

    const loaded = await saving(send).import(codeBlock(digdir), swapped);

    expect(loaded.status).toBe(422);
    expect(JSON.stringify(await loaded.json())).toContain('spec.code.sha256');
  });

  it('refuses a tenant that shares a code block with everyone, on validate, publish and import', async () => {
    const { send } = await boot(origin);
    const { validate, publish, import: load } = saving(send);
    const everyone = codeBlock(digdir, bundleText, { sharing: 'everyone' });
    const files = { 'block/bundle.js': bundleText };

    for (const response of [
      await validate(everyone, files),
      await publish(everyone, files),
      await load(everyone, files),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        type: 'urn:genai:problem:share-operator-only',
      });
    }
  });

  it('refuses a code block whose bundle does not match its sha256, on validate, preview and publish', async () => {
    const { send } = await boot(origin);
    const { validate, publish } = saving(send);
    const swapped = { 'block/bundle.js': bundleText.replace('Figur', 'Fugls') };

    for (const response of [
      await validate(codeBlock(digdir), swapped),
      await publish(codeBlock(digdir), swapped),
    ]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ errors: [{ path: 'spec.code.sha256' }] });
    }
    const preview = await send(`/tenants/${digdir}/blocks/preview`, 'kari', {
      body: { definition: codeBlock(digdir), files: swapped },
    });
    expect(await preview.json()).toMatchObject({
      valid: false,
      errors: [{ path: 'spec.code.sha256' }],
    });
  });

  it('refuses a bundle over 256 KiB', async () => {
    const { send } = await boot(origin);
    const { publish } = saving(send);
    const big = `/*${'x'.repeat(256 * 1024)}*/`;

    const response = await publish(
      codeBlock(digdir, big, {
        code: { sha256: sha256Of(big), bytes: 256 * 1024, reads: [] },
      }),
      { 'block/bundle.js': big },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'files.block/bundle.js' }] });
  });

  it('refuses a definition body over 4 MiB on validate, publish and preview', async () => {
    const { send } = await boot(origin);
    const huge = { 'block/source/huge.js': 'x'.repeat(4 * 1024 * 1024) };

    for (const path of [
      '/definitions/validate',
      '/definitions',
      `/tenants/${digdir}/blocks/preview`,
    ]) {
      const response = await send(path, 'kari', {
        body: { definition: codeBlock(digdir), files: huge },
        reason: 'for stor til å lagres',
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        type: 'urn:genai:problem:definition-too-large',
        status: 413,
        detail: 'Forespørselen er større enn 4 MiB',
      });
    }
  });

  it('gives a saved code edition a frame address on the block origin, holding its sha256', async () => {
    const { send } = await boot(origin);
    await saving(send).publish(codeBlock(digdir), { 'block/bundle.js': bundleText });

    const detail = (await (
      await send(`/tenants/${digdir}/blocks/${digdir}/figur`, 'kari')
    ).json()) as {
      edition: { render: { frame: { url: string; sha256: string } } };
    };

    expect(detail.edition.render.frame).toEqual({
      url: `${origin}/frame/${digdir}/figur/1/${sha256Of(bundleText)}`,
      sha256: sha256Of(bundleText),
    });
  });

  it('refuses a code block on publish through an admin on a bare store, not only on validate', async () => {
    const { send } = setup();

    const response = await send('/definitions', 'kari', {
      body: { definition: codeBlock(digdir), files: { 'block/bundle.js': bundleText } },
      reason: 'første utgave',
    });

    expect(response.status).toBe(422);
    expect(await errorsOf(response)).toContain('spec.tier');
  });

  it('refuses a body over 4 MiB also when a middleware before the limit has read it', async () => {
    const app = new Hono();
    app.post(
      '/definitions',
      async (c, next) => {
        await c.req.json();
        await next();
      },
      definitionBodyLimit,
      (c) => c.json({ ok: true }),
    );
    const post = (bytes: number) =>
      app.request('/definitions', {
        method: 'POST',
        body: JSON.stringify({ files: { 'block/source/huge.js': 'x'.repeat(bytes) } }),
      });

    expect((await post(4 * 1024 * 1024)).status).toBe(413);
    expect((await post(1024)).status).toBe(200);
  });
});
