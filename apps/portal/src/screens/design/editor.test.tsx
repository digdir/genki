// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromTemplate } from '@genai/ui-blocks/builder';
import { exampleServices, mockFetch } from '../../mock';
import { studioAt } from './studio.test-utils';
import { addTexts, translator } from '../../i18n';
import { designUi } from '../../i18n/nb/build-designUi';
import { designUi as enDesignUi } from '../../i18n/en/build-designUi';
import { editionDates } from './naming';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const own = '#/design/999888777/kildeliste-kompakt';

const open = async (path = own, fetch?: typeof globalThis.fetch) => {
  await studioAt(path, fetch);
  return screen.findByRole('heading', { level: 1 });
};

describe('the designelement editor', () => {
  it('opens from the address the genki-admin tools link to', async () => {
    expect((await open()).textContent).toBe('Kildeliste kompakt');
    expect(screen.getByRole('combobox', { name: 'Utgave' })).toHaveProperty('value', '3');
  });

  it('shows the other design element’s own editions after a link to it from one already open', async () => {
    await open();
    window.location.hash = '#/design/999888777/figur-i-svaret';
    expect(await screen.findByRole('heading', { level: 1, name: 'Figur i svaret' })).toBeTruthy();
    expect(screen.getAllByRole('option', { name: /^Utgave / })).toHaveLength(1);
  });

  it('opens the tab a link asks for, also on the designelement already open', async () => {
    await open();
    window.location.hash = `${own}?tab=editions`;
    expect(await screen.findByRole('region', { name: 'Utgaver' })).toBeTruthy();
  });

  it('shows the preview in every state the designelement declares', async () => {
    await open();
    const states = screen.getByLabelText('Tilstand');
    for (const name of ['Med svar', 'Tom', 'Laster', 'Feil'])
      expect(within(states).getByRole('radio', { name })).toBeTruthy();
    expect(within(states).getAllByRole('radio')).toHaveLength(4);
    fireEvent.click(within(states).getByRole('radio', { name: 'Tom' }));
    expect(await screen.findByText('Ingen kilder')).toBeTruthy();
    fireEvent.click(within(states).getByRole('radio', { name: 'Feil' }));
    expect(await screen.findByText('Fant ikke kildene. Prøv igjen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Mørk' }));
    expect(document.querySelector('[data-color-scheme="dark"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Smal' }));
    expect(document.querySelector('[data-width="narrow"]')).toBeTruthy();
  });

  it('shows each edition by its date', async () => {
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'Utgaver' }));
    const table = within(await screen.findByRole('region', { name: 'Utgaver' }));
    const firstCells = table
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(firstCells).toEqual(['21. nov.', '17. nov.', '14. nov.']);
    expect(table.getByText('Claude for Kari Nordmann')).toBeTruthy();
  });

  it('names a second edition saved the same day with (2) after the date', () => {
    addTexts(designUi, enDesignUi);
    const names = editionDates(
      [
        { version: 1, publishedAt: '2026-11-21T08:00:00Z' },
        { version: 2, publishedAt: '2026-11-21T09:00:00Z' },
        { version: 3, publishedAt: '2026-11-22T09:00:00Z' },
      ],
      'nb',
      translator('nb'),
    );
    expect([...names.values()]).toEqual(['21. nov.', '21. nov. (2)', '22. nov.']);
  });

  it('saves a new edition with what changed', async () => {
    await open();
    fireEvent.click(screen.getByRole('tab', { name: 'Innhold' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Navn, engelsk' }), {
      target: { value: 'Short source list' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Hva er endret?' }), {
      target: { value: 'Kortere engelsk navn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny utgave' }));
    expect(await screen.findByText('Lagret som ny utgave.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: /^Utgave / })).toHaveLength(4),
    );
  });

  it('asks what changed before it saves an edition', async () => {
    const base = mockFetch();
    let posts = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/definitions') && init?.method === 'POST') posts += 1;
      return base(input, init);
    };
    await open(own, fetch);
    fireEvent.click(screen.getByRole('tab', { name: 'Innhold' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lagre ny utgave' }));
    expect(await screen.findByText(/minst 10 tegn/)).toBeTruthy();
    expect(screen.getAllByRole('option', { name: /^Utgave / })).toHaveLength(3);
    expect(posts).toBe(0);
  });

  it('shows the API’s errors next to the structure', async () => {
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/blocks/preview'))
        return new Response(
          JSON.stringify({
            valid: false,
            errors: [{ path: 'spec.template.root.children[0].text.t', message: 'finnes ikke' }],
            reads: [],
            fixtures: {},
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      return base(input, init);
    };
    await open(own, fetch);
    fireEvent.click(screen.getByRole('tab', { name: 'Innhold' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Struktur' }), {
      target: { value: 'version: 1\nroot: { type: heading, level: 3, text: { t: tittel } }\n' },
    });
    expect(
      await screen.findByText('spec.template.root.children[0].text.t', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByText(/finnes ikke/)).toBeTruthy();
  });

  it('pins the edition in view in a service’s testutgave from Utgaver', async () => {
    const services = exampleServices.map((s) => {
      if (s.id !== 'rapportassistenten') return s;
      const definition = structuredClone(s.latest.definition) as { spec: Record<string, unknown> };
      definition.spec.interface = { layout: fromTemplate('chat-only').layout };
      return { ...s, latest: { ...s.latest, definition } } as typeof s;
    });
    const base = mockFetch(services);
    const pins: { method: string; url: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/draft/blocks/'))
        pins.push({ method: init?.method ?? 'GET', url, body: JSON.parse(String(init?.body)) });
      return base(input, init);
    };
    await open(own, fetch);
    fireEvent.click(screen.getByRole('tab', { name: 'Utgaver' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Legg i testutgaven for Rapportassistenten' }),
    );
    expect(
      await screen.findByText('Lagt i testutgaven. Publiser for å ta det i bruk.'),
    ).toBeTruthy();
    expect(pins).toEqual([
      {
        method: 'PUT',
        url: '/api/tenants/999888777/services/rapportassistenten/draft/blocks/999888777/kildeliste-kompakt',
        body: { version: 3 },
      },
    ]);
  });

  it('opens the list for an address with a dot segment', async () => {
    await studioAt('#/design/../services');
    expect(await screen.findByRole('heading', { level: 1, name: 'Utforming' })).toBeTruthy();
  });

  it('saves a new code edition for our organisation only, so it goes to review again', async () => {
    const base = mockFetch();
    let posted: { spec: { sharing: string } } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/definitions') && init?.method === 'POST')
        posted = JSON.parse(String(init.body)).definition;
      const response = await base(input, init);
      if (!url.endsWith('/blocks/999888777/figur-i-svaret')) return response;
      const detail = await response.json();
      detail.sharing = 'everyone';
      detail.edition.definition.spec.sharing = 'everyone';
      return new Response(JSON.stringify(detail), {
        headers: { 'content-type': 'application/json' },
      });
    };
    await open('#/design/999888777/figur-i-svaret?tab=content', fetch);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Hva er endret?' }), {
      target: { value: 'Ny figur i pakken' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny utgave' }));
    expect(await screen.findByText('Lagret som ny utgave.')).toBeTruthy();
    expect(posted?.spec.sharing).toBe('organisation');
  });

  it('leaves the previous edition’s source files behind when a new bundle is saved', async () => {
    const base = mockFetch();
    let files: Record<string, string> = {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/definitions') && init?.method === 'POST')
        files = JSON.parse(String(init.body)).files;
      if (/\/definitions\/blocks\/figur-i-svaret\/versions\/\d+$/.test(url))
        return new Response(
          JSON.stringify({ files: { 'block/bundle.js': 'old', 'block/source/old.ts': 'old' } }),
          { headers: { 'content-type': 'application/json' } },
        );
      return base(input, init);
    };
    await open('#/design/999888777/figur-i-svaret?tab=content', fetch);
    const bundle = new File(['genki.onRender(() => {});\n'], 'bundle.js', {
      type: 'text/javascript',
    });
    fireEvent.change(await screen.findByLabelText('Pakke (bundle.js)'), {
      target: { files: [bundle] },
    });
    await screen.findByText(/^26 B, sha256/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Hva er endret?' }), {
      target: { value: 'Ny pakke med ny figur' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny utgave' }));
    expect(await screen.findByText('Lagret som ny utgave.')).toBeTruthy();
    expect(Object.keys(files)).toEqual(['block/bundle.js']);
  });

  it('shows genki’s designelementer read only', async () => {
    expect((await open('#/design/991825827/chat')).textContent).toBe('Samtale');
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Innhold', 'Utgaver']);
    expect(screen.getByText('Endres av genki.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lagre ny utgave' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Utgaver' }));
    expect(screen.queryByRole('button', { name: /Legg i testutgaven/ })).toBeNull();
  });

  it('shows another organisation’s shared designelement without saving or sharing', async () => {
    expect((await open('#/design/991825827/kudos-dokumentkort')).textContent).toBe(
      'Kudos-dokumentkort',
    );
    expect(screen.queryByRole('tab', { name: 'Deling' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Innhold' }));
    expect(screen.queryByRole('button', { name: 'Lagre ny utgave' })).toBeNull();
  });
});
