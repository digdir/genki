// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PlaygroundRunRequest } from '../../api/playground';
import { mockFetch } from '../../mock';
import type { PlaygroundMockOptions } from '../../mock/playground';
import { expectAccessible, renderAt } from '../../test-utils';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const question = 'Hva sier evalueringene om digital veiledning?';

const openPage = async (playground: PlaygroundMockOptions = {}) => {
  await renderAt(
    '#/playground',
    mockFetch(undefined, undefined, undefined, undefined, { features: { playground } }),
  );
  return screen.findByRole('complementary', { name: 'Oppsett' });
};

const chooseStart = (panel: HTMLElement, label: string) => {
  const select = within(panel).getByRole('combobox', { name: /^Start fra/ });
  const option = within(select).getByRole('option', { name: label }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
};

const run = async (text = question) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));
  return screen.findByRole('link', { name: 'Se kjøringen' });
};

describe('the playground page', () => {
  it('shows the page title and the compare button while the setup loads', async () => {
    const pending: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/playground/options')
        ? new Promise<Response>(() => undefined)
        : mockFetch()(input, init);
    };
    await renderAt('#/playground', pending);

    expect(await screen.findByRole('heading', { level: 1, name: 'Prøveområde' })).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Sammenlign med et annet oppsett' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('keeps the setup in a side panel next to the conversation, and a change applies to the next run', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });

    expect(within(panel).getByText('Gjelder neste kjøring')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Samtale' })).toBeTruthy();
    chooseStart(panel, 'Tomt oppsett');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tilsynsrapporter 2025' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Instruksjoner' }), {
      target: { value: 'Svar kort. Vis kilden.' },
    });
    await run();

    expect(runs[0]?.setup).toMatchObject({
      datasets: ['999888777/tilsynsrapporter-2025'],
      instructions: 'Svar kort. Vis kilden.',
      output: 'text',
    });
    expect(runs[0]?.setup.service).toBeUndefined();
    expectAccessible();
  });

  it('shows only the knowledge of a service version, since the run uses the version as it is', async () => {
    const panel = await openPage();

    expect(within(panel).queryByRole('checkbox')).toBeNull();
    expect(within(panel).queryByRole('textbox', { name: 'Instruksjoner' })).toBeNull();
  });

  it('picks the model with the model picker and counts it as a change from the start', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const panel = await openPage({ runs });

    fireEvent.click(within(panel).getByRole('button', { name: 'Bytt modell' }));
    const picker = screen.getByRole('dialog', { name: 'Velg modell' });
    fireEvent.click(within(picker).getByRole('radio', { name: /Qwen3\.8-27B/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Bruk Qwen3.8-27B' }));

    expect(
      within(panel).getByText(/^1 endring fra rapportassistenten, .*: modell\.$/),
    ).toBeTruthy();
    await run();
    expect(runs[0]?.setup.model).toBe('aivar/qwen3-8');
  });

  it('shows the timeline of the answer with each step and its duration, and a step opens to show what went in and out', async () => {
    await openPage();
    await run();

    const timeline = screen.getByRole('region', { name: 'Tidslinje for svaret' });
    const rows = within(timeline).getAllByRole('button');
    expect(rows.length).toBeGreaterThan(2);
    const model = within(timeline).getByRole('button', { name: /^Modellkall\s*·\s*Borealis-27B/ });
    expect(model.textContent).toMatch(/\d s$/);
    expect(model.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(model);
    expect(model.getAttribute('aria-expanded')).toBe('true');
    const detail = document.getElementById(model.getAttribute('aria-controls') ?? '');
    expect(detail).toBeTruthy();
    expect(
      within(detail as HTMLElement).getByRole('list', { name: 'Modellkall · Borealis-27B' }),
    ).toBeTruthy();
    expect(within(detail as HTMLElement).getByText('Tokens')).toBeTruthy();

    fireEvent.click(model);
    expect(model.getAttribute('aria-expanded')).toBe('false');
    expectAccessible();
  });

  it('marks as different only what differs between A and B', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));

    const sideA = screen.getByRole('region', { name: /^Oppsett A:/ });
    const marks = within(sideA)
      .getAllByText('Ulikt')
      .map((tag) => tag.closest('dt')?.firstChild?.textContent);
    expect(marks).toEqual(['Modell']);

    const sideB = screen.getByRole('region', { name: /^Oppsett B:/ });
    chooseStart(sideB, 'Tomt oppsett');
    expect(within(sideB).getByRole('heading', { name: /Tomt oppsett$/ })).toBeTruthy();
    expect(
      within(sideA)
        .getAllByText('Ulikt')
        .map((tag) => tag.closest('dt')?.firstChild?.textContent),
    ).toEqual(['Modell', 'Kunnskap']);
  });

  it('hides and shows the setup of one side with a button that says whether it is open', async () => {
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    const sideA = screen.getByRole('region', { name: /^Oppsett A:/ });

    const toggle = within(sideA).getByRole('button', { name: 'Skjul oppsett' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(
      within(sideA).getByRole('button', { name: 'Vis oppsett' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(within(sideA).queryByRole('combobox', { name: /Start fra/ })).toBeNull();
  });

  it('runs both setups with Enter in the question to both, and Shift+Enter adds a line', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs });
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    const input = screen.getByRole('textbox', { name: 'Spørsmål til begge' });
    fireEvent.change(input, { target: { value: question } });

    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(runs).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.compareWith).toBeTruthy();
    expect(screen.getByText(/^To kjøringer, koster som to vanlige kjøringer\./)).toBeTruthy();
  });

  it('keeps the conversation when leaving a comparison, and sends no compared answer as history', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs });
    await run();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign med et annet oppsett' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål til begge' }), {
      target: { value: 'Noe annet?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør begge' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Avslutt sammenligning' }));

    expect(screen.getAllByRole('article')).toHaveLength(1);
    await run('Og så?');
    await waitFor(() => expect(runs).toHaveLength(3));
    expect(runs[2]?.history?.map((turn) => turn.text)).toEqual([question, expect.any(String)]);
  });
});
