// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../../mock';
import { renderAt } from '../../test-utils';
import { parseRoute } from '../../hooks';
import { skillsRedirect } from '../Skills';
import { blocksBackHref } from '../skills/SkillBlockPage';

type Call = { url: string; method: string; body: unknown };

const recording = () => {
  const calls: Call[] = [];
  const inner = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return inner(input, init);
  };
  return { calls, fetch };
};

const choose = (input: HTMLElement, value: string, label: string) => {
  const item = document.createElement('data');
  item.value = value;
  item.textContent = label;
  act(() => {
    input
      .closest('ds-suggestion')
      ?.dispatchEvent(new CustomEvent('comboboxbeforeselect', { detail: item, cancelable: true }));
  });
};

const facts = async () =>
  (await screen.findByRole('heading', { level: 2, name: 'Fakta' })).closest(
    'section',
  ) as HTMLElement;

const fact = (box: HTMLElement, label: string) =>
  within(box).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

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
afterEach(() => cleanup());

describe('a model block shows the facts the API gives', () => {
  it('lists each call type of a model with the API it is called through and its maturity', async () => {
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b');
    const table = await screen.findByRole('region', {
      name: 'Typer kall Borealis-27B kan brukes til',
    });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['Chat', 'openai/chat-completions@1', 'Produksjon'],
      ['Bilde', 'openai/images@1', 'Test'],
    ]);
  });

  it('names the connection and says the processor details are recorded when they are', async () => {
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b');
    const box = await facts();
    expect(fact(box, 'Tilkobling')).toBe('aivar');
    expect(fact(box, 'Databehandler')).toBe('Registrert');
    expect(
      screen.getByText(
        /Modellen nås gjennom tilkoblingen aivar\. Databehandleropplysningene for tilkoblingen er registrert\./,
      ),
    ).toBeTruthy();
  });

  it('says no agreement is recorded when the connection has no processor record', async () => {
    await renderAt('#/building-blocks/model/foundry-openai%2Fgpt-4.1');
    const box = await facts();
    expect(fact(box, 'Tilkobling')).toBe('foundry');
    expect(fact(box, 'Databehandler')).toBe('Ingen avtale registrert');
    expect(
      screen.getByText(/Ingen databehandleravtale er registrert for tilkoblingen\./),
    ).toBeTruthy();
  });

  it('puts the facts in the order of the design: type, connection, data, processor, publisher and use', async () => {
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b');
    const labels = [...(await facts()).querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels.slice(0, 6)).toEqual([
      'Type',
      'Tilkobling',
      'Data',
      'Databehandler',
      'Utgitt av',
      'Brukes i',
    ]);
  });

  it('names who made the model under Laget av, right after the type, when the API says', async () => {
    await renderAt('#/building-blocks/model/foundry-openai%2Fgpt-4.1');
    const box = await facts();
    expect(fact(box, 'Laget av')).toBe('OpenAI');
    const labels = [...box.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels.slice(0, 3)).toEqual(['Type', 'Laget av', 'Tilkobling']);
  });
});

