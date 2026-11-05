// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const reason = 'Prøver det nye API-et i test';

const typeInto = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

const openDescriptor = async (id: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Åpne ${id}` }));
  return within(await screen.findByRole('dialog', { name: id }));
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('model operations', () => {
  it('an operator tries, records a fixture for and approves an upload without the API', async () => {
    await signedIn('#/model-operations');
    const panel = await openDescriptor('openai/generate-image@1');

    typeInto(
      await panel.findByRole('textbox', { name: 'prompt' }),
      'En katt, send til kari@example.no',
    );
    typeInto(panel.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(panel.getByRole('button', { name: 'Prøv' }));

    await panel.findByText('Det som ble sendt');
    const sent = panel.getByText(/«EMAIL»/);
    expect(sent.textContent).not.toContain('kari@example.no');
    expect(panel.getByRole('img', { name: 'Bilde fra svaret (images[0])' })).toBeTruthy();

    fireEvent.click(panel.getByRole('button', { name: 'Lagre som testtilfelle' }));
    expect(await screen.findByText(/Testtilfellet try-1 er lagret/)).toBeTruthy();

    const approve = await screen.findByRole('button', { name: 'Godkjenn' });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    const dialog = within(await screen.findByRole('dialog', { name: /Godkjenn openai/ }));
    typeInto(dialog.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(dialog.getByRole('button', { name: 'Godkjenn' }));
    expect(await screen.findByText(/openai\/generate-image@1 er godkjent/)).toBeTruthy();
  });

  it('try is offered only in a test environment', async () => {
    const base = mockFetch();
    await signedIn('#/model-operations', async (input, init) => {
      const response = await base(input, init);
      if (!String(input).endsWith('/operator/operation-kinds')) return response;
      return Response.json({ ...((await response.json()) as object), environment: 'production' });
    });
    const panel = await openDescriptor('openai/generate-image@1');

    expect(await panel.findByText('Oppskrifter prøves bare i testmiljøet.')).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Prøv' })).toBeNull();
  });

  it('upload errors are shown next to the field they concern', async () => {
    await signedIn('#/model-operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Last opp oppskrift' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Last opp oppskrift' }));

    const text = dialog.getByRole('textbox', { name: 'Oppskrift (YAML eller JSON)' });
    typeInto(text, 'id: acme/classify@1\noperation: classify\n');
    const name = dialog.getByRole('textbox', { name: /Navn/ }) as HTMLInputElement;
    expect(name.value).toBe('acme/classify@1');
    typeInto(name, 'acme/classify@2');
    typeInto(dialog.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(dialog.getByRole('button', { name: 'Last opp og kontroller' }));

    const message = await dialog.findByText('the descriptor is called acme/classify@1');
    expect(message.closest('.ds-field')?.contains(name)).toBe(true);
    expect(text.closest('.field')?.contains(message)).toBe(false);
  });

  it('withdrawing a descriptor lists the services that use it', async () => {
    await signedIn('#/model-operations');
    const panel = await openDescriptor('example/classify@1');

    fireEvent.click(await panel.findByRole('button', { name: 'Trekk tilbake' }));
    const dialog = within(await screen.findByRole('dialog', { name: /Trekk tilbake/ }));
    expect(dialog.getByText('postsortering')).toBeTruthy();
    expect(dialog.getByText('Tjenester som bruker den (1)')).toBeTruthy();
  });

  it('one operator moves a kind to production with a reason', async () => {
    await signedIn('#/model-operations');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Flytt Bildegenerering til produksjon' }),
    );
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Flytt Bildegenerering til produksjon' }),
    );
    typeInto(dialog.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(dialog.getByRole('button', { name: 'Flytt til produksjon' }));
    expect(await screen.findByText(/Bildegenerering er i produksjon/)).toBeTruthy();
  });

  it('a processor record is set per endpoint on Modeller, with errors next to each field', async () => {
    await signedIn('#/models');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Databehandler for foundry-claude' }),
    );
    const panel = within(await screen.findByRole('dialog', { name: /Databehandler for/ }));

    fireEvent.click(panel.getByRole('button', { name: 'Lagre databehandler' }));
    const agreement = panel.getByRole('textbox', { name: /Databehandleravtale/ });
    const missing = await panel.findByText('Skriv inn hvilken avtale som gjelder.');
    expect(missing.closest('.ds-field')?.contains(agreement)).toBe(true);

    typeInto(agreement, 'DBA-2026-21');
    typeInto(panel.getByRole('textbox', { name: /Lagringstid/ }), '0');
    typeInto(panel.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(panel.getByRole('button', { name: 'Lagre databehandler' }));
    expect(await screen.findByText(/Databehandleren for foundry-claude er lagret/)).toBeTruthy();
  });
});
