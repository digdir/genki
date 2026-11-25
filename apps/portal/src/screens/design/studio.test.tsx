// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

interface Sent {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const recording = (answer?: (sent: Sent) => Response | undefined) => {
  const sent: Sent[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const headers = new Headers(init?.headers);
      const reason = headers.get('change-reason');
      const one = {
        method,
        path: new URL(url, 'http://mock').pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      };
      sent.push(one);
      const own = answer?.(one);
      if (own) return own;
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const props = () => screen.getByRole('region', { name: 'Egenskaper' });

describe('Block Studio for a genki block', () => {
  it('draws the block live and draws it again with a changed prop', async () => {
    await studioAt('#/design/991825827/approach');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fremgangsmåte' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText(/Klarspråk betyr/)).toBeTruthy();
    expect(screen.queryByText('Tekniske detaljer')).toBeNull();
    fireEvent.click(within(props()).getByRole('radio', { name: 'Detaljert' }));
    expect(await screen.findByText('Tekniske detaljer')).toBeTruthy();
    expect(within(props()).getByText('Utkast')).toBeTruthy();
  });

  it('saves a changed prop as the setting in the chosen service’s testutgave', async () => {
    const { fetch, sent } = recording((one) =>
      one.path.includes('/draft/blocks/')
        ? Response.json({ definition: {}, files: {}, baseVersion: null, checks: [] })
        : undefined,
    );
    await studioAt('#/design/991825827/approach', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Fremgangsmåte' }, { timeout: 5000 });
    fireEvent.click(within(props()).getByRole('radio', { name: 'Detaljert' }));
    const service = within(props()).getByRole('combobox', { name: 'Tjeneste' });
    await waitFor(() => expect(within(service).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.change(service, { target: { value: 'rapportassistenten' } });
    fireEvent.click(within(props()).getByRole('button', { name: 'Lagre utkast i test' }));
    expect(await within(props()).findByText(/Lagt i testutgaven til/)).toBeTruthy();
    const pin = sent.find((s) => s.method === 'PUT' && s.path.includes('/draft/blocks/'));
    expect(pin?.path).toMatch(
      /\/services\/rapportassistenten\/draft\/blocks\/991825827\/approach$/,
    );
    expect(pin?.body).toMatchObject({ settings: { level: 'detailed' } });
    expect(pin?.reason).toBeTruthy();
  });

  it('will not save before a service is chosen', async () => {
    const { fetch, sent } = recording();
    await studioAt('#/design/991825827/approach', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Fremgangsmåte' }, { timeout: 5000 });
    fireEvent.click(within(props()).getByRole('radio', { name: 'Detaljert' }));
    fireEvent.click(within(props()).getByRole('button', { name: 'Lagre utkast i test' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.filter((s) => s.path.includes('/draft/blocks/'))).toEqual([]);
  });

  it('puts every prop back with «Tilbakestill»', async () => {
    await studioAt('#/design/991825827/approach');
    await screen.findByRole('heading', { level: 1, name: 'Fremgangsmåte' }, { timeout: 5000 });
    fireEvent.click(within(props()).getByRole('radio', { name: 'Detaljert' }));
    fireEvent.click(within(props()).getByRole('button', { name: 'Tilbakestill' }));
    expect(within(props()).getByRole('radio', { name: 'Standard' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(props()).getByText('Ingen endring')).toBeTruthy();
  });
});

describe('Block Studio for the organisation’s own block', () => {
  it('offers the states the block declares and draws each', async () => {
    await studioAt('#/design/999888777/kildeliste-kompakt');
    await screen.findByRole('heading', { level: 1, name: 'Kildeliste kompakt' }, { timeout: 5000 });
    const states = screen.getByRole('group', { name: 'Tilstand' });
    expect(
      within(states)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['filled', 'empty', 'loading', 'error']);
    fireEvent.click(within(states).getByRole('radio', { name: 'Tom' }));
    expect(await screen.findByText('Ingen kilder')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Mørkt' }));
    expect(document.querySelector('.design-stage-inner[data-color-scheme="dark"]')).toBeTruthy();
  });

  it('saves a change in Struktur as the next edition, with the change in the reason', async () => {
    const { fetch, sent } = recording();
    await studioAt('#/design/999888777/kildeliste-kompakt', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Kildeliste kompakt' }, { timeout: 5000 });
    fireEvent.click(screen.getByText('Struktur', { selector: 'summary, summary *' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'none, Bokmål' }), {
      target: { value: 'Ingen kilder ennå' },
    });
    await waitFor(() => expect(within(props()).getByText('Utkast')).toBeTruthy());
    fireEvent.click(within(props()).getByRole('button', { name: 'Lagre utkast i test' }));
    expect(await within(props()).findByText(/Lagret som utkast v4/)).toBeTruthy();
    const saved = sent.find((s) => s.method === 'POST' && s.path.endsWith('/definitions'));
    expect(saved?.reason).toBe('Endret i Block Studio: Struktur');
    expect(JSON.stringify(saved?.body)).toContain('Ingen kilder ennå');
  });

  it('shows «Trenger kjerne» and will not save a block that reads a field genki does not send', async () => {
    const { fetch, sent } = recording((one) =>
      one.path.endsWith('/blocks/preview')
        ? Response.json({
            valid: false,
            errors: [
              {
                path: 'spec.template.root',
                message: 'sources.registerId is not a field a block may read',
              },
            ],
            reads: [],
            fixtures: {},
          })
        : undefined,
    );
    await studioAt('#/design/999888777/kildeliste-kompakt', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Kildeliste kompakt' }, { timeout: 5000 });
    fireEvent.click(screen.getByText('Struktur', { selector: 'summary, summary *' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'none, Bokmål' }), {
      target: { value: 'Ingen kilder ennå' },
    });
    const note = await within(props()).findByRole('note');
    expect(note.textContent).toContain('sources.registerId');
    expect(
      within(note).getByRole('link', { name: 'Lag sak til kjerne' }).getAttribute('href'),
    ).toMatch(/^https:\/\/github\.com\/digdir\/genki\/issues\/new\?/);
    fireEvent.click(within(props()).getByRole('button', { name: 'Lagre utkast i test' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.filter((s) => s.path.endsWith('/definitions'))).toEqual([]);
  });

  it('lists who uses it and its changelog', async () => {
    await studioAt('#/design/999888777/kildeliste-kompakt');
    await screen.findByRole('heading', { level: 1, name: 'Kildeliste kompakt' }, { timeout: 5000 });
    const used = screen.getByRole('region', { name: 'Brukt av' });
    expect(within(used).getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    const log = screen.getByRole('region', { name: 'Endringslogg' });
    expect(within(log).getByText(/v3: Dato i stedet for utgiver/)).toBeTruthy();
  });
});

describe('Block Studio for our code block', () => {
  it('saves a new bundle of a code block shared with everyone for our organisation only, so it goes to review again', async () => {
    const { fetch: recorded, sent } = recording();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await recorded(input, init);
      if (!url.endsWith('/blocks/999888777/figur-i-svaret')) return response;
      const detail = await response.json();
      detail.sharing = 'everyone';
      detail.edition.definition.spec.sharing = 'everyone';
      return new Response(JSON.stringify(detail), {
        headers: { 'content-type': 'application/json' },
      });
    };
    await studioAt('#/design/999888777/figur-i-svaret', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Figur i svaret' }, { timeout: 5000 });
    fireEvent.click(screen.getByText('Ny pakke', { selector: 'summary, summary *' }));
    const bundle = new File(['genki.onRender(() => {});\n'], 'bundle.js', {
      type: 'text/javascript',
    });
    fireEvent.change(await screen.findByLabelText('Pakke (bundle.js)'), {
      target: { files: [bundle] },
    });
    await waitFor(() => expect(within(props()).getByText('Utkast')).toBeTruthy());
    fireEvent.click(within(props()).getByRole('button', { name: 'Lagre utkast i test' }));
    expect(await within(props()).findByText(/Lagret som utkast v2/)).toBeTruthy();
    const saved = sent.find((s) => s.method === 'POST' && s.path.endsWith('/definitions'));
    expect(saved?.body).toMatchObject({ definition: { spec: { sharing: 'organisation' } } });
  });
});
