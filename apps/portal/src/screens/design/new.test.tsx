// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const open = async (fetch?: typeof globalThis.fetch) => {
  await studioAt('#/design/new', fetch);
  await screen.findByRole('heading', { level: 1, name: 'Lag et designelement' });
};

const named = (name: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Navn' }), { target: { value: name } });

describe('making a design element', () => {
  it('creates a designelement without code and saves its first edition', async () => {
    await open();
    expect(screen.getByRole('radio', { name: /Uten kode/ })).toHaveProperty('checked', true);
    named('Svarkort for byggesak');
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Svarkort for byggesak' }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/design/999888777/svarkort-for-byggesak?tab=content');
    fireEvent.click(screen.getByRole('tab', { name: 'Utgaver' }));
    expect(await screen.findByRole('cell', { name: 'Første utgave' })).toBeTruthy();
  });

  it('makes the technical id from the name, and lets it be changed', async () => {
    await open();
    named('Kort med årstall');
    expect(screen.getByRole('textbox', { name: 'Teknisk id' })).toHaveProperty(
      'value',
      'kort-med-arstall',
    );
  });

  it('asks for a name before it saves anything', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett' }));
    expect(await screen.findByText('Skriv et navn.')).toBeTruthy();
    expect(window.location.hash).toBe('#/design/new');
  });

  it('creates one without code from a design, shown without the preview’s state and theme choices', async () => {
    const base = mockFetch();
    let previews = 0;
    await open(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/blocks/preview')) previews += 1;
      return base(input, init);
    });
    fireEvent.click(screen.getByRole('radio', { name: /Fra et design/ }));
    named('Kildekort');
    fireEvent.change(screen.getByRole('textbox', { name: 'Eller lim inn HTML' }), {
      target: { value: '<article><h3>Kilde</h3></article>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gjør om' }));
    expect(await screen.findByText('Ble uten kode')).toBeTruthy();
    expect(screen.getByText('Fjernet ekstern skrift.')).toBeTruthy();
    await waitFor(() => expect(previews).toBe(1));
    expect(screen.queryByLabelText('Tilstand')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Mørk' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre første utgave' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Kildekort' })).toBeTruthy();
    expect(screen.getByText('Uten kode')).toBeTruthy();
  });

  it('says why a design that needs code is not imported, and saves nothing', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /Fra et design/ }));
    named('Figur fra Claude');
    fireEvent.change(screen.getByRole('textbox', { name: 'Eller lim inn HTML' }), {
      target: { value: '<figure><svg viewBox="0 0 10 10"></svg></figure>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gjør om' }));
    expect(await screen.findByText(/trenger kode/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lagre første utgave' })).toBeNull();
  });

  it('uploads a code bundle and shows its size', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /Med kode/ }));
    const bundle = new File(['genki.onRender(() => {});\n'], 'bundle.js', {
      type: 'text/javascript',
    });
    fireEvent.change(screen.getByLabelText('Pakke (bundle.js)'), { target: { files: [bundle] } });
    await waitFor(() => expect(screen.getByText(/^26 B, sha256 [0-9a-f]{12}$/)).toBeTruthy());
  });

  it('refuses a name already in use, so no designelement is overwritten', async () => {
    await open();
    named('Kildeliste kompakt');
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett' }));
    expect(await screen.findByText('Navnet er i bruk. Velg et annet.')).toBeTruthy();
    expect(window.location.hash).toBe('#/design/new');
  });
});
