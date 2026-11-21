import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { bootPlatform, digdir, files, other, testService } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other }],
  },
};

const card = (sharing: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: digdir, id: 'sporsmal-kort', name: 'Spørsmålskort' },
  spec: {
    tier: 'declarative',
    title: { nb: 'Spørsmålskort', en: 'Question card' },
    zones: ['main'],
    sharing,
    events: ['ask'],
    states: ['filled'],
    texts: { nb: { label: 'Spørsmålet ditt:' }, en: { label: 'Your question:' } },
    template: {
      version: 1,
      root: {
        type: 'card',
        children: [{ type: 'paragraph', text: [{ t: 'label' }, ' ', { bind: 'question.text' }] }],
      },
    },
    ...spec,
  },
});

const withLayout = (main: Record<string, unknown>[] = []) => {
  const service = testService('klarsprak', other);
  return {
    ...service,
    spec: {
      ...service.spec,
      interface: {
        layout: {
          version: 1,
          zones: {
            primary: [{ block: 'threads' }],
            main: [{ block: 'chat' }, ...main],
            secondary: [],
          },
        },
      },
    },
  };
};

const boot = async () => {
  const booted = await bootPlatform({
    people,
    policy: () => ({ decide: async () => ({ allow: true }) }),
  });
  for (const orgNumber of [digdir, other])
    await booted.platform.directory.ensure(
      { orgNumber, name: `Virksomhet ${orgNumber}`, status: 'active' },
      'platform:seed',
    );
  const publish = (who: string, definition: unknown, reason = 'første versjon') =>
    booted.send('/definitions', who, {
      body: {
        definition,
        ...((definition as { kind: string }).kind === 'Block' ? {} : { files }),
      },
      reason,
    });
  return { ...booted, publish };
};

describe('a declarative block through the API', () => {
  it('publishes a declarative block once a host draws it', async () => {
    const { publish, send } = await boot();

    const published = await publish('kari', card('organisation'));

    expect(published.status).toBe(201);
    const detail = (await (
      await send(`/tenants/${digdir}/blocks/${digdir}/sporsmal-kort`, 'kari')
    ).json()) as { tier: string; edition: { render: { reads: string[]; template: unknown } } };
    expect(detail.tier).toBe('declarative');
    expect(detail.edition.render.reads).toEqual(['question.text']);
    expect(detail.edition.render.template).toMatchObject({ root: { type: 'card' } });
  });

  it('refuses a template that binds a field outside the field list, on validate and publish alike, in bokmål', async () => {
    const { publish, send } = await boot();
    const hostile = card('organisation', {
      template: { version: 1, root: { type: 'paragraph', text: { bind: 'tenant.apiKey' } } },
    });

    const validated = await send('/definitions/validate', 'kari', {
      body: hostile,
      headers: { 'accept-language': 'nb' },
    });
    const published = await publish('kari', hostile);

    expect(validated.status).toBe(422);
    expect(await validated.json()).toMatchObject({
      errors: [
        {
          path: 'spec.template.root.text.bind',
          message: 'tenant.apiKey er ikke et felt en blokk kan lese',
        },
      ],
    });
    expect(published.status).toBe(422);
  });

  it('refuses a template nested 10,000 deep on validate, publish and preview alike, not with a crash', async () => {
    const { app, platform } = await boot();
    const deep =
      '{"type":"card","children":['.repeat(10_000) + '{"type":"divider"}' + ']}'.repeat(10_000);
    // JSON.stringify overflows on this depth in Node 24, so the body is built as text.
    const definition = JSON.stringify(
      card('organisation', { template: { version: 1, root: 'DEEP' } }),
    ).replace('"DEEP"', deep);
    const post = (path: string, body: string) =>
      app.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer kari',
          'content-type': 'application/json',
          'change-reason': 'første versjon',
        },
        body,
      });

    const validated = await post('/definitions/validate', definition);
    const published = await post('/definitions', `{"definition":${definition}}`);
    const previewed = await post(
      `/tenants/${digdir}/blocks/preview`,
      `{"definition":${definition}}`,
    );

    expect(validated.status).toBe(422);
    expect(await validated.json()).toMatchObject({ errors: [{ path: 'spec.template' }] });
    expect(published.status).toBe(422);
    expect(await published.json()).toMatchObject({ errors: [{ path: 'spec.template' }] });
    expect(await previewed.json()).toMatchObject({
      valid: false,
      errors: [{ path: 'spec.template' }],
    });
    expect(await platform.definitions.list(digdir)).toEqual([]);
  });

  it('previews an unsaved declarative block with what a host draws it from', async () => {
    const { send, platform } = await boot();

    const response = await send(`/tenants/${digdir}/blocks/preview`, 'kari', {
      body: { definition: card('organisation') },
    });
    const body = (await response.json()) as {
      valid: boolean;
      reads: string[];
      render: { tier: string; template: unknown };
    };

    expect(body.valid).toBe(true);
    expect(body.reads).toEqual(['question.text']);
    expect(body.render).toMatchObject({ tier: 'declarative', template: { version: 1 } });
    expect(await platform.definitions.list(digdir)).toEqual([]);
  });

  it("pins another organisation's declarative edition shared with everyone, and serves it with the interface", async () => {
    const { publish, send } = await boot();
    expect((await publish('kari', card('everyone'))).status).toBe(201);
    expect((await publish('ola', withLayout())).status).toBe(201);

    const pinned = await send(
      `/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/sporsmal-kort`,
      'ola',
      { method: 'PUT', body: { version: 1, zone: 'main' }, reason: 'La kortet i testutgaven' },
    );
    const draft = (await pinned.json()) as { definition: unknown };
    expect(pinned.status).toBe(200);
    expect(
      (await (await send('/v1/models/klarsprak__default/interface', 'ola')).json()) as object,
    ).toMatchObject({ blocks: {} });

    expect((await publish('ola', draft.definition, 'kortet under svaret')).status).toBe(201);
    const shown = (await (await send('/v1/models/klarsprak__default/interface', 'ola')).json()) as {
      layout: { zones: { main: unknown[] } };
      blocks: Record<string, unknown>;
    };

    const ref = `${digdir}/sporsmal-kort@1`;
    expect(shown.layout.zones.main).toEqual([{ block: 'chat' }, { block: 'ref', ref }]);
    expect(Object.keys(shown.blocks)).toEqual([ref]);
    expect(shown.blocks[ref]).toEqual({
      ref,
      tier: 'declarative',
      publisher: digdir,
      publisherName: `Virksomhet ${digdir}`,
      title: { nb: 'Spørsmålskort', en: 'Question card' },
      zones: ['main'],
      events: ['ask'],
      states: ['filled'],
      texts: { nb: { label: 'Spørsmålet ditt:' }, en: { label: 'Your question:' } },
      reads: ['question.text'],
      template: card('everyone').spec.template,
    });
  });

  it("refuses to pin another organisation's declarative edition it has not shared with everyone", async () => {
    const { publish, send } = await boot();
    expect((await publish('kari', card('organisation'))).status).toBe(201);
    expect((await publish('ola', withLayout())).status).toBe(201);

    const pinned = await send(
      `/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/sporsmal-kort`,
      'ola',
      { method: 'PUT', body: { version: 1, zone: 'main' }, reason: 'La kortet i testutgaven' },
    );
    const published = await publish(
      'ola',
      withLayout([{ block: 'ref', ref: `${digdir}/sporsmal-kort@1` }]),
      'kortet under svaret',
    );

    expect(pinned.status).toBe(404);
    expect(published.status).toBe(422);
  });
});
