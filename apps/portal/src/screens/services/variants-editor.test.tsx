// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { applySpec, type ServiceDefinition, type VariantSpec } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { mockFetch } from '../../mock';
import { SetupHarness } from './setup-harness';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';

document.getAnimations ??= () => [];
afterEach(cleanup);
registerStrategies(platformStrategies);

const tenant = '999888777';
const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });

const ka = (variants?: VariantSpec[]): ServiceDefinition =>
  applySpec(exampleTemplate('answers', 'Kunnskapsassistenten'), {
    strategy: { id: 'agent-loop', version: 1, config: { maxIterations: 4 } },
    model: { primary: 'aivar/borealis-27b', residency: 'global' },
    ...(variants ? { variants } : {}),
  });

const mini = {
  id: 'mini',
  title: { nb: 'Rask', en: 'Fast' },
  aliases: [],
  overrides: {},
};

const renderVariants = (initial: ServiceDefinition, client = api) => {
  const state = { latest: initial };
  return {
    state,
    ...render(
      <SetupHarness
        serviceId="ka"
        sections={['variants']}
        initial={initial}
        onChange={(d) => (state.latest = d)}
        api={client}
        tenant={tenant}
      />,
    ),
  };
};

const card = (name: string) =>
  screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;

const published = (d: ServiceDefinition) =>
  (d.spec.variants ?? []) as unknown as Record<string, unknown>[];

describe('the way of working of a variant', () => {
  it("a variant without its own way of working shows the service's", () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, mini]));
    const row = card('Rask');

    expect(
      (within(row).getByRole('radio', { name: /Samme som tjenesten/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      within(row).getByText('Bruker arbeidsmåten til tjenesten: Agent (søker selv).'),
    ).toBeTruthy();
    const steps = within(row).getByRole('list', { name: 'Slik kjører den' });
    expect(within(steps).getByText('Planlegg')).toBeTruthy();
    expect(published(state.latest)[1]).not.toHaveProperty('strategy');
  });

  it('the default variant always uses the way of working of the service', () => {
    const config = ka(undefined);
    renderVariants(config);
    const row = card('Standardvariant');

    expect(within(row).queryByRole('radio')).toBeNull();
    expect(
      within(row).getByText('Standardvarianten bruker alltid arbeidsmåten til tjenesten.'),
    ).toBeTruthy();
    expect(row.querySelector('code')?.textContent).toBe('kunnskapsassistenten__default');
  });

  it('a variant can choose its own step flow, shown as a read-only diagram', async () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, mini]));
    const row = card('Rask');

    fireEvent.click(within(row).getByRole('radio', { name: /Egen arbeidsmåte/ }));
    fireEvent.click(await within(row).findByRole('radio', { name: /Velg selv/ }));
    fireEvent.change(within(row).getByLabelText('Arbeidsmåte for Rask'), {
      target: { value: 'step-flow' },
    });
    const flow = await within(row).findByRole('option', { name: 'postruting, versjon 2' });
    fireEvent.change(flow.closest('select') as HTMLSelectElement, {
      target: { value: 'postruting@2' },
    });

    expect(published(state.latest)[1]).toMatchObject({
      id: 'mini',
      strategy: { id: 'step-flow', version: 1, config: { flow: 'postruting@2' } },
    });
    const diagram = await within(row).findByRole('list', { name: 'Stegene i flyten' });
    expect(within(diagram).getAllByText('Klassifiser').length).toBeGreaterThan(0);
    expect(within(diagram).queryByText('Kø må fylles ut.')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Legg til steg' })).toBeNull();
    expect(within(diagram).queryByRole('button')).toBeNull();
  });

  it('a variant can choose its own strategy settings, and going back to the service drops them', async () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, mini]));
    const row = card('Rask');

    fireEvent.click(within(row).getByRole('radio', { name: /Egen arbeidsmåte/ }));
    fireEvent.click(await within(row).findByRole('radio', { name: /Velg selv/ }));
    fireEvent.change(within(row).getByLabelText('Arbeidsmåte for Rask'), {
      target: { value: 'rag-single-shot' },
    });
    expect(published(state.latest)[1]).toMatchObject({
      strategy: { id: 'rag-single-shot', version: 1 },
    });
    expect(
      within(row).getByRole('heading', { name: 'Innstillinger for arbeidsmåten' }),
    ).toBeTruthy();

    fireEvent.click(within(row).getByRole('radio', { name: /Samme som tjenesten/ }));
    expect(published(state.latest)[1]).not.toHaveProperty('strategy');
  });

  it('gives each variant fields with unique ids', () => {
    renderVariants(
      ka([
        { ...mini, id: 'default' },
        { ...mini, strategy: { id: 'single-call', version: 1, config: {} } },
        {
          ...mini,
          id: 'grundig',
          title: { nb: 'Grundig', en: 'Thorough' },
          strategy: { id: 'single-call', version: 1, config: {} },
        },
      ]),
    );
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('labels the variants in English', () => {
    render(
      inEnglish(
        <SetupHarness
          serviceId="ka"
          initial={ka([{ ...mini, id: 'default' }, mini])}
          sections={['variants']}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /^Variants/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Fast' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Same as the service/ })).toBeTruthy();
    expect(
      screen.getByText('Uses the way of working of the service: Agent (searches by itself).'),
    ).toBeTruthy();
  });
});

describe('recipes for a variant', () => {
  it('its own way of working starts from a recipe: picking one fills its plain settings and shows its steps', async () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, mini]));
    const row = card('Rask');

    fireEvent.click(within(row).getByRole('radio', { name: /Egen arbeidsmåte/ }));
    expect(
      ((await within(row).findByRole('radio', { name: /Fra en oppskrift/ })) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(
      within(row).getByRole('radio', {
        name: /Søk i bestemte dokumenttyper i rekkefølge, så svar/,
      }),
    );

    expect(published(state.latest)[1]).toMatchObject({
      strategy: {
        id: 'step-flow',
        version: 1,
        config: {
          flow: 'ordered-sources-answer@1',
          settings: { documentTypes: [], answerLength: 'short', documentField: 'type' },
        },
      },
    });
    fireEvent.click(await within(row).findByRole('checkbox', { name: 'Årsrapport' }));
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Tildelingsbrev' }));
    expect(published(state.latest)[1]).toMatchObject({
      strategy: { config: { settings: { documentTypes: ['Årsrapport', 'Tildelingsbrev'] } } },
    });
    const diagram = await within(row).findByRole('list', { name: 'Stegene i flyten' });
    expect(within(diagram).queryByRole('button')).toBeNull();
  });

  it('a variant can be taken out of the chat picker, which publishes chat: false', () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, mini]));
    const row = card('Rask');
    const toggle = within(row).getByRole('switch', {
      name: /Kan velges i chat/,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(published(state.latest)[1]).toMatchObject({ id: 'mini', chat: false });

    fireEvent.click(toggle);
    expect(published(state.latest)[1]).not.toHaveProperty('chat');
    expect(within(card('Standardvariant')).queryByRole('switch')).toBeNull();
  });

  it('the chat toggle and the recipe choice are in English on an English screen', async () => {
    render(
      inEnglish(
        <SetupHarness
          serviceId="ka"
          initial={ka([
            { ...mini, id: 'default' },
            { ...mini, strategy: { id: 'agent-loop', version: 1, config: {} } },
          ])}
          sections={['variants']}
          api={api}
          tenant={tenant}
        />,
      ),
    );
    expect(screen.getByRole('switch', { name: /Can be picked in chat/ })).toBeTruthy();
    expect(screen.getByText('The default variant can always be picked in chat.')).toBeTruthy();
    expect(await screen.findByRole('radio', { name: /From a recipe/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Answer briefly with sources/ })).toBeTruthy();
  });
});

