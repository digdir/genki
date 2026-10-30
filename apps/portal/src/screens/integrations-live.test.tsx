// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { expectAccessible, kari } from '../test-utils';
import { describeSchedule } from './integrations/Triggers';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

interface Call {
  method: string;
  url: string;
  reason: string;
  body: unknown;
}

const live = async (hash: string) => {
  const calls: Call[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? 'GET',
      url,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return base(input, init);
  };
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  render(<App auth={auth} fetch={fetch} live />);
  return calls;
};

const row = async (name: string | RegExp) => screen.findByRole('button', { name });

describe('Integrasjoner: brukerflater fra API-et', () => {
  it('lists registered frontends with client id, return address and service', async () => {
    await live('#/integrations?tab=frontends');
    fireEvent.click(await row(/Intranettet/));

    expect(screen.queryByText(/kan ikke registreres i plattformen ennå/)).toBeNull();
    expect(screen.getByText('testetaten-intranett')).toBeTruthy();
    expect(screen.getByText('https://intranett.testetaten.example.no/ki/callback')).toBeTruthy();
    expect(screen.getByText('Ansattporten')).toBeTruthy();
    expectAccessible();
  });

  it('registers a frontend for a chosen service with a logged reason', async () => {
    const calls = await live('#/integrations?tab=frontends');
    fireEvent.click(await screen.findByRole('button', { name: 'Registrer brukerflate' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText('Navn'), { target: { value: 'Saksportalen' } });
    fireEvent.change(within(dialog).getByLabelText('Tillatte opprinnelser'), {
      target: { value: 'https://sak.testetaten.example.no' },
    });
    fireEvent.change(within(dialog).getByLabelText('Klient-ID'), {
      target: { value: 'testetaten-sak' },
    });
    fireEvent.change(within(dialog).getByLabelText(/sendes tilbake til etter innlogging/), {
      target: { value: 'https://sak.testetaten.example.no/callback' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Saksbehandlerne skal bruke assistenten' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));

    expect(
      await screen.findByText('Saksportalen er registrert. Endringen er logget.'),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toMatch(/\/clients\/saksportalen$/);
    expect(put?.reason).toBe('Saksbehandlerne skal bruke assistenten');
    expect(put?.body).toMatchObject({
      metadata: { name: 'Saksportalen' },
      spec: { kind: 'browser', allowedOrigins: ['https://sak.testetaten.example.no'] },
    });
  });

  it('removes a frontend only after a reason is given', async () => {
    const calls = await live('#/integrations?tab=frontends');
    fireEvent.click(await row(/Intranettet/));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern brukerflaten' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Intranettet er lagt ned' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fjern brukerflaten' }));

    expect(await screen.findByText('Intranettet er fjernet.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'DELETE')?.url).toMatch(/\/clients\/intranettet$/);
  });
});

describe('Integrasjoner: utløsere fra API-et', () => {
  it('counts a failing trigger in the follow-up list', async () => {
    await live('#/integrations?tab=triggers');

    expect(
      await screen.findByRole('heading', { name: '1 integrasjon trenger oppfølging' }),
    ).toBeTruthy();
    expect(screen.getByText('Mappen «teams-opptak»: får ikke startet tjenesten')).toBeTruthy();
    expectAccessible();
  });

  it('lists each trigger with its kind, service and honest source, and the failing one with its error', async () => {
    await live('#/integrations?tab=triggers');
    fireEvent.click(await row(/Mappen «teams-opptak»/));

    expect(screen.getByText('Når et dokument kommer inn · starter Møtereferat')).toBeTruthy();
    expect(screen.getByText('Plattformens fillagring · teams-opptak')).toBeTruthy();
    expect(screen.getByText('Utløseren fikk ikke startet tjenesten.')).toBeTruthy();
    expect(screen.getByText(/the capability motereferat is not published/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Hver natt kl\. 02\.00/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Køen «post-inn»/ })).toBeTruthy();
  });

  it('shows recent runs with a link to each run timeline', async () => {
    await live('#/integrations?tab=triggers');
    fireEvent.click(await row(/Køen «post-inn»/));

    const links = await screen.findAllByRole('link', { name: 'Se kjøringen' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '#/log/opg_post_118',
      '#/log/opg_post_117',
    ]);
  });

  it('says the trigger works when the service run failed, and leads to the run', async () => {
    await live('#/integrations?tab=triggers');
    fireEvent.click(await row(/Hver natt kl\. 02\.00/));

    expect(screen.getByText('Siste kjøring av tjenesten feilet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Se kjøringen' }));
    await waitFor(() => expect(window.location.hash).toBe('#/log/opg_nn_0910'));
  });

  it('pauses a trigger with a logged reason', async () => {
    const calls = await live('#/integrations?tab=triggers');
    fireEvent.click(await row(/Køen «post-inn»/));
    fireEvent.click(screen.getByRole('button', { name: 'Sett på pause' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Køen flyttes til ny server' },
    });
    const panel = screen.getByLabelText('Begrunnelse').closest('.ds-alert') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: 'Sett på pause' }));

    expect(await screen.findByText(/Køen «post-inn» er satt på pause/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toMatch(/\/triggers\/postsortering-91d3a7e5f0\/pause$/);
    expect(put?.body).toEqual({ paused: true });
    expect(put?.reason).toBe('Køen flyttes til ny server');
    expect(await screen.findByRole('button', { name: 'Start igjen' })).toBeTruthy();
  });
});

describe('schedule names', () => {
  it('names common schedules in plain words and shows anything else as written', () => {
    expect(describeSchedule('0 2 * * *')).toBe('Hver natt kl. 02.00');
    expect(describeSchedule('30 7 * * *')).toBe('Hver dag kl. 07.30');
    expect(describeSchedule('0 7 * * 1')).toBe('Hver mandag kl. 07.00');
    expect(describeSchedule('0 * * * *')).toBe('Hver time');
    expect(describeSchedule('*/5 * * * *')).toBe('Tidsplan «*/5 * * * *»');
  });
});
