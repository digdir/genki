// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  blocksIn,
  defaultLayout,
  fitService,
  fromTemplate,
  type AssistantLayout,
} from '@genai/ui-blocks/builder';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../App';
import { createApiClient } from '../../../api';
import { loadArea } from '../../../i18n/areas';
import { mockAnsattporten } from '../../../auth';
import { exampleServices, mockFetch } from '../../../mock';
import { expectAccessible, go, kari, renderAt } from '../../../test-utils';
import { InterfaceTab } from './InterfaceTab';
import { keptStart, layoutJson, readLayout, type BlocksStart } from './layoutStore';

const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  window.location.hash = '';
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  if (own) Object.defineProperty(navigator, 'clipboard', own);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

const navLink = (name: string) =>
  within(screen.getByRole('tablist', { name: /^Faner for/ })).getByRole('tab', { name });

let writes: unknown[] = [];
const recording = (base = mockFetch()): typeof fetch => {
  writes = [];
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'PUT' && url.endsWith('/draft'))
      writes.push(JSON.parse(String(init.body)) as unknown);
    return base(input, init);
  };
};

const openInterface = async (fetch = recording()) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/rapportassistenten/interface';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
  await screen.findByRole('group', { name: 'Designelementer og maler' });
  return fetch;
};

const switchIn = (group: string, name: string) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', {
    name,
  }) as HTMLInputElement;

const next = fromTemplate('knowledge-assistant-next').layout;

type Saved = { definition: { spec: { interface?: { layout?: AssistantLayout } } } };
const savedLayout = () => (writes.at(-1) as Saved | undefined)?.definition.spec.interface?.layout;

const keepStart = (tenant: string, service: string, start: BlocksStart) =>
  sessionStorage.setItem(`genki.blocks.${tenant}/${service}`, JSON.stringify(start));

