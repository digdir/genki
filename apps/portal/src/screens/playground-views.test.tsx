// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { expectAccessible, kari } from '../test-utils';
import type { Organisation } from '../types';

document.getAnimations ??= () => [];
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
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const useOnly: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', 'view-usage'] },
];

/** The portal against the mock API, with every call it makes; calls matching `failing` fail. */
const open = async (
  hash: string,
  {
    live = true,
    organisations,
    failing,
  }: { live?: boolean; organisations?: Organisation[]; failing?: RegExp } = {},
) => {
  const calls: Call[] = [];
  const state = { failing };
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (state.failing?.test(`${method} ${url}`))
      return new Response(JSON.stringify({ title: 'Feil', status: 503 }), {
        status: 503,
        headers: { 'content-type': 'application/problem+json' },
      });
    return base(input, init);
  };
  const auth = mockAnsattporten(organisations ? { name: 'Ingrid Berg', organisations } : kari);
  await auth.login();
  window.location.hash = hash;
  const { container } = render(<App auth={auth} fetch={fetch} live={live} />);
  return { calls, state, container };
};

const go = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

const views = () => screen.findByRole('tablist', { name: 'Prøveområdet' });
const selected = async () =>
  within(await views())
    .getAllByRole('tab')
    .find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;
const openTab = async (name: string) =>
  fireEvent.click(within(await views()).getByRole('tab', { name }));

const setupPanel = () => screen.findByRole('complementary', { name: 'Oppsett' });
const preview = () => screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
const makeService = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));

/** Turns off the first building block that is on and can be turned off, and gives its name. */
const turnOffABlock = async () => {
  const on = (await screen.findAllByRole('switch')).find(
    (s) => (s as HTMLInputElement).checked && !(s as HTMLInputElement).disabled,
  ) as HTMLInputElement;
  const name = on.getAttribute('aria-label') ?? on.closest('label')?.textContent ?? '';
  fireEvent.click(on);
  expect(on.checked).toBe(false);
  return name;
};

const switchNamed = async (name: string) =>
  (await screen.findAllByRole('switch')).find(
    (s) => (s.getAttribute('aria-label') ?? s.closest('label')?.textContent ?? '') === name,
  ) as HTMLInputElement;

const chooseEmptyStart = (panel: HTMLElement) => {
  const select = within(panel).getByRole('combobox', { name: /^Start fra/ });
  const option = within(select).getByRole('option', {
    name: 'Tomt oppsett',
  }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
};

const instructionsIn = (panel: HTMLElement) =>
  within(panel).getByRole('textbox', { name: 'Instruksjoner' }) as HTMLTextAreaElement;

/** Tries an empty setup in Backend with its own instructions and one dataset. */
const tryInBackend = async () => {
  const panel = await setupPanel();
  chooseEmptyStart(panel);
  fireEvent.change(instructionsIn(panel), { target: { value: 'Svar kort og vis kilden.' } });
  fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));
};

const draftPut = /\/services\/(utkast-[0-9a-f]{8})\/draft$/;
const draftPuts = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PUT' && draftPut.test(c.url));

const notice = async () =>
  (
    await screen.findByRole(
      'heading',
      { name: 'Tjenesten er laget fra prøveområdet' },
      { timeout: 3000 },
    )
  ).parentElement as HTMLElement;
