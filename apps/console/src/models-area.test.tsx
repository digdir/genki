// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { exampleModels, mockFetch } from './mock';
import type { OperatorModel, RefreshResult } from './types';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
  reason?: string;
}

const recorded = (base: typeof fetch = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input), 'http://mock').pathname.replace(/^\/api/, ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch, changes: () => calls.filter((c) => c.method !== 'GET') };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const reason = 'Bekreftet med leverandøren';

const typeInto = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

const giveReason = (scope: HTMLElement, text = reason) =>
  typeInto(within(scope).getByRole('textbox', { name: 'Begrunnelse' }), text);

const dialog = async (name: string | RegExp) => screen.findByRole('dialog', { name });

const localModel: OperatorModel = {
  id: 'local-model/echo',
  endpoint: 'local-model',
  deployment: 'echo',
  residency: 'norway',
  capabilities: ['stream'],
  apis: { chat: 'openai/chat-completions@1' },
  enabled: false,
  origin: 'catalog',
  classified: true,
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Modeller: connections', () => {
  it('the mock has one foundry connection with two API families, as genki-test does', async () => {
    await signedIn('#/models');

    const table = await screen.findByRole('region', { name: 'Liste over tilkoblinger' });
    const row = within(table).getByText('foundry').closest('tr') as HTMLElement;
    expect(within(row).getByText('openai, anthropic')).toBeTruthy();
    expect(within(row).getByText(String(exampleModels.length))).toBeTruthy();
    expect(within(row).getByText('Registrert')).toBeTruthy();
  });

  it('a connection without a processor record is flagged and links to registering it', async () => {
    await signedIn('#/models');

    const alert = (await screen.findByText('local-model mangler databehandleravtale.')).closest(
      '.ds-alert',
    ) as HTMLElement;
    expect(within(alert).getByRole('link', { name: 'Registrer avtale' }).getAttribute('href')).toBe(
      '#/models?connection=local-model',
    );
    const table = screen.getByRole('region', { name: 'Liste over tilkoblinger' });
    const row = within(table).getByText('local-model').closest('tr') as HTMLElement;
    expect(within(row).getByText('Mangler')).toBeTruthy();
  });

  it('an empty connection list says how to start', async () => {
    const base = mockFetch();
    await signedIn('#/models', async (input, init) =>
      String(input).includes('kind=model-endpoint')
        ? Response.json({ data: [] })
        : base(input, init),
    );

    expect(await screen.findByRole('heading', { name: 'Ingen tilkoblinger ennå' })).toBeTruthy();
  });

  it('a connection in use cannot be removed, and says how many models use it', async () => {
    await signedIn('#/models?connection=foundry');

    const enabled = exampleModels.filter((m) => m.enabled).length;
    expect(
      await screen.findByText(
        `Kan ikke fjernes: ${enabled} modeller på tilkoblingen er i bruk. Ta dem ut av bruk først.`,
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Fjern tilkobling' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a connection no model uses is removed with its own reason', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?connection=local-model', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Fjern tilkobling' }));
    const box = await dialog('Fjern local-model');
    giveReason(box, 'Testressursen er lagt ned');
    fireEvent.click(within(box).getByRole('button', { name: 'Fjern' }));

    expect(await screen.findByText(/Tilkoblingen local-model er fjernet/)).toBeTruthy();
    expect(changes()).toEqual([
      {
        method: 'DELETE',
        path: '/operator/model-endpoints/local-model',
        reason: 'Testressursen er lagt ned',
      },
    ]);
  });

  it('shows the families, discovery rules and processor record of a connection', async () => {
    await signedIn('#/models?connection=foundry');

    expect(await screen.findByRole('heading', { name: 'foundry', level: 1 })).toBeTruthy();
    const families = screen.getByRole('region', { name: 'Familier og stier' });
    expect(within(families).getByText('/anthropic')).toBeTruthy();
    const rules = screen.getByRole('region', { name: 'Regler for oppdagelse' });
    expect(within(rules).getByText('claude-*')).toBeTruthy();
    expect(within(rules).getByText('anthropic/messages@1')).toBeTruthy();
    expect(screen.getByText('DBA-2026-17')).toBeTruthy();
  });

  it('editing a connection sends its families and discovery rules with the reason', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?connection=foundry', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Rediger tilkoblingen' }));
    const panel = await dialog('Rediger foundry');
    typeInto(within(panel).getByLabelText('Tar med (regel 1)'), 'gpt-*, o4-*');
    typeInto(within(panel).getByLabelText('Gi API (regel 1)'), 'openai/decide@1');
    giveReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre tilkobling' }));

    expect(await screen.findByText(/Tilkoblingen foundry er lagret/)).toBeTruthy();
    const put = changes().find((c) => c.method === 'PUT') as Call;
    expect(put.path).toBe('/operator/model-endpoints/foundry');
    expect(put.reason).toBe(reason);
    expect(put.body).toMatchObject({
      families: { openai: '/openai/v1', anthropic: '/anthropic' },
      discovery: [
        {
          idPrefix: 'foundry-openai',
          include: ['gpt-*', 'o4-*'],
          exclude: ['claude-*', 'text-embedding-*'],
          apis: { chat: 'openai/chat-completions@1', decide: 'openai/decide@1' },
        },
        { idPrefix: 'foundry-claude', include: ['claude-*'] },
      ],
    });
  });

  it('adds a connection and stores its secret without showing it again', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny tilkobling' }));
    const panel = await dialog('Ny tilkobling');
    typeInto(within(panel).getByLabelText('Navn'), 'foundry-eu');
    typeInto(within(panel).getByLabelText('Adresse (base URL)'), 'https://eu.foundry.example');
    typeInto(within(panel).getByLabelText('Familie'), 'anthropic');
    typeInto(within(panel).getByLabelText('Sti eller adresse'), '/anthropic');
    typeInto(within(panel).getByLabelText('Navn på hemmeligheten'), 'foundry-eu-key');
    typeInto(within(panel).getByLabelText('Verdi'), 'sk-hemmelig');
    giveReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre hemmelighet' }));
    expect(await within(panel).findByText(/foundry-eu-key er lagret/)).toBeTruthy();
    expect((within(panel).getByLabelText('Verdi') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(panel).getByRole('button', { name: 'Legg til tilkobling' }));
    const table = await screen.findByRole('region', { name: 'Liste over tilkoblinger' });
    expect(await within(table).findByText('foundry-eu')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      id: 'foundry-eu',
      baseURL: 'https://eu.foundry.example',
      auth: { kind: 'api-key', secret: 'secret://platform/foundry-eu-key' },
      families: { anthropic: '/anthropic' },
    });
    expect(document.body.textContent).not.toContain('sk-hemmelig');
  });

  it('a processor record is registered on the connection, with errors next to each field', async () => {
    await signedIn('#/models?connection=local-model');
    fireEvent.click(await screen.findByRole('button', { name: 'Registrer avtale' }));
    const panel = within(await dialog(/Databehandler for/));

    fireEvent.click(panel.getByRole('button', { name: 'Lagre databehandler' }));
    const agreement = panel.getByRole('textbox', { name: /Databehandleravtale/ });
    const missing = await panel.findByText('Skriv inn hvilken avtale som gjelder.');
    expect(missing.closest('.ds-field')?.contains(agreement)).toBe(true);

    typeInto(agreement, 'DBA-2026-21');
    typeInto(panel.getByRole('textbox', { name: /Lagringstid/ }), '0');
    typeInto(panel.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(panel.getByRole('button', { name: 'Lagre databehandler' }));
    expect(await screen.findByText(/Databehandleravtalen for local-model er lagret/)).toBeTruthy();
    expect(await screen.findByText('DBA-2026-21')).toBeTruthy();
  });
});

