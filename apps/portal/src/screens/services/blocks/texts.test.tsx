// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fromTemplate, type AssistantLayout, type ProfileData } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlocksState } from './BlocksStep';
import { definition, fakeClient, answered } from './draft.test-utils';
import { keepStart, keptStart, layoutJson, readLayout } from './layoutStore';
import type { Collection } from './profileEdit';
import { ServicePreview } from './ServicePreview';
import { TemplatesPanel } from './TemplatesPanel';
import { TextsPanel } from './TextsPanel';

beforeEach(() => {
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  document.getAnimations ??= () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  sessionStorage.clear();
});
afterEach(cleanup);

const byggeregler: Collection = {
  key: 'byggeregler',
  fields: [
    { field: 'kommune', kinds: ['multiselect'] },
    { field: 'aar', kinds: ['multiselect'], 'value-type': 'integer' },
  ],
};

const next = () => ({ layout: fromTemplate('knowledge-assistant-next').layout });

/** The panel on the builder's own state, with the profile it makes. */
const Harness = ({ start = next }: { start?: () => { layout: AssistantLayout } }) => {
  const blocks = useBlocksState(start);
  return (
    <>
      <TemplatesPanel current={blocks.template} onPick={blocks.pick} />
      <TextsPanel layout={blocks.layout} collections={[byggeregler]} onChange={blocks.setProfile} />
      <output aria-label="Profilen">{JSON.stringify(blocks.layout.profile ?? null)}</output>
    </>
  );
};

const profile = (): ProfileData | null =>
  JSON.parse(
    screen.getByRole('status', { name: 'Profilen' }).textContent ?? 'null',
  ) as ProfileData | null;