describe('recipe versions', () => {
  const withNewerRecipe: typeof fetch = async (input, init) => {
    const response = await mockFetch()(input, init);
    if (!String(input).endsWith('/step-flows/recipes')) return response;
    const body = (await response.json()) as {
      recipes: { id: string; version: number; ref: string }[];
    };
    return new Response(
      JSON.stringify({
        recipes: body.recipes.map((r) =>
          r.id === 'answer-briefly-with-sources' ? { ...r, version: 2, ref: `${r.id}@2` } : r,
        ),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const newer = createApiClient({ baseUrl: '/api', fetch: withNewerRecipe, token: () => 'test' });
  const pinned = {
    ...mini,
    strategy: {
      id: 'step-flow',
      version: 1,
      config: {
        flow: 'answer-briefly-with-sources@1',
        settings: { answerLength: 'long', maxSources: 3, removed: true },
      },
    },
  };

  it('a variant shows the recipe version it is pinned to, marks a shared recipe, and updates only when asked', async () => {
    const { state } = renderVariants(ka([{ ...mini, id: 'default' }, pinned]), newer);
    const row = card('Rask');

    expect(await within(row).findByText('Versjon 1')).toBeTruthy();
    expect(within(row).getAllByText(/Delt av Digdir\./).length).toBeGreaterThan(0);
    expect(published(state.latest)[1]).toMatchObject({
      strategy: { config: { flow: 'answer-briefly-with-sources@1' } },
    });

    fireEvent.click(within(row).getByRole('button', { name: 'Oppdater til versjon 2' }));

    expect(published(state.latest)[1]).toMatchObject({
      strategy: {
        config: {
          flow: 'answer-briefly-with-sources@2',
          settings: { answerLength: 'long', maxSources: 3 },
        },
      },
    });
    expect(
      (published(state.latest)[1] as { strategy: { config: { settings: object } } }).strategy.config
        .settings,
    ).not.toHaveProperty('removed');
  });
});