describe('using a model in a service', () => {
  it('asks which service, writes the model into that service draft and never publishes', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bruk i en tjeneste' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bruk Borealis-27B i en tjeneste' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const input = within(dialog).getByRole('combobox', { name: 'Hvilken tjeneste?' });
    const options = () =>
      [...dialog.querySelectorAll<HTMLOptionElement>('u-option, option')].filter((o) => o.value);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const option = options()[0] as HTMLOptionElement;
    choose(input, option.value, option.label);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk modellen' }));

    const link = await within(dialog).findByRole('link', { name: /^Åpne utkastet til / });
    expect(link.getAttribute('href')).toBe(`#/services/${option.value}/setup`);
    const saved = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith(`/services/${option.value}/draft`),
    );
    const model = (saved?.body as { definition: { spec: { model: Record<string, unknown> } } })
      .definition.spec.model;
    expect(model.primary).toBe('aivar/borealis-27b');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(false);
  });

  it('keeps the rest of the service model setting, such as residency, when it sets the model', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bruk i en tjeneste' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bruk Borealis-27B i en tjeneste' });
    const input = within(dialog).getByRole('combobox', { name: 'Hvilken tjeneste?' });
    const options = () =>
      [...dialog.querySelectorAll<HTMLOptionElement>('u-option, option')].filter((o) => o.value);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const option = options()[0] as HTMLOptionElement;
    const before = calls.find(
      (c) => c.method === 'GET' && c.url.includes(`/definitions/Service/${option.value}`),
    );
    choose(input, option.value, option.label);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk modellen' }));
    await within(dialog).findByRole('link', { name: /^Åpne utkastet til / });
    const saved = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/draft'));
    const model = (saved?.body as { definition: { spec: { model: Record<string, unknown> } } })
      .definition.spec.model;
    expect(before).toBeUndefined();
    expect(model.residency).toBe('norway');
  });

  it('asks for a service before it writes anything', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Bruk i en tjeneste' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bruk Borealis-27B i en tjeneste' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk modellen' }));
    expect(await within(dialog).findByText('Velg en tjeneste.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('required guardrails', () => {
  it('counts the required guardrails on the Sikkerhetsregler card from the list counts', async () => {
    await renderAt('#/building-blocks');
    const card = await screen.findByRole('link', { name: /^Sikkerhetsregler/ });
    expect(card.textContent).toContain('2 i bruk, 1 påkrevd');
  });

  it('marks a required guardrail on the guardrail type page', async () => {
    await renderAt('#/building-blocks/guardrail');
    const name = await screen.findByRole('link', { name: 'Filtrering av personopplysninger' });
    expect(within(name.closest('li') as HTMLElement).getByText('Påkrevd')).toBeTruthy();
    const other = screen.getByRole('link', { name: 'Kildekrav' });
    expect(within(other.closest('li') as HTMLElement).queryByText('Påkrevd')).toBeNull();
  });
});

describe('the overview of types', () => {
  it('names the tools in use in the Verktøy card', async () => {
    await renderAt('#/building-blocks');
    const card = await screen.findByRole('link', { name: /^Verktøy/ });
    expect(card.textContent).toContain('som Lovdata og Saksarkivet');
  });

  it('says step types come from Digdir', async () => {
    await renderAt('#/building-blocks');
    const card = await screen.findByRole('link', { name: /^Stegtyper/ });
    expect(card.textContent).toContain('Fra Digdir');
  });
});

describe('the step flow table', () => {
  it('dates the current version of every flow, also when no update is waiting', async () => {
    await renderAt('#/developer/step-flows');
    const row = (await screen.findByRole('link', { name: 'Postruting' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('v2 · 11. november')).toBeTruthy();
    const other = screen.getByRole('link', { name: 'Høringsoppsummering' }).closest('tr');
    expect(within(other as HTMLElement).getByText('v1 · 2. oktober')).toBeTruthy();
  });

  it('counts the steps of a flow in words', async () => {
    await renderAt('#/developer/step-flows');
    const row = (await screen.findByRole('link', { name: 'Postruting' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Testetaten · fire steg')).toBeTruthy();
  });

  it('shows the version each service pins', async () => {
    await renderAt('#/developer/step-flows');
    const row = (await screen.findByRole('link', { name: 'Postruting' })).closest(
      'tr',
    ) as HTMLElement;
    const user = within(row).getByRole('link', { name: 'Vedtaksutkast' }).closest('li');
    expect(within(user as HTMLElement).getByText('v2')).toBeTruthy();
  });
});

describe('links to the moved building block pages', () => {
  it('sends the old skills page to the skills type page', () => {
    expect(skillsRedirect(parseRoute('#/skills'))).toBe('#/building-blocks/skill');
  });

  it('takes a skill back to the building blocks overview', () => {
    expect(blocksBackHref).toBe('#/building-blocks');
  });
});