describe('Modeller: the model list', () => {
  const modelRow = async (name: string) => {
    const table = await screen.findByRole('region', { name: 'Liste over modeller' });
    return within(table).getByText(name, { selector: 'strong' }).closest('tr') as HTMLElement;
  };

  it('the model list shows only the kinds a model serves, without controls', async () => {
    await signedIn('#/models?tab=models');

    const table = await screen.findByRole('region', { name: 'Liste over modeller' });
    expect(within(table).queryAllByRole('combobox')).toEqual([]);
    expect(within(table).queryAllByRole('checkbox')).toEqual([]);
    expect(within(table).queryAllByRole('switch')).toEqual([]);
    const gpt = await modelRow('gpt-4.1');
    expect(within(gpt).getByText('Samtale · openai/chat-completions@1')).toBeTruthy();
    expect(within(gpt).getByText('Avgjørelser · openai/decide@1')).toBeTruthy();
    const claude = await modelRow('claude-sonnet-5-5');
    expect(within(claude).getByText('Samtale · anthropic/messages@1')).toBeTruthy();
    expect(within(claude).queryByText(/Avgjørelser/)).toBeNull();
    expect(within(table).queryByText('Ikke i bruk ·')).toBeNull();
    expect(within(await modelRow('gpt-4o-2M-tps')).getByText('Ikke bekreftet')).toBeTruthy();
  });

  it('the model list can be searched and filtered by connection, kind and confirmation', async () => {
    await signedIn('#/models?tab=models', mockFetch(undefined, [...exampleModels, localModel]));
    const table = await screen.findByRole('region', { name: 'Liste over modeller' });
    const names = () =>
      within(table)
        .queryAllByText(/./, { selector: 'strong' })
        .map((e) => e.textContent);

    typeInto(screen.getByRole('searchbox', { name: 'Søk etter modell' }), 'gpt-4');
    expect(names()).toEqual(['gpt-4o-2M-tps', 'gpt-4.1']);
    typeInto(screen.getByRole('searchbox', { name: 'Søk etter modell' }), '');

    typeInto(screen.getByLabelText('Tilkobling'), 'local-model');
    expect(names()).toEqual(['echo']);
    typeInto(screen.getByLabelText('Tilkobling'), '');

    typeInto(screen.getByLabelText('Type kall'), 'decide');
    expect(names()).toEqual(['gpt-4.1']);
    typeInto(screen.getByLabelText('Type kall'), '');

    typeInto(screen.getByLabelText('Bekreftet'), 'unconfirmed');
    expect(names()).toEqual(['gpt-4o-2M-tps']);
    expect(screen.getByText('Viser 1 av 5 modeller.')).toBeTruthy();
  });

  it('says how many models a refresh found and which providers did not answer, after its own reason', async () => {
    const result: RefreshResult = {
      discovered: 41,
      failed: [{ endpoint: 'foundry', error: 'listing deployments failed with HTTP 401' }],
    };
    const { changes, fetch } = recorded(mockFetch(undefined, undefined, result));
    await signedIn('#/models?tab=models', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Hent modeller på nytt' }));
    const box = await dialog('Hent modeller på nytt');
    fireEvent.click(within(box).getByRole('button', { name: 'Hent modeller på nytt' }));
    expect(await within(box).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(changes()).toEqual([]);

    giveReason(box, 'Ny deployment i Foundry');
    fireEvent.click(within(box).getByRole('button', { name: 'Hent modeller på nytt' }));
    expect(await screen.findByText('Fant 41 modeller.')).toBeTruthy();
    expect(screen.getByText(/foundry: listing deployments failed with HTTP 401/)).toBeTruthy();
  });

  it('adds a model on a connection with a chat API from its families', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models?tab=models', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Legg til modell' }));
    const panel = await dialog('Legg til modell');
    typeInto(within(panel).getByLabelText('Tilkobling'), 'local-model');
    typeInto(within(panel).getByLabelText('Utrulling (deployment)'), 'echo');
    const chat = within(panel).getByLabelText('API for samtale') as HTMLSelectElement;
    expect([...chat.options].map((o) => o.value)).toEqual([
      '',
      'openai/chat-completions@1',
      'openai/responses@1',
    ]);
    typeInto(chat, 'openai/responses@1');
    giveReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre modell' }));

    expect(await screen.findByText(/echo er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/operator/models/local-model/echo',
      body: { endpoint: 'local-model', deployment: 'echo', apis: { chat: 'openai/responses@1' } },
      reason,
    });
  });

  it('derives a valid model id from a deployment with a provider prefix and keeps the deployment as typed', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models?tab=models', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Legg til modell' }));
    const panel = await dialog('Legg til modell');
    typeInto(within(panel).getByLabelText('Tilkobling'), 'local-model');
    typeInto(within(panel).getByLabelText('Utrulling (deployment)'), 'Azure:GPT-6.1-Sol');
    giveReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre modell' }));

    expect(await screen.findByText(/Azure:GPT-6.1-Sol er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/operator/models/local-model/azure-gpt-6.1-sol',
      body: { deployment: 'Azure:GPT-6.1-Sol' },
    });
  });
});

