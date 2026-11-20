// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { mockFetch } from '../mock';
import { expectAccessible, kari } from '../test-utils';

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

/** The portal against the mock API, with every call it makes and, while `failing`, failed options. */
const open = async (hash: string) => {
  const calls: Call[] = [];
  const state = { failing: false };
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (state.failing && /\/playground\/options/.test(url))
      return new Response(JSON.stringify({ title: 'Feil', status: 503 }), {
        status: 503,
        headers: { 'content-type': 'application/problem+json' },
      });
    return base(input, init);
  };
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = hash;
  const { container } = render(<App auth={auth} fetch={fetch} live />);
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

const setupPanel = () => screen.findByRole('complementary', { name: 'Oppsett' });

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

const draftPut = /\/services\/(utkast-[0-9a-f]{8})\/draft$/;

describe('the playground tabs', () => {
  it('shows Frontend first and Backend second, with Frontend at the address of the playground', async () => {
    await open('#/playground');
    const tabs = within(await views()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Frontend', 'Backend']);
    expect(await selected()).toBe('Frontend');
    expect(
      await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' }),
    ).toBeTruthy();
  });

  it('opens Backend at #/playground/backend, and the tab leads there', async () => {
    await open('#/playground');
    fireEvent.click(within(await views()).getByRole('tab', { name: 'Backend' }));
    await waitFor(() => expect(window.location.hash).toBe('#/playground/backend'));
    expect(await setupPanel()).toBeTruthy();
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

  it('keeps the service when going from Backend to Frontend and back', async () => {
    await open('#/playground?service=soknadsuttrekk');
    fireEvent.click(within(await views()).getByRole('tab', { name: 'Frontend' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/frontend?service=soknadsuttrekk'),
    );
    await waitFor(async () => expect(await selected()).toBe('Frontend'));
    fireEvent.click(within(await views()).getByRole('tab', { name: 'Backend' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/playground/backend?service=soknadsuttrekk'),
    );
  });

  it('tries the interface in Frontend with the building blocks and no builder assistant', async () => {
    const { container } = await open('#/playground');
    const switcher = await screen.findByRole('group', { name: 'Byggeklosser og maler' });
    expect(within(switcher).getByRole('radio', { name: 'Byggeklosser' })).toBeTruthy();
    expect(within(switcher).getByRole('radio', { name: 'Maler' })).toBeTruthy();
    expect(within(switcher).queryByRole('radio', { name: 'Chat' })).toBeNull();
    // The try view draws its panels in more than one pass.
    await waitFor(() => expectAccessible(container));
  });

  it('keeps the tab and the building blocks chosen when Backend fetches its setup again', async () => {
    const { state } = await open('#/playground');
    const name = await turnOffABlock();

    state.failing = true;
    go('#/playground/backend');
    const retry = await screen.findByRole('button', { name: 'Prøv igjen' });
    state.failing = false;
    fireEvent.click(retry);
    expect(await setupPanel()).toBeTruthy();
    expect(await selected()).toBe('Backend');

    fireEvent.click(within(await views()).getByRole('tab', { name: 'Frontend' }));
    expect((await switchNamed(name)).checked).toBe(false);
  });
});

describe('Lag en tjeneste av dette', () => {
  it('makes a new draft with the blocks from Frontend and the model, instructions and datasets from Backend', async () => {
    const { calls } = await open('#/playground/backend');
    const panel = await setupPanel();
    chooseEmptyStart(panel);
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Instruksjoner' }), {
      target: { value: 'Svar kort og vis kilden.' },
    });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));

    fireEvent.click(within(await views()).getByRole('tab', { name: 'Frontend' }));
    const name = await turnOffABlock();

    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && draftPut.test(c.url))).toBe(true),
    );
    const put = calls.find((c) => c.method === 'PUT' && draftPut.test(c.url));
    const id = draftPut.exec(put?.url ?? '')?.[1];
    const body = put?.body as {
      revision: number;
      definition: {
        metadata: { name: string };
        spec: {
          model: { primary: string };
          strategy: { config: { instructions: string } };
          knowledge: { datasets: { dataset: string }[] };
          interface: { layout: { zones: Record<string, { block: string }[]> } };
        };
      };
    };
    expect(body.revision).toBe(0);
    expect(body.definition.metadata.name).toBe('Ny tjeneste fra prøveområdet');
    expect(body.definition.spec.strategy.config.instructions).toBe('Svar kort og vis kilden.');
    expect(body.definition.spec.knowledge.datasets.map((d) => d.dataset)).toHaveLength(1);
    expect(body.definition.spec.model.primary).toBeTruthy();
    expect(body.definition.spec.interface.layout.zones).toBeTruthy();

    await waitFor(() => expect(window.location.hash).toBe(`#/services/${id}/setup`));
    const notice = (
      await screen.findByRole('heading', { name: 'Tjenesten er laget fra prøveområdet' })
    ).parentElement as HTMLElement;
    const [carried] = within(notice).getAllByRole('list');
    expect(
      within(carried as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['byggeklossene fra Frontend', 'modellen', 'instruksjonene', 'datasettene']);

    go(`#/services/${id}/interface`);
    expect((await switchNamed(name)).checked).toBe(false);
  });

  it('says on Oppsett what was tried and not carried over, and says it once', async () => {
    await open('#/playground/backend');
    const panel = await setupPanel();
    chooseEmptyStart(panel);
    fireEvent.click(within(panel).getByText('Ferdigheter, byggeklosser og svarform'));
    const skills = within(panel).getByRole('group', { name: 'Ferdigheter' });
    fireEvent.click(within(skills).getAllByRole('checkbox')[0] as HTMLElement);

    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    const notice = (
      await screen.findByRole(
        'heading',
        { name: 'Tjenesten er laget fra prøveområdet' },
        { timeout: 3000 },
      )
    ).parentElement as HTMLElement;
    const lists = within(notice).getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(within(lists[1] as HTMLElement).getByText('ferdighetene')).toBeTruthy();

    fireEvent.click(within(notice).getByRole('button', { name: 'Lukk' }));
    expect(
      screen.queryByRole('heading', { name: 'Tjenesten er laget fra prøveområdet' }),
    ).toBeNull();
  });

  it('does not say it again once the person has left Oppsett', async () => {
    await open('#/playground');
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    await screen.findByRole(
      'heading',
      { name: 'Tjenesten er laget fra prøveområdet' },
      { timeout: 3000 },
    );
    const setup = window.location.hash;
    go(setup.replace(/\/setup$/, '/interface'));
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    go(setup);
    await screen.findByRole('textbox', { name: 'Navn' });
    expect(
      screen.queryByRole('heading', { name: 'Tjenesten er laget fra prøveområdet' }),
    ).toBeNull();
  });

  it('carries only the blocks when Backend was never opened', async () => {
    const { calls } = await open('#/playground');
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    const notice = (
      await screen.findByRole(
        'heading',
        { name: 'Tjenesten er laget fra prøveområdet' },
        { timeout: 3000 },
      )
    ).parentElement as HTMLElement;
    const lists = within(notice).getAllByRole('list');
    expect(lists).toHaveLength(1);
    expect(
      within(lists[0] as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['byggeklossene fra Frontend']);
    expect(calls.filter((c) => c.method === 'PUT' && draftPut.test(c.url))).toHaveLength(1);
  });
});