describe('the Utforming tab', () => {
  it('is on the page of a service that is published, and starts from the next look of Kunnskapsassistenten', async () => {
    await openInterface();
    expect(navLink('Utforming').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Maler' }));
    expect(
      screen.getByRole('button', { name: 'Bruk Kunnskapsassistenten, nytt utseende' }).ariaPressed,
    ).toBe('true');
    expectAccessible();
  });

  it('is on the page of a new service, between Oppsett and Teknisk', async () => {
    await renderAt('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });
    fireEvent.click(screen.getByRole('button', { name: /Henter ut opplysninger/ }));
    await screen.findByText('Satte jobb: henter ut opplysninger');
    const nav = screen.getByRole('tablist', { name: /^Faner for/ });
    expect(
      within(nav)
        .getAllByRole('tab')
        .map((a) => a.textContent),
    ).toEqual(['Oppsett', 'Utforming', 'Teknisk']);
    fireEvent.click(navLink('Utforming'));
    expect(await screen.findByRole('group', { name: 'Designelementer og maler' })).toBeTruthy();
    expectAccessible();
  });

  it('has «Tekster» beside «Maler» and «Designelementer», and keeps the words with the layout', async () => {
    await openInterface();
    const switcher = within(screen.getByRole('group', { name: 'Designelementer og maler' }));
    for (const name of ['Maler', 'Designelementer', 'Tekster'])
      expect(switcher.getByRole('radio', { name })).toBeTruthy();
    fireEvent.click(switcher.getByRole('radio', { name: 'Tekster' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Navn' }), {
      target: { value: 'Rapporthjelpen' },
    });
    await waitFor(
      () => expect(savedLayout()?.profile).toEqual({ assistantName: 'Rapporthjelpen' }),
      {
        timeout: 3000,
      },
    );
    expectAccessible();
  });

  it('keeps the layout when the person goes to another tab and back', async () => {
    await openInterface();
    expect(switchIn('Høyre', 'Kilder').checked).toBe(true);
    fireEvent.click(switchIn('Høyre', 'Kilder'));
    go('#/services/rapportassistenten/setup');
    await waitFor(() => expect(navLink('Oppsett').getAttribute('aria-selected')).toBe('true'));
    go('#/services/rapportassistenten/interface');
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    expect(switchIn('Høyre', 'Kilder').checked).toBe(false);
  });
});

describe('«Kopier oppsettet»', () => {
  it('copies the layout as JSON that «Lim inn oppsett» reads back', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openInterface();
    fireEvent.click(screen.getByRole('button', { name: 'Kopier oppsettet' }));
    await screen.findByText('Oppsettet er kopiert som JSON.');
    const copied = readLayout(writeText.mock.calls[0]?.[0] ?? '');
    expect('layout' in copied && blocksIn(copied.layout, 'main')).toEqual(blocksIn(next, 'main'));
    expect('layout' in copied && copied.layout.template).toBe('knowledge-assistant-next');
  });

  it('shows the JSON to copy by hand when the browser refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await openInterface();
    fireEvent.click(screen.getByRole('button', { name: 'Kopier oppsettet' }));
    await screen.findByText(/Nettleseren lot ikke portalen kopiere/);
    const shown = (screen.getByLabelText('Oppsettet') as HTMLTextAreaElement).value;
    expect(readLayout(shown)).toMatchObject({ layout: { template: 'knowledge-assistant-next' } });
  });
});

describe('«Lim inn oppsett»', () => {
  const paste = (text: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Lim inn oppsett' }));
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
  };

  it('uses a pasted layout that keeps the rules, and saves it in the draft', async () => {
    await openInterface();
    paste(layoutJson(defaultLayout));
    await screen.findByText('Oppsettet du limte inn, er i bruk.');
    expect(switchIn('Høyre', 'Fremgangsmåte').checked).toBe(false);
    expect(switchIn('Midten', 'Fremgangsmåte').checked).toBe(true);
    await waitFor(() => expect(savedLayout()).toBeDefined(), { timeout: 3000 });
    expect(savedLayout()?.zones.main.map((placed) => placed.block)).toEqual(
      defaultLayout.zones.main.map((placed) => placed.block),
    );
  });

  it('names a text past its limit by the field «Tekster» edits it in, not by its path', async () => {
    await openInterface();
    const long = 'x'.repeat(81);
    paste(
      JSON.stringify({
        ...defaultLayout,
        profile: {
          assistantName: long,
          suggestions: ['Hva er nytt?', long.repeat(3)],
          corpora: { kudos: { label: long, fields: [{ id: 'doctype', label: long }] } },
        },
      }),
    );
    const said = screen.getByText(/^Oppsettet bryter reglene/).textContent ?? '';
    for (const text of [
      'Navn (Utformingen) er lengre enn 80 tegn.',
      'Forslag 2 (Utformingen) er lengre enn 200 tegn.',
      'Navn på samlingen (Samlingen kudos) er lengre enn 80 tegn.',
      'Navn i filteret (Samlingen kudos, Feltet doctype) er lengre enn 80 tegn.',
    ])
      expect(said).toContain(text);
    expect(said).not.toContain('profile.');
  });

  it('names a broken plural and a link that is not https by their fields in «Tekster»', async () => {
    await openInterface();
    paste(
      JSON.stringify({
        ...defaultLayout,
        profile: {
          corpora: {
            kudos: {
              typePlurals: { rapport: 'x'.repeat(129) },
              documentLinks: { digits: 'http://example.no/{id}' },
            },
          },
        },
      }),
    );
    const said = screen.getByText(/^Oppsettet bryter reglene/).textContent ?? '';
    expect(said).toContain('Flertall av dokumenttype 1 (Samlingen kudos) er lengre enn 128 tegn.');
    expect(said).toContain(
      'Nummer med bare sifre (Samlingen kudos, Lenker til dokumentene) er ikke en https-adresse.',
    );
  });

  it('names a text «Tekster» does not edit, or one of a collection whose key holds a dot, by its path', async () => {
    await openInterface();
    paste(
      JSON.stringify({
        ...defaultLayout,
        profile: {
          followUps: ['x'.repeat(201)],
          corpora: { a: { label: 'x'.repeat(81) }, 'a.label': {} },
        },
      }),
    );
    const said = screen.getByText(/^Oppsettet bryter reglene/).textContent ?? '';
    expect(said).toContain('profile.followUps[0] er lengre enn 200 tegn.');
    expect(said).toContain('Navn på samlingen (Samlingen a) er lengre enn 80 tegn.');
  });

  it('says why it refuses text that is not JSON, not a layout, or breaks a rule, and keeps the layout', async () => {
    await openInterface();
    paste('{ not json');
    expect(screen.getByText('Teksten er ikke gyldig JSON.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), {
      target: { value: '{"version":2}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    expect(screen.getByText('Teksten er ikke et oppsett av designelementer.')).toBeTruthy();
    const twice = {
      version: 1,
      zones: { primary: [{ block: 'chat' }], main: [{ block: 'chat' }], secondary: [] },
    };
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), {
      target: { value: JSON.stringify(twice) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    expect(
      screen.getByText(
        'Oppsettet bryter reglene for designelementene: Samtale kan ikke stå i feltet venstre. Samtale står flere steder.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Oppsett som JSON').getAttribute('aria-invalid')).toBe('true');
    expect(switchIn('Høyre', 'Kilder').checked).toBe(true);
    expectAccessible();
  });
});

describe('the layout in the draft', () => {
  it('keeps a block the draft cannot back yet where it was chosen, so it comes back after a reload', async () => {
    const fetch = await openInterface();
    expect(switchIn('Venstre', 'Filter').checked).toBe(true);
    fireEvent.click(switchIn('Høyre', 'Kilder'));
    await waitFor(() => expect(savedLayout()).toBeDefined(), { timeout: 3000 });
    expect(blocksIn(savedLayout() as AssistantLayout, 'primary')).toContain('filter');
    cleanup();
    await openInterface(fetch);
    expect(switchIn('Venstre', 'Filter').checked).toBe(true);
    expect(switchIn('Høyre', 'Kilder').checked).toBe(false);
  });
});

const tenant = '999888777';
const published = () =>
  structuredClone(
    exampleServices.find((d) => d.id === 'rapportassistenten')?.latest.definition,
  ) as Record<string, unknown> & { spec: Record<string, unknown> };
const withDraftLayout = (layout: unknown) => {
  const definition = published();
  definition.spec.interface = { layout };
  return recording(
    mockFetch(undefined, undefined, undefined, undefined, {
      features: { quality: { drafts: { rapportassistenten: { definition } } } },
    }),
  );
};
const interfaceWrites = () =>
  writes.filter((w) => (w as Saved).definition.spec.interface !== undefined);

describe('the layout saved in the draft', () => {
  it('writes nothing to the draft for a layout the person only opened', async () => {
    await openInterface();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(interfaceWrites()).toEqual([]);
  });

  it('opens the layout the draft holds, not the template', async () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: 'Svarhjelpen' },
    };
    await openInterface(withDraftLayout(layout));
    expect(switchIn('Høyre', 'Kilder').checked).toBe(false);
    expect(switchIn('Midten', 'Samtale').checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Tekster' }));
    expect((screen.getByRole('textbox', { name: 'Navn' }) as HTMLInputElement).value).toBe(
      'Svarhjelpen',
    );
  });

  it('opens a layout whose texts are in both languages, and keeps the other language when saving', async () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: { nb: 'Kunnskapsassistenten', en: 'The Knowledge Assistant' } },
    };
    await openInterface(withDraftLayout(layout));
    fireEvent.click(screen.getByRole('radio', { name: 'Tekster' }));
    const name = screen.getByRole('textbox', { name: 'Navn' }) as HTMLInputElement;
    expect(name.value).toBe('Kunnskapsassistenten');
    fireEvent.change(name, { target: { value: 'KA' } });
    await waitFor(
      () =>
        expect(savedLayout()?.profile).toEqual({
          assistantName: { nb: 'KA', en: 'The Knowledge Assistant' },
        }),
      { timeout: 3000 },
    );
  });

  it('will not edit a draft layout it cannot show without losing it, and writes nothing', async () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: { nb: 'Svarhjelpen', sv: 'Svarshjälpen' } },
    };
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/interface';
    render(<App auth={auth} fetch={withDraftLayout(layout)} live />);
    expect(await screen.findByText('Byggeren kan ikke endre dette oppsettet')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Designelementer og maler' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(interfaceWrites()).toEqual([]);
  });

  it('offers once to save a layout kept in this browser in the draft', async () => {
    const chat = fromTemplate('chat-only').layout;
    keepStart(tenant, 'rapportassistenten', { layout: chat });
    await openInterface();
    expect(switchIn('Høyre', 'Kilder').checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await waitFor(() => expect(savedLayout()).toEqual(chat), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
    expect(keptStart(tenant, 'rapportassistenten')).toBeUndefined();
    expectAccessible();
  });

  it('forgets a layout kept in this browser when the person discards it, and starts from the template', async () => {
    keepStart(tenant, 'rapportassistenten', { layout: fromTemplate('chat-only').layout });
    await openInterface();
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    expect(switchIn('Høyre', 'Kilder').checked).toBe(true);
    expect(keptStart(tenant, 'rapportassistenten')).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
    expect(interfaceWrites()).toEqual([]);
  });

  it('offers no layout kept in this browser when the draft already holds one', async () => {
    keepStart(tenant, 'rapportassistenten', { layout: defaultLayout });
    await openInterface(withDraftLayout(fromTemplate('chat-only').layout));
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
    expect(switchIn('Høyre', 'Kilder').checked).toBe(false);
  });
});

