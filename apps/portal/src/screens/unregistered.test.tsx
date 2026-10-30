// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';

document.getAnimations ??= () => [];
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const unregistered = (): typeof fetch => {
  const base = mockFetch();
  return async (input, init) =>
    /\/tenants\/999888777\//.test(urlOf(input))
      ? new Response(
          JSON.stringify({ status: 403, type: 'urn:genai:problem:tenant-not-registered' }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        )
      : base(input, init);
};

const shownBody = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
  const curl = screen.getByLabelText('Forespørsel').textContent ?? '';
  const body = JSON.parse(/-d '(.*)'/s.exec(curl)?.[1] ?? '{}') as { acceptedTerms?: boolean };
  fireEvent.click(screen.getByRole('button', { name: /Lukk/ }));
  return body;
};

describe('the access request API preview', () => {
  it('claims acceptedTerms only once the terms box is ticked', async () => {
    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] }],
    });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={unregistered()} live />);
    const form = await screen.findByRole('form', { name: 'Be om tilgang' });

    expect(shownBody().acceptedTerms).toBe(false);
    fireEvent.click(
      within(form).getByLabelText(
        'Jeg har lest gjeldende utkast til vilkår og databehandleravtale',
      ),
    );
    expect(shownBody().acceptedTerms).toBe(true);
  });
});

describe('an organisation that is not registered', () => {
  it('can still open the profile page and choose a language', async () => {
    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] }],
    });
    await auth.login();
    window.location.hash = '#/profile';
    render(<App auth={auth} fetch={unregistered()} live />);

    expect(await screen.findByRole('group', { name: 'Språk / Language' })).toBeTruthy();
  });
});
