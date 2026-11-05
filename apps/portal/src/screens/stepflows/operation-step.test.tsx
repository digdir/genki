// @vitest-environment jsdom
import { SchemaFormProvider } from '@genai/schema-forms';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import { RightsProvider } from '../../Shell';
import { renderAt } from '../../test-utils';
import type { PortalRight } from '../../types';
import { LiveWorkspace } from './LiveWorkspace';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(cleanup);

type Call = { url: string; method: string; body: unknown };

const recording = (base: typeof globalThis.fetch = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const newFlow = async (fetch?: typeof globalThis.fetch) => {
  await renderAt('#/step-flows', fetch);
  await screen.findByRole('heading', { level: 1, name: 'Stegflyter' });
  fireEvent.click(screen.getByRole('button', { name: 'Ny stegflyt' }));
  await screen.findByRole('heading', { level: 1, name: 'Arbeidsmåte' });
};

const addStep = (name: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: /Legg til (et )?steg/ }));
  const dialog = screen.getByRole('dialog', { name: 'Legg til steg' });
  fireEvent.click(within(dialog).getByRole('button', { name }));
};

const operationPicker = () =>
  screen.getByRole('combobox', { name: 'Operasjon' }) as HTMLSelectElement;

const addImageStep = async () => {
  addStep(/^Kall en operasjon/);
  await waitFor(() =>
    expect([...operationPicker().options].map((o) => o.value)).toContain(
      'example/generate-image@1',
    ),
  );
  fireEvent.change(operationPicker(), { target: { value: 'example/generate-image@1' } });
};

describe('a new step flow', () => {
  it('opens under the step flows breadcrumb, not under a new service', async () => {
    await newFlow();
    const crumbs = screen.getByRole('navigation', { name: 'Brødsmuler' });
    expect(within(crumbs).getByRole('link', { name: 'Stegflyter' })).toBeTruthy();
    expect(within(crumbs).queryByText('Ny tjeneste')).toBeNull();
  });

  it('a new flow that was never saved is saved as v1', async () => {
    await newFlow();
    addStep(/^Klassifiser/);
    expect(await screen.findByRole('button', { name: 'Lagre som v1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lagre som v2' })).toBeNull();
  });

  it('a new flow saves what the person writes as its purpose, never the placeholder', async () => {
    const { calls, fetch } = recording();
    await newFlow(fetch);
    addStep(/^Klassifiser/);
    fireEvent.click(screen.getByRole('button', { name: 'Slett steget' }));
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Første versjon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre som v1' }));
    expect(screen.getByText('Skriv hva flyten gjør.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(false);
    fireEvent.change(screen.getByLabelText(/Hva flyten gjør/), {
      target: { value: 'Sorterer brev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre som v1' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/definitions/validate'))?.body as {
      definition: { spec: { purpose: string } };
    };
    expect(sent.definition.spec.purpose).toBe('Sorterer brev');
  });
});

describe('a step that calls an operation', () => {
  it('offers the operations in use here and builds its input fields from the typed input', async () => {
    await newFlow();
    await addImageStep();
    expect(screen.getByText('Lager et bilde ut fra en tekst som beskriver det.')).toBeTruthy();
    expect(screen.getByRole('group', { name: /^prompt \(tekst, påkrevd\)/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^size \(valg\)/ })).toBeTruthy();
    const model = screen.getByRole('combobox', { name: 'Modell' }) as HTMLSelectElement;
    expect([...model.options].map((o) => o.textContent)).toEqual([
      'Modellen tjenesten har valgt for Generate image, ellers hovedmodellen',
      'Borealis-27B (Norge)',
      'GPT-4.1 (EU/EØS, mangler databehandleropplysninger)',
    ]);
    expect(screen.getByText('Stedet for behandling følger modellen.')).toBeTruthy();
    const checklist = screen.getByRole('group', { name: /^Før tjenesten kan publiseres/ });
    expect(
      within(checklist)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'OppfyltOperasjonen er gjennomgått og tatt i bruk her',
      'OppfyltTypen operasjon er i produksjon i dette miljøet',
      'Sjekkes når tjenesten publiseresTjenesten fjerner personopplysninger før modellkall',
      'Sjekkes når tjenesten publiseresModellen har databehandleropplysninger',
    ]);
  });

  it('does not say the operation is missing before the person has picked one', async () => {
    await newFlow();
    addStep(/^Kall en operasjon/);
    await waitFor(() => expect(operationPicker().options.length).toBeGreaterThan(1));
    const panel = screen.getByRole('dialog', { name: 'Kall en operasjon' });
    expect(within(panel).queryByText('Velg en operasjon.')).toBeNull();
    expect(within(panel).queryByText('Operasjon må fylles ut.')).toBeNull();
  });

  it('a flow with an operation step is valid only when its required input is wired', async () => {
    await newFlow();
    await addImageStep();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    expect(screen.getAllByText(/Mangler input: prompt\./).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Flyten er gyldig/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Endre steget Kall en operasjon/ }));
    fireEvent.change(document.getElementById('in-prompt') as HTMLSelectElement, {
      target: { value: 'input.sporsmal' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    expect(await screen.findByText(/^Flyten er gyldig/)).toBeTruthy();
  });

  it('a model without a processor record keeps the flow from being valid', async () => {
    await newFlow();
    await addImageStep();
    fireEvent.change(screen.getByRole('combobox', { name: 'Modell' }), {
      target: { value: 'foundry-openai/gpt-4.1' },
    });
    expect(screen.getByText(/Modellen GPT-4\.1 har ingen databehandleropplysninger/)).toBeTruthy();
  });

  it('the editor says before a test that operation steps run only in a published service', async () => {
    await newFlow();
    await addImageStep();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    expect(
      screen.getByText(/Steg som kaller en operasjon kjører bare i en publisert tjeneste/),
    ).toBeTruthy();
  });
});

const workspace = (rights: PortalRight[], fetch: typeof globalThis.fetch = mockFetch()) => {
  const api = createApiClient({ baseUrl: '', fetch, token: () => 'kari' });
  render(
    <RightsProvider value={rights}>
      <SchemaFormProvider fetchJson={api.getJson} routeParams={{ tenant: '999888777' }}>
        <LiveWorkspace
          api={api}
          tenant="999888777"
          query={new URLSearchParams()}
          flowId="svar-med-kilder"
          library={false}
        />
      </SchemaFormProvider>
    </RightsProvider>,
  );
};

const changeAStep = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Endre steget Planlegg søk' }));
  fireEvent.change(screen.getByLabelText('Navn på steget'), { target: { value: 'Planlegg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
};

describe('saving a step flow and rights', () => {
  it('save is disabled without the right to manage services, and says which right is missing', async () => {
    workspace(['use-services']);
    await changeAStep();
    const save = await screen.findByRole('button', { name: 'Lagre som v5' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Du trenger rettigheten «Administrere tjenester».')).toBeTruthy();
  });

  it('a 403 from the platform names the missing right instead of asking to try again', async () => {
    const base = mockFetch();
    const forbidding: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/definitions/validate'))
        return new Response(
          JSON.stringify({
            title: 'Du trenger rettigheten «Administrere tjenester»',
            status: 403,
            errors: [{ path: 'right', message: 'manage-services' }],
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        );
      return base(input, init);
    };
    workspace(['manage-services'], forbidding);
    await changeAStep();
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Kortere navn på planleggingen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre som v5' }));
    expect(
      await screen.findByText('Du trenger rettigheten «Administrere tjenester».'),
    ).toBeTruthy();
    expect(screen.queryByText('Kunne ikke lagre stegflyten. Prøv igjen.')).toBeNull();
  });
});
