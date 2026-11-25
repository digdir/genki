// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { studioAt } from './studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const recording = () => {
  const sent: { path: string; body: unknown; reason: string | null }[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? 'GET') !== 'GET') {
      const reason = new Headers(init?.headers).get('change-reason');
      sent.push({
        path: new URL(url, 'http://mock').pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const fill = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

const step = () =>
  screen.getByRole('list', { name: 'Steg' }).querySelector('[aria-current="step"]')?.textContent;

describe('Importer fra Claude', () => {
  it('turns a pasted design into a draft block on test in four steps', async () => {
    const { fetch, sent } = recording();
    await studioAt('#/design/import', fetch);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Importer fra Claude' }),
    ).toBeTruthy();
    expect(step()).toBe('1. Kilde');
    fill('Navn', 'Svarkort');
    fill('Designet fra Claude', '<section><h3>Svar</h3><p>Tekst</p></section>');
    fill('Hva skal designelementet gjøre?', 'Viser svaret som et kort');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(await screen.findByText('Fjernet ekstern skrift.')).toBeTruthy();
    expect(step()).toBe('2. Import');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(step()).toBe('3. Type');
    fireEvent.click(screen.getByRole('button', { name: 'Lagre utkast i test' }));
    const done = await screen.findByRole('link', { name: 'Åpne i Block Studio' });
    expect(done.getAttribute('href')).toBe('#/design/999888777/svarkort');
    expect(step()).toBe('4. Utkast i test');
    const imported = sent.find((s) => s.path.endsWith('/blocks/import'));
    expect(imported?.body).toMatchObject({ id: 'svarkort', title: 'Svarkort' });
    const saved = sent.find((s) => s.path.endsWith('/definitions'));
    expect(saved?.body).toMatchObject({
      definition: {
        metadata: { id: 'svarkort', name: 'Svarkort' },
        spec: { summary: { nb: 'Viser svaret som et kort' }, sharing: 'organisation' },
      },
    });
    expect(saved?.reason).toBeTruthy();
  });

  it('asks for a name and the design before it imports anything', async () => {
    const { fetch, sent } = recording();
    await studioAt('#/design/import', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Importer fra Claude' });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Skriv et navn.')).toBeTruthy();
    fill('Navn', 'Svarkort');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(
      screen.getByRole('textbox', { name: 'Designet fra Claude' }).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(sent).toEqual([]);
    expect(step()).toBe('1. Kilde');
  });

  it('keeps a block the organisation already has under that name', async () => {
    const { fetch, sent } = recording();
    await studioAt('#/design/import', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Importer fra Claude' });
    fill('Navn', 'Kildeliste kompakt');
    fill('Designet fra Claude', '<section><h3>Kilder</h3></section>');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    await screen.findByText('Fjernet ekstern skrift.');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre utkast i test' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Navnet er i bruk. Velg et annet.');
    expect(sent.filter((s) => s.path.endsWith('/definitions'))).toEqual([]);
  });

  it('shows why genki refused a design it cannot turn into a block', async () => {
    await studioAt('#/design/import');
    await screen.findByRole('heading', { level: 1, name: 'Importer fra Claude' });
    fill('Navn', 'Diagram');
    fill('Designet fra Claude', '<svg><rect /></svg>');
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(await screen.findByText(/trenger kode/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neste' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});
