// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { inEnglish } from '@genai/i18n/react';
import { fixtureSchemaFetch } from '@genai/schema-forms/fixtures';
import type { UiSchema } from '@genai/schema-forms';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { Schemas } from './screens/Schemas';

document.getAnimations ??= () => [];
afterEach(cleanup);

const newKind: UiSchema = {
  type: 'object',
  required: ['threshold'],
  properties: {
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      'x-label': { nb: 'Terskel for varsel', en: 'Alert threshold' },
    },
    channel: {
      type: 'string',
      enum: ['e-post', 'slack'],
      'x-label': { nb: 'Kanal', en: 'Channel' },
    },
  },
};

const apiWith = (extra: Record<string, UiSchema> = {}) => {
  const fixtures = fixtureSchemaFetch(extra);
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://local');
    const body = fixtures(url.pathname.replace(/^\/api/, ''));
    return body === undefined
      ? new Response(JSON.stringify({ title: 'Ikke funnet', status: 404 }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
  return createApiClient({ baseUrl: '/api', fetch, token: () => 'token' });
};

describe('schemas developer view', () => {
  it('renders a kind it has never seen from /schemas without UI code for it', async () => {
    render(<Schemas api={apiWith({ 'AlertRule@v1': newKind })} initial="AlertRule@v1" />);
    expect(await screen.findByLabelText(/^Terskel for varsel/)).toBeTruthy();
    expect(
      within(screen.getByLabelText(/^Kanal/)).getByRole('option', { name: 'slack' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk utfyllingen' }));
    expect(screen.getByRole('link', { name: 'Fyll ut Terskel for varsel.' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Terskel for varsel/), { target: { value: '0,4' } });
    expect(screen.getByText('Utfyllingen passer med skjemaet.')).toBeTruthy();
    expect(screen.getByLabelText('Dette ville blitt sendt').textContent).toContain(
      '"threshold": 0.4',
    );
  });

  it('lists every kind the API serves and switches between them', async () => {
    render(<Schemas api={apiWith()} />);
    const picker = (await screen.findByLabelText('Skjema')) as HTMLSelectElement;
    expect(within(picker).getAllByRole('option').length).toBeGreaterThanOrEqual(8);
    fireEvent.change(picker, { target: { value: 'Trigger@v1' } });
    expect(await screen.findByLabelText(/^Når/)).toBeTruthy();
  });

  it('fills in the strategy settings from the schema the service kind uses', async () => {
    render(<Schemas api={apiWith()} initial="Service@v1" />);
    const strategy = (await screen.findAllByLabelText(/^Strategi/)).find(
      (e) => e.tagName === 'SELECT',
    );
    fireEvent.change(strategy as HTMLElement, { target: { value: 'single-call' } });
    expect(await screen.findByLabelText(/^Maks tokens i svaret/)).toBeTruthy();
  });

  it('shows the schema labels in English', async () => {
    render(inEnglish(<Schemas api={apiWith()} initial="ToolConnection@v1" />));
    expect(await screen.findByLabelText(/^Access token/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Schemas' })).toBeTruthy();
  });
});
