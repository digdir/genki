// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleModels, mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const openDetail = async (key: string, name: string, fetch?: typeof globalThis.fetch) => {
  await renderAt(`#/shared-services/${key}`, fetch);
  await screen.findByRole('heading', { level: 1, name });
};

const pricedModels = exampleModels.map((m) =>
  m.id === 'aivar/borealis-27b'
    ? { ...m, price: { inputPerThousand: 0.0119, outputPerThousand: 0.0952 } }
    : m,
);
const withPrices = () => mockFetch(undefined, undefined, pricedModels);
const withoutPrices = () =>
  mockFetch(
    undefined,
    undefined,
    exampleModels.map(({ price: _price, ...m }) => m),
  );
const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
const cardOf = async (name: string) =>
  (await screen.findByRole('link', { name })).closest('li') as HTMLElement;

const resultBox = () => screen.getByText('Resultat').parentElement as HTMLElement;

const pick = (input: HTMLElement, name: string, size = 1000) => {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(input, { target: { files: [file] } });
};

const filesFetch = (bodies: unknown[] = []) => {
  const base = mockFetch(undefined, undefined, undefined, undefined, {
    chatReply: 'Lest.',
    capabilities: [
      {
        id: 'klarsprak__default',
        _files: {
          accepts: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ],
          max_bytes: 10 * 1048576,
          max_count: 1,
        },
      } as never,
    ],
  });
  return ((input, init) => {
    if (urlOf(input).includes('/v1/chat/completions')) bodies.push(JSON.parse(String(init?.body)));
    return base(input, init);
  }) as typeof globalThis.fetch;
};

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('Fellestjenester: liste', () => {
  it('looks up model prices among all models, so a model the policy holds back keeps its price', async () => {
    const urls: string[] = [];
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) => {
      urls.push(urlOf(input));
      return base(input, init);
    };
    await renderAt('#/shared-services', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Fellestjenester' });
    expect(urls.filter((u) => /\/models(\?|$)/.test(u))).toEqual(['/api/models?all=true']);
  });

  it('shows the six capabilities from the live API as cards', async () => {
    const urls: string[] = [];
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) => {
      urls.push(urlOf(input));
      return base(input, init);
    };
    await renderAt('#/shared-services', fetch);
    expect(await screen.findByRole('heading', { level: 1, name: 'Fellestjenester' })).toBeTruthy();
    expect(urls.some((u) => u.endsWith('/shared-services'))).toBe(true);
    const cards = within(screen.getByRole('main'))
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(cards).toEqual([
      'Klarspråk',
      'Bokmål til nynorsk',
      'Oppsummering',
      'Anonymisering',
      'Transkribering',
      'Hent ut opplysninger',
    ]);
    const nyn = screen
      .getByRole('link', { name: 'Bokmål til nynorsk' })
      .closest('li') as HTMLElement;
    expect(within(nyn).getByText('Brukes i 1 tjeneste')).toBeTruthy();
    expectAccessible();
  });

  it('shows only the name, short description and residency on a shared service card, and leaves the facts to the detail page', async () => {
    await renderAt('#/shared-services');
    const klar = (await screen.findByRole('link', { name: 'Klarspråk' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(klar).getByText(/Skriver om tekst så den blir lettere å forstå/)).toBeTruthy();
    for (const fact of ['Inn', 'Ut', 'Modell', 'Kvalitet', 'Per 1 000 kjøringer', '81 av 100'])
      expect(within(klar).queryByText(fact)).toBeNull();
    expect(screen.queryByText(/Kvaliteten er målt på testsettene til Digdir/)).toBeNull();
  });

  it('says on each card how many services use it, or that none does yet', async () => {
    await renderAt('#/shared-services');
    const card = async (name: string) =>
      (await screen.findByRole('link', { name })).closest('li') as HTMLElement;
    expect(within(await card('Klarspråk')).getByText('Brukes i 1 tjeneste')).toBeTruthy();
    expect(within(await card('Anonymisering')).getByText('Brukes ikke ennå')).toBeTruthy();
  });

  it('says nothing about usage on a card when the building blocks cannot be loaded', async () => {
    await renderAt('#/shared-services', failingFetch(/building-blocks/));
    const klar = (await screen.findByRole('link', { name: 'Klarspråk' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(klar).queryByText(/Brukes/)).toBeNull();
  });

  it('says where each shared service processes data in a line on its card', async () => {
    await renderAt('#/shared-services');
    const felt = (await screen.findByRole('link', { name: 'Hent ut opplysninger' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(felt).getByText(/^Behandler data i Norge · /)).toBeTruthy();
  });
  it("adds the model's price per 1M tokens from /models to the line on each card", async () => {
    await renderAt('#/shared-services', withPrices());
    expect(
      within(await cardOf('Klarspråk')).getByText(
        'Behandler data i Norge · 11,90 kr inn og 95,20 kr ut per 1M tokens',
      ),
    ).toBeTruthy();
  });

  it('says on a card that the price is not calculated when its model has no price', async () => {
    await renderAt('#/shared-services', withoutPrices());
    expect(
      within(await cardOf('Klarspråk')).getByText('Behandler data i Norge · pris ikke beregnet'),
    ).toBeTruthy();
  });

  it('says on a card that the price could not be fetched when the model list fails', async () => {
    await renderAt('#/shared-services', failingFetch(/\/models/));
    expect(within(await cardOf('Klarspråk')).getByText(/· kunne ikke hente prisen$/)).toBeTruthy();
  });

  it('introduces the list as ready-made services from Digdir, in the words of the design', async () => {
    await renderAt('#/shared-services');
    expect(
      await screen.findByText(
        'Ferdige tjenester fra Digdir. Bruk dem direkte, kall dem fra et system, eller legg dem inn i en av tjenestene deres.',
      ),
    ).toBeTruthy();
  });

  it('ends the list by asking which shared services are needed, linked to the contact page', async () => {
    await renderAt('#/shared-services');
    expect(await screen.findByText(/Flere fellestjenester kommer\./)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Si fra hvilke dere trenger.' }).getAttribute('href'),
    ).toBe('#/contact');
  });
  it('opens a detail page from the card button', async () => {
    await renderAt('#/shared-services');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Prøv og se detaljer for Anonymisering' }),
    );
    expect(window.location.hash).toBe('#/shared-services/anonymisering');
  });

  it('shows an error with retry when the catalogue cannot be loaded', async () => {
    await renderAt('#/shared-services', failingFetch(/shared-services/));
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Fellestjenester' })).toBeTruthy();
  });

  it('shows an empty state when no capabilities are available', async () => {
    await renderAt(
      '#/shared-services',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [] }),
    );
    expect(await screen.findByText('Ingen fellestjenester er tilgjengelige ennå')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Si fra hva dere trenger' }).getAttribute('href')).toBe(
      '#/contact',
    );
  });

  it("shows the API's purpose and the service's residency on the card for a capability without design data", async () => {
    await renderAt(
      '#/shared-services',
      mockFetch(undefined, undefined, undefined, undefined, {
        shared: [
          {
            tenant: '991825827',
            id: 'tolk',
            name: 'Tolk',
            purpose: 'Tolker tekst.',
            version: null,
            riskClass: null,
            residency: 'norway',
            dataLocation: 'norway' as const,
            model: 'foundry-openai/gpt-4.1',
            exposure: [],
            variants: [],
          },
        ],
      }),
    );
    expect(await screen.findByRole('link', { name: 'Tolk' })).toBeTruthy();
    expect(screen.getByText('Tolker tekst.')).toBeTruthy();
    expect(screen.getByText(/^Behandler data i Norge · /)).toBeTruthy();
    expectAccessible();
  });
});

describe('Fellestjenester: detalj', () => {
  const withFacts = {
    tenant: '991825827',
    id: 'nynorsk',
    name: 'Bokmål til nynorsk',
    purpose: 'Oversetter tekst.',
    version: 1,
    riskClass: null,
    residency: 'eu',
    dataLocation: 'eu' as const,
    model: 'aivar/borealis-27b',
    exposure: [],
    variants: [{ id: 'default', publicName: 'nynorsk__default', aliases: [] }],
    storage: { keepsText: false, logDays: 30 },
    languages: { in: ['nb', 'nn'], out: 'same' },
    estimatedCostPerThousandRuns: { microNok: 9_000_000, basis: 'tekster på én side' },
  };

  it('states the price per 1 000 runs, what is stored and the languages from the shared service', async () => {
    await openDetail(
      'nyn',
      'Bokmål til nynorsk',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [withFacts] }),
    );
    expect(fact('Pris')?.textContent).toBe(
      'Omtrent 9 kr per 1 000 kjøringer (anslått, for tekster på én side)',
    );
    expect(fact('Lagres')?.textContent).toBe(
      'Teksten lagres ikke. Kjøringen logges i 30 dager uten tekstinnhold.',
    );
    expect(fact('Språk')?.textContent).toBe('Bokmål og nynorsk inn, samme målform ut');
  });

  it('puts the price per 1 000 runs on the card, as the design does', async () => {
    await renderAt(
      '#/shared-services',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [withFacts] }),
    );
    expect(
      await screen.findByText('Behandler data i EU/EØS · omtrent 9 kr per 1 000 kjøringer'),
    ).toBeTruthy();
  });

  it('builds facts for a capability without design data from what the API gives', async () => {
    const tolk = {
      tenant: '991825827',
      id: 'tolk',
      name: 'Tolk',
      purpose: 'Tolker tekst.',
      version: null,
      riskClass: null,
      residency: 'eu',
      dataLocation: 'eu' as const,
      exposure: [],
      variants: [],
    };
    await openDetail(
      'tolk',
      'Tolk',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [tolk] }),
    );

    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(fact('Modell')?.textContent).toBe('Ikke oppgitt');
    expect(fact('Hvor data behandles')?.textContent).toBe('EU/EØS Slik behandles data');
    expect(screen.queryByRole('group', { name: 'Valg' })).toBeNull();
    expect(screen.queryByText('Versjon')).toBeNull();
  });

  it('leaves out quality, which the API does not give', async () => {
    await openDetail('klarsprak', 'Klarspråk');
    for (const label of ['Kvalitet på testsett', 'Per 1 000 kjøringer'])
      expect(screen.queryByText(label, { selector: 'dt' })).toBeNull();
    expect(screen.queryByText(/av 100/)).toBeNull();
    expect(screen.queryByText(/Kvaliteten falt/)).toBeNull();
  });
  it('names who publishes it, the version and when that version was published', async () => {
    await openDetail('klarsprak', 'Klarspråk');
    expect(
      await screen.findByText('Fra Digdir · versjon 3, oppdatert 4. november 2026'),
    ).toBeTruthy();
    const fact = screen.getByText('Ansvarlig', { selector: 'dt' }).nextElementSibling;
    expect(fact?.textContent).toBe('Digdir');
  });

  it('lists the facts Modell, Hvor data behandles, Lagres, Pris, Språk and Ansvarlig in that order', async () => {
    await openDetail('klarsprak', 'Klarspråk');
    const labels = [...screen.getByRole('complementary').querySelectorAll('dt')].map(
      (d) => d.textContent,
    );
    expect(labels).toEqual([
      'Modell',
      'Hvor data behandles',
      'Lagres',
      'Pris',
      'Språk',
      'Ansvarlig',
    ]);
  });

  it("shows the model's price per 1M tokens from /models as the Pris fact", async () => {
    await openDetail('klarsprak', 'Klarspråk', withPrices());
    expect(fact('Pris')?.textContent).toBe('11,90 kr inn og 95,20 kr ut per 1M tokens');
  });

  it('says the price is not calculated when the model has no price', async () => {
    await openDetail('klarsprak', 'Klarspråk', withoutPrices());
    expect(fact('Pris')?.textContent).toBe('Ikke beregnet');
  });

  it('says what is stored and which languages it takes are not stated yet, since the API does not give them', async () => {
    await openDetail('klarsprak', 'Klarspråk');
    expect(fact('Lagres')?.textContent).toBe('Ikke oppgitt ennå');
    expect(fact('Språk')?.textContent).toBe('Ikke oppgitt ennå');
  });

  it('names the owner by organisation number and says nothing about usage when its building block is missing', async () => {
    await openDetail('klarsprak', 'Klarspråk', failingFetch(/building-blocks/));
    expect(fact('Ansvarlig')?.textContent).toBe('Organisasjonsnummer 991825827');
    expect(screen.queryByText(/Brukes/)).toBeNull();
    expect(screen.queryByText(/^Fra /)).toBeNull();
  });

  it('says how many services use it and names them, linked to each service', async () => {
    await openDetail('klarsprak', 'Klarspråk');
    expect(screen.getByText('Brukes i 1 tjeneste')).toBeTruthy();
    expect(screen.getByText(/Brukes i dag av/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vedtaksutkast' }).getAttribute('href')).toBe(
      '#/services/vedtaksutkast',
    );
  });
  it("takes where data is processed from the platform's data location for the service, not from the widest place its rule allows", async () => {
    const tolk = {
      tenant: '991825827',
      id: 'tolk',
      name: 'Tolk',
      purpose: 'Tolker tekst.',
      version: null,
      riskClass: null,
      residency: 'global',
      dataLocation: 'eu' as const,
      model: 'foundry-openai/gpt-4o-2m-tps',
      exposure: [],
      variants: [],
    };
    await openDetail(
      'tolk',
      'Tolk',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [tolk] }),
    );
    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(fact('Modell')?.textContent).toBe('gpt-4o-2m-tps');
    expect(fact('Hvor data behandles')?.textContent).toBe('EU/EØS Slik behandles data');
  });

  it('klar: shows facts from the API and opens the builder without a hand-off it does not read', async () => {
    await openDetail('klar', 'Klarspråk');
    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(fact('Modell')?.textContent).toBe('borealis-27b');
    expect(fact('Hvor data behandles')?.textContent).toBe('Norge Slik behandles data');
    expect(screen.getByRole('link', { name: 'Slik behandles data' }).getAttribute('href')).toBe(
      '#/data-handling',
    );
    expect(screen.getByRole('link', { name: 'Åpne byggeren' }).getAttribute('href')).toBe(
      '#/services/new',
    );
    expect(document.querySelector('a[href*="?tool="]')).toBeNull();
    expect(screen.getByText('Verktøynavn: digdir.klarsprak@3')).toBeTruthy();
    expect(screen.getByText('Resultatet vises her når du trykker «Kjør».')).toBeTruthy();
    expectAccessible();
  });
  it('runs the sample text through the API and shows only what the service answered', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const bodies: unknown[] = [];
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      chatReply: 'Svar fra tjenesten.',
    });
    await openDetail('klarsprak', 'Klarspråk', (input, init) => {
      if (urlOf(input).includes('/v1/chat/completions'))
        bodies.push(JSON.parse(String(init?.body)));
      return base(input, init);
    });
    const sample = (screen.getByLabelText('Tekst du vil skrive om') as HTMLTextAreaElement).value;
    expect(sample).toMatch(/^Det vises til Deres søknad/);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(await within(resultBox()).findByText('Svar fra tjenesten.')).toBeTruthy();
    expect(bodies).toEqual([
      { model: 'klarsprak__default', messages: [{ role: 'user', content: sample }] },
    ]);
    expect(within(resultBox()).queryByText(/Du får ikke tilskudd/)).toBeNull();
    expect(within(resultBox()).getByText('Ferdig · borealis-27b, Norge')).toBeTruthy();
    fireEvent.click(within(resultBox()).getByRole('button', { name: 'Kopier resultatet' }));
    expect(await within(resultBox()).findByText('Kopiert')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('Svar fra tjenesten.');
    expectAccessible();
  });

  it('klar: sends edited text to the live capability and shows the reply', async () => {
    const bodies: unknown[] = [];
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      chatReply: 'Svar fra modellen.',
    });
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (urlOf(input).includes('/v1/chat/completions'))
        bodies.push(JSON.parse(String(init?.body)));
      return base(input, init);
    };
    await openDetail('klar', 'Klarspråk', fetch);
    fireEvent.change(screen.getByLabelText('Tekst du vil skrive om'), {
      target: { value: 'Egen tekst.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(await within(resultBox()).findByText('Svar fra modellen.')).toBeTruthy();
    expect(bodies[0]).toMatchObject({
      model: 'klarsprak__default',
      messages: [{ role: 'user', content: 'Egen tekst.' }],
    });
    expect(within(resultBox()).getByText('Ferdig · borealis-27b, Norge')).toBeTruthy();
  });

  it('klar: explains a failed live run without saving anything', async () => {
    await openDetail('klar', 'Klarspråk', failingFetch(/chat\/completions/));
    fireEvent.change(screen.getByLabelText('Tekst du vil skrive om'), {
      target: { value: 'Egen tekst.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(
      await screen.findByText('Kjøringen feilet. Ingenting er lagret. Prøv igjen om litt.'),
    ).toBeTruthy();
  });

  it('offers no file upload while the service does not say it takes files', async () => {
    await openDetail('klar', 'Klarspråk');
    const text = screen.getByLabelText('Tekst du vil skrive om');
    expect(screen.queryByText('Velg fil')).toBeNull();
    fireEvent.change(text, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(screen.getByText('Skriv eller lim inn en tekst først.')).toBeTruthy();
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('0 av 20 000 tegn')).toBeTruthy();
    fireEvent.change(text, { target: { value: 'a'.repeat(20001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(
      screen.getByText('Teksten er lengre enn 20 000 tegn. Kort den ned og prøv igjen.'),
    ).toBeTruthy();
    expectAccessible();
  });

  it('checks a file against the types and size the service takes', async () => {
    await openDetail('klar', 'Klarspråk', filesFetch());
    const input = await screen.findByLabelText('Velg fil');
    expect(screen.getByText('Ingen fil valgt')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tekst du vil skrive om'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(
      screen.getByText('Skriv eller lim inn en tekst først, eller last opp et dokument.'),
    ).toBeTruthy();
    pick(input, 'bilde.png');
    expect(screen.getByText('Filen må være en av disse typene: PDF, Word (.docx).')).toBeTruthy();
    pick(input, 'stor.pdf', 11 * 1048576);
    expect(screen.getByText(/^Filen er større enn 10/)).toBeTruthy();
    pick(input, 'brev.docx');
    expect(screen.queryByText(/^Filen er større enn/)).toBeNull();
    expect(screen.getByText('brev.docx')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tilbakestill' }));
    expect(screen.queryByText('brev.docx')).toBeNull();
    expectAccessible();
  });

  it('sends a chosen file as a file part and never shows a result that was not run', async () => {
    const bodies: unknown[] = [];
    await openDetail('klar', 'Klarspråk', filesFetch(bodies));
    const input = await screen.findByLabelText('Velg fil');
    fireEvent.change(screen.getByLabelText('Tekst du vil skrive om'), { target: { value: '' } });
    fireEvent.change(input, {
      target: { files: [new File(['hei'], 'brev.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(await within(resultBox()).findByText('Lest.')).toBeTruthy();
    expect(bodies).toEqual([
      {
        model: 'klarsprak__default',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: { filename: 'brev.pdf', file_data: 'data:application/pdf;base64,aGVp' },
              },
            ],
          },
        ],
      },
    ]);
  });

  it('nyn: marks the nynorsk description with lang="nn" but not the answer it has not seen', async () => {
    await openDetail('nyn', 'Bokmål til nynorsk');
    expect(screen.getByText(/^Set om tekst frå bokmål til nynorsk/).getAttribute('lang')).toBe(
      'nn',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    const done = await within(resultBox()).findByText(/^Ferdig/);
    expect(done.closest('[lang="nn"]')).toBeNull();
    expectAccessible();
  });

  it('has no choice of target group or length, which the service does not read', async () => {
    await openDetail('sum', 'Oppsummering');
    expect(screen.queryByRole('group', { name: 'Lengde' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('trans: offers no audio upload and no sample recording while the service takes no audio', async () => {
    await openDetail('trans', 'Transkribering');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /eksempelopptak/ })).toBeNull();
    expect(screen.getByText('Denne tjenesten tar ikke imot lydfiler herfra ennå.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(screen.getByText('Velg en lydfil først.')).toBeTruthy();
    expect(within(resultBox()).queryByText(/Taler 1/)).toBeNull();
  });

  it('shows the call in three languages with an API key, and links to where a key is made', async () => {
    await openDetail('klar', 'Klarspråk');
    const request = screen.getByRole('region', { name: 'Eksempel på forespørsel' });
    expect(request.getAttribute('tabindex')).toBe('0');
    expect(request.textContent).toContain('curl -X POST');
    expect(request.textContent).toContain('Bearer $GENKI_KEY');
    expect(request.textContent).toContain('"model": "klarsprak__default"');
    fireEvent.click(screen.getByRole('tab', { name: 'Python' }));
    expect(screen.getByRole('region', { name: 'Eksempel på forespørsel' }).textContent).toContain(
      'requests.post(',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'JavaScript' }));
    expect(screen.getByRole('region', { name: 'Eksempel på forespørsel' }).textContent).toContain(
      'await fetch(',
    );
    expect(screen.getByRole('button', { name: 'Kopier koden' })).toBeTruthy();
    expect(screen.getByText(/Bruk en API-nøkkel med tilgang til alle tjenestene/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lag en nøkkel' }).getAttribute('href')).toBe(
      '#/developer/keys',
    );
    expect(screen.queryByText(/Maskinporten/)).toBeNull();
    expectAccessible();
  });
  it('says the capability was not found for an unknown id', async () => {
    await renderAt('#/shared-services/finnes-ikke');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke fellestjenesten' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Fellestjenester' })).toBeTruthy();
  });

  it('offers the builder only to people who may manage services, and names the right otherwise', async () => {
    const auth = mockAnsattporten({
      name: 'Ola Nordmann',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] }],
    });
    await auth.login();
    window.location.hash = '#/shared-services/klarsprak';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Klarspråk' });
    expect(screen.queryByRole('link', { name: 'Åpne byggeren' })).toBeNull();
    expect(screen.getByText(/Administrere tjenester/)).toBeTruthy();
  });

  it('still says where data is processed when the model list fails, since the service gives it', async () => {
    await openDetail('klarsprak', 'Klarspråk', failingFetch(/\/models/));
    const fact = screen.getByText('Hvor data behandles', { selector: 'dt' }).nextElementSibling;
    expect(fact?.textContent).toBe('Norge Slik behandles data');
  });
});