describe('a layout kept in this browser before drafts held it', () => {
  it('puts a kept held block back where it stood once the draft can back it', () => {
    const [tenant, service] = ['digdir', 'a'];
    const filter = { zone: 'primary' as const, placed: { block: 'filter' as const } };
    keepStart(tenant, service, { layout: defaultLayout, held: [filter] });
    // Placed and held at once: the placed one stands.
    expect(keptStart(tenant, service)?.held).toBeUndefined();
    const without = {
      ...defaultLayout,
      zones: {
        ...defaultLayout.zones,
        primary: defaultLayout.zones.primary.filter((p) => p.block !== 'filter'),
      },
    };
    keepStart(tenant, service, { layout: without, held: [filter] });
    expect(keptStart(tenant, service)?.held).toEqual([filter]);
    const start = keptStart(tenant, service) ?? { layout: without };
    const state = { layout: start.layout, chosen: {}, held: start.held };
    expect(blocksIn(fitService(state, () => true).state.layout, 'primary')).toContain('filter');
  });

  it('passes over a kept held block that is not a block, stands where it may not, or is not built', () => {
    sessionStorage.setItem(
      'genki.blocks.digdir/e',
      JSON.stringify({
        layout: { version: 1, zones: { primary: [], main: [], secondary: [] } },
        held: [
          { zone: 'primary', placed: { block: 'filter' } },
          { zone: 'primary', placed: { block: 'filter' } },
          { zone: 'secondary', placed: { block: 'filter' } },
          { zone: 'primary', placed: { block: 'nope' } },
          { zone: 'primary', placed: { block: 'projects' } },
          { zone: 'primary', placed: { block: 'threads', settings: { x: [1] } } },
          'filter',
        ],
      }),
    );
    expect(keptStart('digdir', 'e')?.held).toEqual([
      { zone: 'primary', placed: { block: 'filter' } },
    ]);
  });

  it('is kept per tenant and service, and a stored text that breaks a rule is not read', () => {
    keepStart('digdir', 'a', { layout: defaultLayout });
    keepStart('digdir', 'b', { layout: next, template: 'knowledge-assistant-next' });
    expect(keptStart('digdir', 'a')).toEqual({ layout: defaultLayout });
    expect(keptStart('digdir', 'b')?.template).toBe('knowledge-assistant-next');
    expect(keptStart('other', 'a')).toBeUndefined();
    sessionStorage.setItem(
      'genki.blocks.digdir/c',
      JSON.stringify({ layout: { version: 1, zones: { primary: [], main: [], secondary: [] } } }),
    );
    expect(keptStart('digdir', 'c')).toBeDefined();
    sessionStorage.setItem('genki.blocks.digdir/d', '{"layout":{"version":1}}');
    expect(keptStart('digdir', 'd')).toBeUndefined();
  });
});