const type = (name: string | RegExp, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

const descriptionOf = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

const openCollection = () => fireEvent.click(screen.getByText('Samlingen byggeregler'));

describe('the Tekster panel', () => {
  it('keeps the name, the suggestions and the note as typed, and takes an emptied one away', () => {
    render(<Harness />);
    expect(profile()).toBeNull();
    type('Navn', 'Byggehjelpen');
    fireEvent.click(screen.getByRole('button', { name: 'Legg til forslag' }));
    type('Forslag 1', 'Trenger jeg søknad?');
    type('Notat i Innstillinger', 'Valgene huskes her.');
    expect(profile()).toEqual({
      assistantName: 'Byggehjelpen',
      suggestions: ['Trenger jeg søknad?'],
      settingsNote: 'Valgene huskes her.',
    });
    type('Navn', '');
    fireEvent.click(screen.getByRole('button', { name: 'Fjern forslag 1' }));
    type('Notat i Innstillinger', '');
    expect(profile()).toBeNull();
  });

  it('offers at most six suggestions', () => {
    render(<Harness />);
    const add = screen.getByRole('button', { name: 'Legg til forslag' }) as HTMLButtonElement;
    for (let n = 0; n < 6; n += 1) fireEvent.click(add);
    expect(screen.getAllByRole('textbox', { name: /^Forslag \d$/ })).toHaveLength(6);
    expect(add.disabled).toBe(true);
  });

  it('says a broken limit under the field it concerns, and nowhere else', async () => {
    render(<Harness />);
    type('Navn', 'x'.repeat(81));
    await waitFor(() =>
      expect(descriptionOf(screen.getByRole('textbox', { name: 'Navn' }))).toContain(
        'Høyst 80 tegn.',
      ),
    );
    openCollection();
    type('Andre nummer', 'http://regler.example/{id}');
    await waitFor(() =>
      expect(descriptionOf(screen.getByRole('textbox', { name: 'Andre nummer' }))).toContain(
        'Må være en https-adresse, med vertsnavnet før {id}.',
      ),
    );
    expect(
      descriptionOf(screen.getByRole('textbox', { name: 'Nummer med bare sifre' })),
    ).not.toContain('https-adresse, med');
    type('Andre nummer', 'https://regler.example/dok/{id}');
    await waitFor(() =>
      expect(descriptionOf(screen.getByRole('textbox', { name: 'Andre nummer' }))).not.toContain(
        'Må være',
      ),
    );
    expect(profile()?.corpora?.byggeregler?.documentLinks).toEqual({
      any: 'https://regler.example/dok/{id}',
    });
  });

  it('names a collection’s fields, leaves one out, and makes one a year field within its years', async () => {
    render(<Harness />);
    openCollection();
    type('Navn på samlingen', 'Regler for bygg');
    const kommune = screen.getByRole('group', { name: 'Feltet kommune' });
    fireEvent.change(within(kommune).getByRole('textbox', { name: 'Navn i filteret' }), {
      target: { value: 'Kommuner' },
    });
    const aar = screen.getByRole('group', { name: 'Feltet aar' });
    fireEvent.click(within(aar).getByRole('switch', { name: /Årstall/ }));
    fireEvent.change(within(aar).getByRole('spinbutton', { name: /Første år/ }), {
      target: { value: '2030' },
    });
    fireEvent.change(within(aar).getByRole('spinbutton', { name: /Siste år/ }), {
      target: { value: '2020' },
    });
    await waitFor(() =>
      expect(descriptionOf(within(aar).getByRole('spinbutton', { name: /Første år/ }))).toContain(
        'Første år kommer etter siste år.',
      ),
    );
    expect(profile()?.corpora?.byggeregler).toEqual({
      label: 'Regler for bygg',
      fields: [
        { id: 'kommune', label: 'Kommuner' },
        { id: 'aar', label: 'aar', kind: 'year', years: { first: 2030, last: 2020 } },
      ],
    });
    fireEvent.click(within(kommune).getByRole('switch', { name: 'Med i filteret' }));
    expect(profile()?.corpora?.byggeregler?.fields?.map((f) => f.id)).toEqual(['aar']);
  });

  it('refuses a document type another row has, and says so, so no row or plural is lost', async () => {
    render(<Harness />);
    openCollection();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til dokumenttype' }));
    type('Dokumenttype 1', 'Årsrapport');
    type('Flertall av dokumenttype 1', 'årsrapporter');
    fireEvent.click(screen.getByRole('button', { name: 'Legg til dokumenttype' }));
    type('Dokumenttype 2', 'Årsrapport');
    expect(profile()?.corpora?.byggeregler?.typePlurals).toEqual({
      Årsrapport: 'årsrapporter',
      '': '',
    });
    await waitFor(() =>
      expect(descriptionOf(screen.getByRole('textbox', { name: 'Dokumenttype 2' }))).toContain(
        'Dokumenttypen står allerede i en annen rad.',
      ),
    );
    type('Dokumenttype 2', 'Evaluering');
    expect(profile()?.corpora?.byggeregler?.typePlurals).toEqual({
      Årsrapport: 'årsrapporter',
      Evaluering: '',
    });
  });

  it('fills in Kunnskapsassistenten’s words with its next template, and keeps the words through a change of template', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Fyll inn som Kunnskapsassistenten' }));
    expect(screen.getByText('Tekstene er fylt inn som Kunnskapsassistenten.')).toBeTruthy();
    expect(profile()).toMatchObject({
      assistantName: 'Kunnskapsassistenten',
      corpora: { kudos: { label: 'Kudos', typeField: 'type' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk Bare chat' }));
    expect(profile()?.assistantName).toBe('Kunnskapsassistenten');
    expect(screen.queryByRole('button', { name: 'Fyll inn som Kunnskapsassistenten' })).toBeNull();
    // Words for a collection the service does not search can be taken away.
    fireEvent.click(screen.getByRole('button', { name: 'Fjern tekstene for kudos' }));
    expect(profile()?.corpora).toBeUndefined();
  });
});

describe('the words kept with the layout', () => {
  it('go with «Kopier oppsettet» and «Lim inn oppsett»', () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: 'Byggehjelpen', suggestions: ['Trenger jeg søknad?'] },
    };
    expect(readLayout(layoutJson(layout))).toEqual({ layout });
  });

  it('are kept past a limit, as typed, so a reload does not lose the layout', () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: 'x'.repeat(81) },
    };
    keepStart('digdir', 'a', { layout });
    expect(keptStart('digdir', 'a')?.layout.profile).toEqual({ assistantName: 'x'.repeat(81) });
    // A pasted layout past a limit is still refused, with why.
    expect(readLayout(layoutJson(layout))).toMatchObject({ problem: 'breaks-rules' });
  });
});

describe('the try view', () => {
  const preview = (layout: AssistantLayout, client: ReturnType<typeof fakeClient>) => (
    <ServicePreview
      layout={layout}
      mode="try"
      address="byggesak.genki.no"
      run={{ api: client.api, tenant: 'eksempel', source: { definition } }}
      conversation={0}
      onMode={() => undefined}
      onRemove={() => undefined}
      onReload={() => undefined}
    />
  );

  it('draws the edited name, suggestions and a field’s label', async () => {
    const client = fakeClient(answered('Ja.'));
    const base = fromTemplate('knowledge-assistant').layout;
    const { rerender } = render(preview(base, client));
    await screen.findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
    const edited: AssistantLayout = {
      ...base,
      profile: {
        assistantName: 'Byggehjelpen',
        suggestions: ['Trenger jeg søknad for en garasje?', ''],
        corpora: { byggeregler: { fields: [{ id: 'kommune', label: 'Kommunene' }] } },
      },
    };
    await act(async () => {
      rerender(preview(edited, client));
    });
    expect(await screen.findByRole('textbox', { name: /Spørsmål til Byggehjelpen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trenger jeg søknad for en garasje?' })).toBeTruthy();
    // An empty suggestion draws no button.
    expect(screen.queryByRole('button', { name: '' })).toBeNull();
    await waitFor(() => expect(screen.getAllByText('Kommunene').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
  });
});
