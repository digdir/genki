// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const openDetail = async (key: string, name: string, fetch?: typeof globalThis.fetch) => {
  await renderAt(`#/shared-services/${key}`, fetch);
  await screen.findByRole('heading', { level: 1, name });
};

const resultBox = () => screen.getByText('Resultat').parentElement as HTMLElement;

const pick = (input: HTMLElement, name: string, size = 1000) => {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Fellestjenester: liste', () => {
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
    const klar = screen.getByRole('link', { name: 'Klarspråk' }).closest('li') as HTMLElement;
    expect(within(klar).getByText('81 av 100')).toBeTruthy();
    expect(within(klar).getByText('Var 89 for to uker siden')).toBeTruthy();
    expect(within(klar).getByText('7,50 kr')).toBeTruthy();
    expect(within(klar).getByText('Norge')).toBeTruthy();
    const nyn = screen
      .getByRole('link', { name: 'Bokmål til nynorsk' })
      .closest('li') as HTMLElement;
    expect(within(nyn).getByText('Brukes i 1 av tjenestene deres')).toBeTruthy();
    expect(
      screen.getByText(/Kvaliteten er målt på testsettene til Digdir og oppdateres hver uke/),
    ).toBeTruthy();
    expectAccessible();
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
    expect(await screen.findByText('Ingen fellestjenester ennå')).toBeTruthy();
  });

  it('falls back to API fields for a capability without design data', async () => {
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
            residency: 'eu',
            exposure: [],
            variants: [],
          },
        ],
      }),
    );
    expect(await screen.findByRole('link', { name: 'Tolk' })).toBeTruthy();
    expect(screen.getByText('EU/EØS')).toBeTruthy();
    expectAccessible();
  });
});