describe('Modeller: one model', () => {
  it('each change asks for its own reason, and the page has no shared reason field', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?model=foundry-openai/gpt-4o-2m-tps', fetch);

    expect(await screen.findByRole('heading', { name: 'gpt-4o-2M-tps', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Begrunnelse' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Endre Data behandles' }));
    const box = await dialog('Endre hvor gpt-4o-2M-tps behandler data');
    typeInto(within(box).getByLabelText('Data behandles'), 'eu');
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre endring' }));
    expect(await within(box).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(changes()).toEqual([]);

    giveReason(box);
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre endring' }));
    await waitFor(() => expect(changes()).toHaveLength(1));
    expect(changes()[0]).toEqual({
      method: 'PATCH',
      path: '/operator/models/foundry-openai/gpt-4o-2m-tps',
      body: { residency: 'eu' },
      reason,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Sett pris' }));
    const price = await dialog('Sett pris for gpt-4o-2M-tps');
    expect(within(price).getByRole('textbox', { name: 'Begrunnelse' })).toBeTruthy();
  });

  it('changing an API shows the current and the new API and sends the bindings with its reason', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?model=foundry-openai/gpt-4.1', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Endre API for Samtale' }));
    const box = await dialog('Endre API for Samtale på gpt-4.1');
    expect(within(box).getByText('openai/chat-completions@1')).toBeTruthy();
    expect(within(box).getByText(/gjelder 4 tjenester som bruker gpt-4.1/)).toBeTruthy();
    typeInto(within(box).getByLabelText('Nytt'), 'openai/responses@1');
    giveReason(box, 'Responses gir resonnering mellom verktøykall');
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre endring' }));

    expect(await screen.findByText(/API-et på gpt-4.1 er endret/)).toBeTruthy();
    expect(changes()).toEqual([
      {
        method: 'PATCH',
        path: '/operator/models/foundry-openai/gpt-4.1',
        body: {
          apis: {
            chat: 'openai/responses@1',
            decide: 'openai/decide@1',
            'plain-language': 'openai/plain-language@1',
          },
        },
        reason: 'Responses gir resonnering mellom verktøykall',
      },
    ]);
  });

  it("a model is offered only APIs in its connection's families", async () => {
    await signedIn(
      '#/models?model=local-model/echo',
      mockFetch(undefined, [...exampleModels, localModel]),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Endre API for Samtale' }));
    const box = await dialog('Endre API for Samtale på echo');
    const offered = [...(within(box).getByLabelText('Nytt') as HTMLSelectElement).options]
      .map((o) => o.value)
      .filter(Boolean);
    expect(offered).toEqual(['openai/responses@1']);
    expect(within(box).getByText(/Bare API-er fra familiene på local-model vises/)).toBeTruthy();
  });

  it('retires a model only through a dialog that says services pause instead of switching', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?model=foundry-openai/gpt-4.1', fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Fas ut' }));
    const box = await dialog('Fas ut gpt-4.1');
    expect(within(box).getByText(/Ingen tjeneste bytter av seg selv/)).toBeTruthy();
    expect(within(box).getByText('Vedtaksutkast')).toBeTruthy();
    giveReason(box, 'Microsoft avslutter versjonen');
    fireEvent.click(within(box).getByRole('button', { name: 'Fas ut' }));

    expect(await screen.findByText(/er faset ut\. Endringen er logget i Revisjon\./)).toBeTruthy();
    expect(changes()[0]?.body).toEqual({ enabled: false });
  });
});