describe('the layout when the draft changes under the open tab', () => {
  beforeAll(() => loadArea('services'));
  const definitionWith = (layout: AssistantLayout) => {
    const definition = published();
    definition.spec.interface = { layout };
    return definition;
  };
  const tab = (
    definition: Record<string, unknown>,
    onLayout: (layout: AssistantLayout) => void,
  ) => (
    <InterfaceTab
      api={createApiClient({ baseUrl: '', fetch: mockFetch(), token: () => undefined })}
      tenant={tenant}
      service="rapportassistenten"
      definition={definition}
      files={{}}
      narrow={false}
      onLayout={onLayout}
      fullscreen={false}
      backHref="#/services/rapportassistenten/interface"
      onFullscreen={() => undefined}
      onExitFullscreen={() => undefined}
    />
  );

  it('starts again from the draft when its layout changes elsewhere', async () => {
    const onLayout = vi.fn();
    const view = render(
      tab(definitionWith(fromTemplate('knowledge-assistant-next').layout), onLayout),
    );
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    expect(switchIn('Høyre', 'Kilder').checked).toBe(true);
    view.rerender(tab(definitionWith(fromTemplate('chat-only').layout), onLayout));
    await waitFor(() => expect(switchIn('Høyre', 'Kilder').checked).toBe(false));
    expect(onLayout).not.toHaveBeenCalled();
  });

  it('does not start again after its own save', async () => {
    let saved: AssistantLayout | undefined;
    const onLayout = (layout: AssistantLayout) => {
      saved = layout;
    };
    const view = render(
      tab(definitionWith(fromTemplate('knowledge-assistant-next').layout), onLayout),
    );
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    fireEvent.click(switchIn('Høyre', 'Kilder'));
    await waitFor(() => expect(saved).toBeDefined());
    fireEvent.click(screen.getByRole('radio', { name: 'Tekster' }));
    view.rerender(tab(definitionWith(saved as AssistantLayout), onLayout));
    expect((screen.getByRole('radio', { name: 'Tekster' }) as HTMLInputElement).checked).toBe(true);
  });
});