const items = (list: HTMLElement | undefined) =>
  within(list as HTMLElement)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('the playground tabs', () => {
  it('shows Frontend first and Backend second, with Frontend at the address of the playground', async () => {
    await open('#/playground');
    const tabs = within(await views()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Frontend', 'Backend']);
    expect(await selected()).toBe('Frontend');
    expect(await preview()).toBeTruthy();
  });

  it('opens Backend at #/playground/backend, and the tab leads there', async () => {
    await open('#/playground');
    await openTab('Backend');
    await waitFor(() => expect(window.location.hash).toBe('#/playground/backend'));
    await setupPanel();
    expect(await selected()).toBe('Backend');
  });

  it('opens a service draft from the old address #/playground?service= in Backend', async () => {
    await open('#/playground?service=soknadsuttrekk');
    expect(await selected()).toBe('Backend');
    const start = (await screen.findByRole(
      'combobox',
      { name: 'Start fra' },
      { timeout: 3000 },
    )) as HTMLSelectElement;
    await waitFor(() => expect(start.value).toMatch(/^soknadsuttrekk\//));
  });

  it('keeps the service in the address when going from Backend to Frontend and back', async () => {
    await open('#/playground?service=soknadsuttrekk');
    await openTab('Frontend');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/frontend?service=soknadsuttrekk'),
    );
    await waitFor(async () => expect(await selected()).toBe('Frontend'));
    await openTab('Backend');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/backend?service=soknadsuttrekk'),
    );
  });

  it('keeps the service in the address when the preview goes full screen and back', async () => {
    await open('#/playground/frontend?service=soknadsuttrekk');
    fireEvent.click(await screen.findByRole('button', { name: 'Vis større' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/preview?service=soknadsuttrekk'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Vis mindre' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/frontend?service=soknadsuttrekk'),
    );
  });

  it('tries the interface in Frontend with the building blocks and no builder assistant', async () => {
    await open('#/playground');
    const switcher = await screen.findByRole('group', { name: 'Byggeklosser og maler' });
    expect(within(switcher).getByRole('radio', { name: 'Byggeklosser' })).toBeTruthy();
    expect(within(switcher).getByRole('radio', { name: 'Maler' })).toBeTruthy();
    expect(within(switcher).queryByRole('radio', { name: 'Chat' })).toBeNull();
  });

  it('draws Frontend with one main heading and no accessibility problems', async () => {
    const { container } = await open('#/playground');
    await preview();
    // The try view draws its panels in more than one pass.
    await waitFor(() => expectAccessible(container));
  });

  it('keeps the Backend tab chosen when Backend fetches its setup again', async () => {
    const { state } = await open('#/playground/backend', { failing: /\/playground\/options/ });
    const retry = await screen.findByRole('button', { name: 'Prøv igjen' });
    state.failing = undefined;
    fireEvent.click(retry);
    await setupPanel();
    expect(await selected()).toBe('Backend');
  });

  it('keeps the blocks chosen in Frontend while Backend is open', async () => {
    await open('#/playground');
    const name = await turnOffABlock();
    await openTab('Backend');
    await setupPanel();
    await openTab('Frontend');
    expect((await switchNamed(name)).checked).toBe(false);
  });

  it('keeps what was typed in Backend while Frontend is open', async () => {
    await open('#/playground/backend');
    const panel = await setupPanel();
    chooseEmptyStart(panel);
    fireEvent.change(instructionsIn(panel), { target: { value: 'Svar kort.' } });
    await openTab('Frontend');
    await preview();
    await openTab('Backend');
    expect(instructionsIn(await setupPanel()).value).toBe('Svar kort.');
  });
});

describe('Lag en tjeneste av dette', () => {
  it('saves a new draft with the blocks from Frontend and the model, instructions and datasets from Backend', async () => {
    const { calls } = await open('#/playground/backend');
    await tryInBackend();
    await openTab('Frontend');
    const name = await turnOffABlock();

    makeService();
    await waitFor(() => expect(draftPuts(calls)).toHaveLength(1));
    const [put] = draftPuts(calls);
    const id = draftPut.exec(put?.url ?? '')?.[1];
    expect(put?.body).toMatchObject({
      revision: 0,
      definition: {
        metadata: { name: 'Ny tjeneste fra prøveområdet', version: 1 },
        spec: {
          model: { primary: 'aivar/borealis-27b', residency: 'norway' },
          strategy: { config: { instructions: 'Svar kort og vis kilden.' } },
          knowledge: { datasets: [{ dataset: '999888777/tilsynsrapporter-2025' }] },
        },
      },
    });
    await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}/setup`));

    go(`#/services/${id}/interface`);
    expect((await switchNamed(name)).checked).toBe(false);
  });

  it('says on Oppsett what was carried over', async () => {
    await open('#/playground/backend');
    await tryInBackend();
    makeService();
    const lists = within(await notice()).getAllByRole('list');
    expect(lists).toHaveLength(1);
    expect(items(lists[0])).toEqual([
      'grensesnittet fra Frontend',
      'modellen',
      'instruksjonene',
      'datasettene',
    ]);
  });

  it('says on Oppsett what was tried and not carried over', async () => {
    await open('#/playground/backend');
    const panel = await setupPanel();
    chooseEmptyStart(panel);
    fireEvent.click(within(panel).getByText('Ferdigheter, byggeklosser og svarform'));
    const skills = within(panel).getByRole('group', { name: 'Ferdigheter' });
    fireEvent.click(within(skills).getAllByRole('checkbox')[0] as HTMLElement);

    makeService();
    const lists = within(await notice()).getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(items(lists[1])).toEqual(['ferdighetene']);
  });

  it('carries only the blocks when Backend was never opened', async () => {
    const { calls } = await open('#/playground');
    await preview();
    makeService();
    const lists = within(await notice()).getAllByRole('list');
    expect(lists).toHaveLength(1);
    expect(items(lists[0])).toEqual(['grensesnittet fra Frontend']);
    expect(draftPuts(calls)).toHaveLength(1);
  });

  it('carries nothing from Backend when it was only opened and nothing was changed or run', async () => {
    await open('#/playground/backend');
    await setupPanel();
    makeService();
    const lists = within(await notice()).getAllByRole('list');
    expect(lists).toHaveLength(1);
    expect(items(lists[0])).toEqual(['grensesnittet fra Frontend']);
  });

  it('stops saying it once the notice is closed', async () => {
    await open('#/playground');
    await preview();
    makeService();
    fireEvent.click(within(await notice()).getByRole('button', { name: 'Lukk' }));
    expect(
      screen.queryByRole('heading', { name: 'Tjenesten er laget fra prøveområdet' }),
    ).toBeNull();
  });

  it('does not say it again once the person has left Oppsett', async () => {
    await open('#/playground');
    await preview();
    makeService();
    await notice();
    const setup = window.location.hash;
    go(setup.replace(/\/setup$/, '/interface'));
    await preview();
    go(setup);
    await screen.findByRole('textbox', { name: 'Navn' });
    expect(
      screen.queryByRole('heading', { name: 'Tjenesten er laget fra prøveområdet' }),
    ).toBeNull();
  });

  it('says it could not make the service when the draft is refused, and stays in the playground', async () => {
    const { state } = await open('#/playground');
    await preview();
    state.failing = /^PUT .*\/services\/utkast-[0-9a-f]{8}\/draft$/;
    makeService();
    const failed = await screen.findByText('Vi kunne ikke lage tjenesten. Prøv igjen om litt.');
    expect(failed.closest('[role="alert"]')).toBeTruthy();
    expect(window.location.hash).toBe('#/playground');
  });

  it('is locked with the reason, and saves nothing, without the right to manage services', async () => {
    const { calls } = await open('#/playground', { organisations: useOnly });
    await preview();
    const button = screen.getByRole('button', { name: 'Lag en tjeneste av dette' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Du trenger rettigheten/)).toBeTruthy();
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('is not offered with the example data, where a new draft cannot be opened', async () => {
    await open('#/playground', { live: false });
    await preview();
    expect(screen.queryByRole('button', { name: 'Lag en tjeneste av dette' })).toBeNull();
  });
});