describe('Modeller: APIs and the guided path', () => {
  it('the old model operations route forwards to the API list', async () => {
    await signedIn('#/model-operations');

    expect(await screen.findByRole('region', { name: 'Liste over API-er' })).toBeTruthy();
    expect(window.location.hash).toBe('#/models?tab=apis');
  });

  it('lists every API with its source, status, test cases, kind maturity and models', async () => {
    await signedIn('#/models?tab=apis');

    const table = await screen.findByRole('region', { name: 'Liste over API-er' });
    const row = (id: string) => within(table).getByText(id).closest('tr') as HTMLElement;
    expect(within(row('openai/responses@1')).getByText('Innebygd')).toBeTruthy();
    expect(within(row('openai/decide@1')).getByText('Innebygd, med oppskrift')).toBeTruthy();
    expect(within(row('openai/embed@1')).getByText('Oppskrift, følger med')).toBeTruthy();
    const image = within(row('openai/generate-image@1'));
    expect(image.getByText('Oppskrift, lastet opp')).toBeTruthy();
    expect(image.getByText('Til vurdering')).toBeTruthy();
    expect(image.getByText('I test')).toBeTruthy();
    const plain = within(row('openai/plain-language@1'));
    expect(plain.getByText('2 testtilfeller')).toBeTruthy();
    expect(plain.getByText('I produksjon')).toBeTruthy();
  });

  it('the guided path shows what is still missing, including a missing processor record', async () => {
    await signedIn('#/models?api=example/classify@1&step=production');

    const missing = (await screen.findByRole('heading', { name: 'Dette mangler før produksjon' }))
      .parentElement as HTMLElement;
    expect(within(missing).getByText('Ingen modell bruker API-et ennå.')).toBeTruthy();
    expect(within(missing).getByText(/local-model mangler databehandleravtale/)).toBeTruthy();
    expect(
      within(missing).getByRole('link', { name: 'Registrer avtale' }).getAttribute('href'),
    ).toBe('#/models?connection=local-model');
    expect(within(missing).getByText('foundry har databehandleravtale.')).toBeTruthy();
  });

  it('each step links to the next one', async () => {
    await signedIn('#/models?api=openai/generate-image@1&step=upload');

    fireEvent.click(await screen.findByRole('button', { name: 'Neste: Prøv på en modell' }));
    expect(
      await screen.findByRole('heading', { name: 'Prøv på en modell', level: 2 }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/models?api=openai%2Fgenerate-image%401&step=try');
  });

  it('an API is tried only on a model that binds it', async () => {
    const { changes, fetch } = recorded();
    await signedIn('#/models?api=openai/generate-image@1&step=try', fetch);

    typeInto(await screen.findByLabelText('Modell'), 'foundry-openai/gpt-4.1');
    expect(
      await screen.findByText(/gpt-4.1 bruker ikke noe API for Bildegenerering ennå/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Knytt til gpt-4.1' }));
    const box = await dialog('Endre API for Bildegenerering på gpt-4.1');
    expect((within(box).getByLabelText('Nytt') as HTMLSelectElement).value).toBe(
      'openai/generate-image@1',
    );
    giveReason(box, 'Prøver bildegenerering på gpt-4.1');
    fireEvent.click(within(box).getByRole('button', { name: 'Lagre endring' }));

    expect(await screen.findByRole('button', { name: 'Prøv' })).toBeTruthy();
    expect(changes()[0]?.body).toMatchObject({
      apis: { 'generate-image': 'openai/generate-image@1' },
    });
  });

  it('an operator tries, saves a test case, approves and moves the kind to production along the path', async () => {
    await signedIn('#/models?api=openai/generate-image@1&step=try');

    typeInto(await screen.findByLabelText('Modell'), 'foundry-openai/gpt-image-1.5');
    typeInto(
      await screen.findByRole('textbox', { name: 'prompt' }),
      'En katt, send til kari@example.no',
    );
    const trying = screen.getByRole('button', { name: 'Prøv' }).closest('.stack') as HTMLElement;
    giveReason(trying, 'Prøver det nye API-et i test');
    fireEvent.click(screen.getByRole('button', { name: 'Prøv' }));
    await screen.findByText('Det som ble sendt');
    expect(screen.getByText(/«EMAIL»/).textContent).not.toContain('kari@example.no');
    fireEvent.click(screen.getByRole('button', { name: 'Lagre som testtilfelle' }));
    expect(await screen.findByText(/Testtilfellet try-1 er lagret/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Godkjenn$/ }));
    const approve = await screen.findByRole('button', { name: 'Godkjenn' });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    const approving = await dialog(/Godkjenn openai/);
    giveReason(approving, 'Kontrakttesten er bestått');
    fireEvent.click(within(approving).getByRole('button', { name: 'Godkjenn' }));
    expect(await screen.findByText(/openai\/generate-image@1 er godkjent/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sett i produksjon$/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Flytt Bildegenerering til produksjon' }),
    );
    const moving = await dialog('Flytt Bildegenerering til produksjon');
    giveReason(moving, 'Tre uker i test uten avvik');
    fireEvent.click(within(moving).getByRole('button', { name: 'Flytt til produksjon' }));
    expect(await screen.findByText(/Bildegenerering er i produksjon/)).toBeTruthy();
  });

  it('try is offered only in a test environment', async () => {
    const base = mockFetch();
    await signedIn('#/models?api=openai/generate-image@1&step=try', async (input, init) => {
      const response = await base(input, init);
      if (!String(input).endsWith('/operator/operation-kinds')) return response;
      return Response.json({ ...((await response.json()) as object), environment: 'production' });
    });

    expect(await screen.findByText('Oppskrifter prøves bare i testmiljøet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv' })).toBeNull();
  });

  it('upload errors are shown next to the field they concern', async () => {
    await signedIn('#/models?tab=apis');
    fireEvent.click(await screen.findByRole('button', { name: 'Nytt API' }));
    const box = within(await dialog('Last opp oppskrift'));

    const text = box.getByRole('textbox', { name: 'Oppskrift (YAML eller JSON)' });
    typeInto(text, 'id: acme/classify@1\noperation: classify\n');
    const name = box.getByRole('textbox', { name: /Navn/ }) as HTMLInputElement;
    expect(name.value).toBe('acme/classify@1');
    typeInto(name, 'acme/classify@2');
    typeInto(box.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(box.getByRole('button', { name: 'Last opp og kontroller' }));

    const message = await box.findByText('the descriptor is called acme/classify@1');
    expect(message.closest('.ds-field')?.contains(name)).toBe(true);
  });

  it('a new upload opens the guided path at trying it', async () => {
    await signedIn('#/models?tab=apis');
    fireEvent.click(await screen.findByRole('button', { name: 'Nytt API' }));
    const box = within(await dialog('Last opp oppskrift'));
    typeInto(
      box.getByRole('textbox', { name: 'Oppskrift (YAML eller JSON)' }),
      'id: acme/classify@1\noperation: classify\n',
    );
    typeInto(box.getByRole('textbox', { name: 'Begrunnelse' }), reason);
    fireEvent.click(box.getByRole('button', { name: 'Last opp og kontroller' }));

    expect(await screen.findByRole('heading', { name: 'acme/classify@1', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Prøv på en modell', level: 2 })).toBeTruthy();
  });

  it('withdrawing an API lists the services that use it', async () => {
    await signedIn('#/models?api=example/classify@1&step=upload');

    const withdraw = await screen.findByRole('button', { name: 'Trekk tilbake' });
    await waitFor(() => expect((withdraw as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(withdraw);
    const box = within(await dialog(/Trekk tilbake/));
    expect(box.getByText('postsortering')).toBeTruthy();
    expect(box.getByText('Tjenester som bruker den (1)')).toBeTruthy();
  });
});
