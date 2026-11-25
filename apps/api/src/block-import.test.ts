import { readFileSync } from 'node:fs';
import type { Principal } from '@genai/contracts';
import { importNoteCodes, importRefusals } from '@genai/block-import';
import { describe, expect, it } from 'vitest';
import { blockImport as en } from './i18n/en/block-import.js';
import { blockImport as nb } from './i18n/nb/block-import.js';
import { bootPlatform, digdir, other } from './testkit.js';

const resource = 'urn:altinn:resource:digdir-genai-platform';
const person = (subject: string, actions: string[], tenant = digdir): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, resource, actions }],
});

const people: Record<string, Principal> = {
  kari: person('kari', ['use-services', 'manage-services']),
  erik: person('erik', ['use-services']),
  ola: person('ola', ['use-services', 'manage-services'], other),
};

const design = (name: string) =>
  readFileSync(
    new URL(`../../../packages/block-import/src/fixtures/${name}`, import.meta.url),
    'utf8',
  );

interface Proposal {
  tier: string;
  definition: { metadata: { tenant: string; id: string }; spec: Record<string, unknown> };
  files: Record<string, string>;
  report: { kind: string; code: string; message: string }[];
}

const boot = async ({ studio = true } = {}) => {
  const booted = await bootPlatform({ people });
  if (studio) {
    const switched = await booted.send(`/tenants/${digdir}/flags/blockStudio`, 'kari', {
      method: 'PUT',
      body: { on: true },
      reason: 'Prøver Utforming i laben',
    });
    expect(switched.status).toBe(200);
  }
  const importAs = (who: string, tenant: string, body: unknown) =>
    booted.send(`/tenants/${tenant}/blocks/import`, who, { body });
  return { ...booted, importAs };
};

describe('importing a design', () => {
  it('answers 404 on POST /blocks/import while blockStudio is off', async () => {
    const { importAs, send } = await boot({ studio: false });

    const response = await importAs('kari', digdir, {
      html: design('plain.html'),
      id: 'velkommen',
    });
    const unknown = await send(`/tenants/${digdir}/no-such-route`, 'kari');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(await unknown.json());
  });

  it('answers 404 before reading a body of any size while blockStudio is off', async () => {
    const { importAs } = await boot({ studio: false });

    const response = await importAs('kari', digdir, {
      html: `<p>${'a'.repeat(1024 * 1024)}</p>`,
      id: 'stor',
    });

    expect(response.status).toBe(404);
  });

  it("imports a design for the caller's own organisation and saves nothing", async () => {
    const { importAs, platform } = await boot();

    const response = await importAs('kari', digdir, {
      html: design('sources-card.html'),
      id: 'kildekort',
      title: 'Kildekort',
    });
    const proposal = (await response.json()) as Proposal;

    expect(response.status).toBe(200);
    expect(proposal.tier).toBe('declarative');
    expect(proposal.files).toEqual({});
    expect(proposal.definition.metadata).toMatchObject({ tenant: digdir, id: 'kildekort' });
    expect(proposal.report).toContainEqual(
      expect.objectContaining({ code: 'colours', message: 'Fargene følger temaet' }),
    );
    expect(await platform.definitions.get('Block', digdir, 'kildekort')).toBeUndefined();
  });

  it('hands back a proposal that validates as it stands', async () => {
    const { importAs, send } = await boot();

    const response = await importAs('kari', digdir, {
      html: design('plain.html'),
      id: 'velkommen',
    });
    const proposal = (await response.json()) as Proposal;
    const validated = await send('/definitions/validate', 'kari', {
      body: { definition: proposal.definition, files: proposal.files },
    });

    expect(validated.status).toBe(200);
  });

  it('words the report in the language the caller asks for', async () => {
    const { app } = await boot();

    const response = await app.request(`/tenants/${digdir}/blocks/import`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer kari',
        'content-type': 'application/json',
        'accept-language': 'en',
      },
      body: JSON.stringify({ html: design('sources-card.html'), id: 'kildekort' }),
    });
    const proposal = (await response.json()) as Proposal;

    expect(proposal.report).toContainEqual(
      expect.objectContaining({ code: 'colours', message: 'The colours follow the theme' }),
    );
  });

  it('refuses with 422 a design that needs code, and says what needs it', async () => {
    const { importAs } = await boot();

    const response = await importAs('kari', digdir, {
      html: '<h2>Svar per dag</h2><canvas></canvas>',
      id: 'soyler',
    });
    const body = (await response.json()) as {
      title: string;
      errors: { path: string; message: string }[];
    };

    expect(response.status).toBe(422);
    expect(body.title).toContain('canvas');
    expect(body.errors).toEqual([{ path: 'html', message: body.title }]);
    expect(body).not.toHaveProperty('definition');
  });

  it('refuses with 422 a design whose template would draw more than 2000 elements', async () => {
    const { importAs } = await boot();
    const html = Array.from(
      { length: 7 },
      () =>
        `<div data-genki-each="sources" data-genki-max="50">${'<p>{{ sources.title }}</p>'.repeat(5)}</div>`,
    ).join('');

    const response = await importAs('kari', digdir, { html, id: 'mange' });
    const body = (await response.json()) as { title: string };

    expect(response.status).toBe(422);
    expect(body).not.toHaveProperty('definition');
    expect(body.title).toContain('spec.template');
  });

  it('refuses an import into another organisation as if it did not exist', async () => {
    const { importAs } = await boot();

    const response = await importAs('kari', other, {
      html: design('plain.html'),
      id: 'velkommen',
    });

    expect(response.status).toBe(404);
  });

  it('refuses an import without manage-services', async () => {
    const { importAs } = await boot();

    const response = await importAs('erik', digdir, {
      html: design('plain.html'),
      id: 'velkommen',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a design over 512 KiB with 422, and a body over 1 MiB with 413', async () => {
    const { importAs } = await boot();

    const large = await importAs('kari', digdir, {
      html: `<p>${'a'.repeat(512 * 1024)}</p>`,
      id: 'stor',
    });
    const huge = await importAs('kari', digdir, {
      html: `<p>${'a'.repeat(1024 * 1024)}</p>`,
      id: 'stor',
    });

    expect(large.status).toBe(422);
    expect(((await large.json()) as { title: string }).title).toContain('512 KiB');
    expect(huge.status).toBe(413);
  });

  it('imports without a change-reason, since it saves nothing', async () => {
    const { app } = await boot();

    const response = await app.request(`/tenants/${digdir}/blocks/import`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ html: design('plain.html'), id: 'velkommen' }),
    });

    expect(response.status).toBe(200);
  });

  it('refuses an id that is not a slug', async () => {
    const { importAs } = await boot();

    const response = await importAs('kari', digdir, { html: '<p>Hei</p>', id: '../x' });

    expect(response.status).toBe(422);
  });

  it('words every note and refusal the import can give, in both languages', () => {
    for (const code of [...importNoteCodes, ...importRefusals]) {
      expect(nb, code).toHaveProperty(code);
      expect(en, code).toHaveProperty(code);
    }
  });

  it('calls the design area Design in English, as the English portal does', () => {
    expect(Object.values(en).filter((text) => text.includes('Utforming'))).toEqual([]);
  });
});