describe('Fellestjenester: detalj', () => {
  it('builds facts for a capability without design data from what the API gives', async () => {
    const tolk = {
      tenant: '991825827',
      id: 'tolk',
      name: 'Tolk',
      purpose: 'Tolker tekst.',
      version: null,
      riskClass: null,
      residency: 'eu',
      exposure: [],
      variants: [],
    };
    await openDetail(
      'tolk',
      'Tolk',
      mockFetch(undefined, undefined, undefined, undefined, { shared: [tolk] }),
    );

    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(fact('Modell og data')?.textContent).toBe('Behandles i EU/EØS');
    expect(screen.queryByText('Per 1 000 kjøringer')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Valg' })).toBeNull();
    expect(screen.queryByText(/Ikke oppgitt, behandles i/)).toBeNull();
  });

  it('names the model the API gives for a shared service instead of saying it is not given', async () => {
    const tolk = {
      tenant: '991825827',
      id: 'tolk',
      name: 'Tolk',
      purpose: 'Tolker tekst.',
      version: null,
      riskClass: null,
      residency: 'eu',
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
    expect(fact('Modell og data')?.textContent).toBe('gpt-4o-2m-tps, behandles i EU/EØS');
  });

  it('klar: shows facts, the score drop alert and builder links with the versioned tool', async () => {
    await openDetail('klar', 'Klarspråk');
    expect(screen.getByText('Versjon 2.3')).toBeTruthy();
    expect(screen.getByText('Borealis-27B, behandles i Norge')).toBeTruthy();
    expect(screen.getByText(/Kvaliteten falt fra 89 til 79/)).toBeTruthy();
    const links = [
      screen.getByRole('link', { name: 'Bruk i en tjeneste' }),
      screen.getByRole('link', { name: 'Åpne byggeren med Klarspråk' }),
    ];
    links.forEach((l) =>
      expect(l.getAttribute('href')).toBe('#/services/new?tool=digdir.klarsprak@2.3'),
    );
    expect(screen.getByText('Verktøynavn: digdir.klarsprak@2.3')).toBeTruthy();
    expect(screen.getByText('Resultatet vises her når du trykker «Kjør».')).toBeTruthy();
    expectAccessible();
  });

  it('klar: runs the sample and shows result, change notes and copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('klarsprak', 'Klarspråk');
    expect((screen.getByLabelText('Tekst du vil skrive om') as HTMLTextAreaElement).value).toMatch(
      /^Det vises til Deres søknad/,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Fagpersoner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(within(resultBox()).getByText('Kjører klarspråk')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kjør' }).getAttribute('aria-disabled')).toBe('true');
    expectAccessible();
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(within(resultBox()).getByText(/Du får ikke tilskudd\./)).toBeTruthy();
    expect(within(resultBox()).getByText('Beholdt henvisningen til § 4 første ledd.')).toBeTruthy();
    expect(
      within(resultBox()).getByText('Ferdig på 2,1 s · 1 240 tokens · Borealis-27B, Norge'),
    ).toBeTruthy();
    fireEvent.click(within(resultBox()).getByRole('button', { name: 'Kopier resultatet' }));
    expect(within(resultBox()).getByText('Kopiert')).toBeTruthy();
    expect(within(resultBox()).getByRole('link', { name: 'Se tidslinjen' })).toBeTruthy();
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
    expect(within(resultBox()).getByText('Ferdig · Borealis-27B, Norge')).toBeTruthy();
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

  it('klar: validates empty text, too long text and wrong file type', async () => {
    await openDetail('klar', 'Klarspråk');
    const text = screen.getByLabelText('Tekst du vil skrive om');
    fireEvent.change(text, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(screen.getByText('Lim inn tekst eller last opp en fil.')).toBeTruthy();
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('0 av 20 000 tegn')).toBeTruthy();
    expectAccessible();
    fireEvent.change(text, { target: { value: 'a'.repeat(20001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(
      screen.getByText('Teksten er lengre enn 20 000 tegn. Last den opp som fil i stedet.'),
    ).toBeTruthy();
    pick(screen.getByLabelText('eller last opp en fil:'), 'bilde.png');
    expect(screen.getByText('Filen må være PDF, Word (.docx) eller tekst.')).toBeTruthy();
    pick(screen.getByLabelText('eller last opp en fil:'), 'stor.pdf', 201 * 1048576);
    expect(screen.getByText('Filen er større enn 200 MB.')).toBeTruthy();
    pick(screen.getByLabelText('eller last opp en fil:'), 'brev.docx');
    expect(screen.queryByText('Filen er større enn 200 MB.')).toBeNull();
    expect(screen.getByText('brev.docx')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tilbakestill' }));
    expect((text as HTMLTextAreaElement).value).toMatch(/^Det vises til/);
    expect(screen.queryByText('brev.docx')).toBeNull();
  });

  it('nyn: marks the nynorsk description, result and notes with lang="nn"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('nyn', 'Bokmål til nynorsk');
    expect(screen.getByText(/^Set om tekst frå bokmål til nynorsk/).getAttribute('lang')).toBe(
      'nn',
    );
    expect(screen.getByRole('radio', { name: 'Moderat nynorsk' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const result = within(resultBox()).getByText(/^Du kan søkje om tilskot/);
    expect(result.closest('[lang]')?.getAttribute('lang')).toBe('nn');
    const note = within(resultBox()).getByText(/Brukte «tilskot»/);
    expect(note.closest('[lang]')?.getAttribute('lang')).toBe('nn');
    expect(
      within(resultBox())
        .getByText(/Ferdig på 1,4 s/)
        .closest('[lang="nn"]'),
    ).toBeNull();
    expectAccessible();
  });

  it('sum: offers length options and shows the summary with references', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('sum', 'Oppsummering');
    const group = screen.getByRole('group', { name: 'Lengde' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(
      within(resultBox()).getByText(/Telefonhenvendelsene gikk ned med 18 prosent/),
    ).toBeTruthy();
    expectAccessible();
  });

  it('anon: needs at least one type of personal data and lists findings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('anon', 'Anonymisering');
    const group = screen.getByRole('group', { name: 'Fjern' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(4);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Navn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(screen.getByText('Velg minst én type opplysning som skal fjernes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fødselsnummer' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Adresse' }));
    expect(screen.queryByText('Velg minst én type opplysning som skal fjernes.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(
      within(resultBox()).getByText(/^\[NAVN\] \(fødselsnummer \[FØDSELSNUMMER\]\)/),
    ).toBeTruthy();
    expect(
      within(resultBox()).getByText('Datoen ble beholdt fordi den ikke peker på en person.'),
    ).toBeTruthy();
  });

  it('trans: requires an audio file, accepts the sample and shows the transcript', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('trans', 'Transkribering');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(screen.getByText('Velg en lydfil, eller bruk eksempelopptaket.')).toBeTruthy();
    pick(screen.getByLabelText('Last opp lydfil'), 'notat.pdf');
    expect(screen.getByText('Filen må være MP3, M4A eller WAV.')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk eksempelopptak (2 min)' }));
    expect(screen.getByText('Eksempelopptak.m4a (2 min)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    expect(within(resultBox()).getByText('Transkriberer opptaket')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(resultBox()).getByText(/\[00:00\] Taler 1: Da starter vi\./)).toBeTruthy();
    expect(within(resultBox()).getByText('Ferdig på 9,8 s · NB-Whisper large, Norge')).toBeTruthy();
  });

  it('felt: shows extracted fields as a description list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail('felt', 'Hent ut opplysninger');
    fireEvent.click(screen.getByRole('radio', { name: 'Faktura' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const box = resultBox();
    expect(within(box).getByText('Søkers navn').tagName).toBe('DT');
    expect(within(box).getByText('Elvebakken Musikkorps').tagName).toBe('DD');
    expect(within(box).getByText('Vedtekter')).toBeTruthy();
    expectAccessible();
  });

  it('shows request and response examples in three languages with copy buttons', async () => {
    await openDetail('klar', 'Klarspråk');
    const request = screen.getByRole('region', { name: 'Eksempel på forespørsel' });
    expect(request.getAttribute('tabindex')).toBe('0');
    expect(request.textContent).toContain('curl -X POST');
    expect(request.textContent).toContain('"model": "klarsprak__default"');
    expect(request.textContent).toContain('digdir.klarsprak@2.3');
    fireEvent.click(screen.getByRole('radio', { name: 'Python' }));
    expect(request.textContent).toContain('requests.post(');
    fireEvent.click(screen.getByRole('radio', { name: 'JavaScript' }));
    expect(request.textContent).toContain('await fetch(');
    const response = screen.getByRole('region', { name: 'Eksempel på svar' });
    expect(response.textContent).toContain('"total_tokens": 1240');
    expect(screen.getByText('200 OK')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Kopier' })).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: 'Mer om Maskinporten-klienter' }).getAttribute('href'),
    ).toBe('#/developer/systems');
    expectAccessible();
  });

  it('marks the example response as an example with an id no real call has', async () => {
    await openDetail('klar', 'Klarspråk');
    const response = screen.getByRole('region', { name: 'Eksempel på svar' });
    expect(response.textContent).toContain('"id": "chatcmpl-example"');
    expect(response.textContent).not.toMatch(/opg_/);
    expect(
      screen.getByText('Svaret er et eksempel. Id, innhold og tokens blir andre i ekte kall.'),
    ).toBeTruthy();
  });

  it('says the capability was not found for an unknown id', async () => {
    await renderAt('#/shared-services/finnes-ikke');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke fellestjenesten' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Fellestjenester' })).toBeTruthy();
  });
});
