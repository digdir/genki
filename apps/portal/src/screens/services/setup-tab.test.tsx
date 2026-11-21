// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applySpec, type ServiceDefinition } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';
import { SetupHarness } from './setup-harness';

afterEach(cleanup);

const rename = (value: string) =>
  fireEvent.change(screen.getByLabelText('Navn'), { target: { value } });
const publicName = () => (screen.getByLabelText('Offentlig navn') as HTMLInputElement).value;

describe('Offentlig navn in the setup', () => {
  it('follows Navn while the service is unpublished and untouched', () => {
    render(<SetupHarness sections={['purpose', 'start']} initial={exampleTemplate('drafts')} />);

    rename('Svar på klager');
    expect(publicName()).toBe('svar-pa-klager__default');
    rename('Klagesvar');
    expect(publicName()).toBe('klagesvar__default');
  });

  it('keeps a hand-written public name', () => {
    render(<SetupHarness sections={['purpose', 'start']} initial={exampleTemplate('drafts')} />);

    fireEvent.change(screen.getByLabelText('Offentlig navn'), { target: { value: 'klager' } });
    rename('Klagesvar');
    expect(publicName()).toBe('klager');
  });

  it('never changes the public name of a published service', () => {
    render(
      <SetupHarness
        sections={['purpose', 'start']}
        published
        initial={exampleTemplate('drafts', 'Klagesvar')}
      />,
    );

    rename('Svar på klager');
    expect(publicName()).toBe('klagesvar__default');
  });
});

describe('variants of a service in the setup', () => {
  const ka = () =>
    applySpec(exampleTemplate('answers', 'Kunnskapsassistenten'), { exposure: { rest: true } });

  it('shows the variants in their own Varianter section next to Modell, even when no API channel is on', () => {
    render(
      <SetupHarness
        serviceId="ka"
        sections={['model', 'variants', 'start']}
        initial={exampleTemplate('answers', 'Kunnskapsassistenten')}
      />,
    );
    const add = screen.getByRole('button', { name: 'Legg til variant' });
    expect(add.closest('#sek-variants')).toBeTruthy();
    expect(document.querySelector('#sek-model')?.textContent).not.toContain('Standardvariant');
    const sections = [...document.querySelectorAll('section.setup-section')].map((e) => e.id);
    expect(sections.indexOf('sek-variants')).toBe(sections.indexOf('sek-model') + 1);
  });

  it('lists the variants, adds one and removes it again, and writes them with display names', () => {
    let latest: ServiceDefinition = ka();
    render(
      <SetupHarness
        serviceId="ka"
        sections={['variants']}
        initial={latest}
        onChange={(d) => (latest = d)}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Standardvariant' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ny variant (liten bokstav, tall og bindestrek)'), {
      target: { value: 'retrieve-only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til variant' }));
    const [, nb] = screen.getAllByLabelText('Navn på bokmål');
    const [, en] = screen.getAllByLabelText('Navn på engelsk');
    fireEvent.change(nb as HTMLElement, { target: { value: 'Bare søk' } });
    fireEvent.change(en as HTMLElement, { target: { value: 'Search only' } });

    const variants = latest.spec.variants as { id: string; title?: unknown }[];
    expect(variants.map((v) => v.id)).toEqual(['default', 'retrieve-only']);
    expect(variants[1]?.title).toEqual({ nb: 'Bare søk', en: 'Search only' });

    fireEvent.click(screen.getByRole('button', { name: 'Fjern varianten retrieve-only' }));
    expect(screen.queryByText('retrieve-only')).toBeNull();
  });

  it('leaves the aliases, overrides and own way of working of a variant alone while another is edited', () => {
    const strategy = { id: 'rag-single-shot', version: 1, config: { generate: false } };
    const kept = {
      id: 'retrieve-only',
      title: { nb: 'Bare søk', en: 'Search only' },
      aliases: [{ name: 'kunnskapsassistenten-retrieve-only__default' }],
      overrides: { generate: false },
      chat: false,
      strategy,
    };
    let latest: ServiceDefinition = applySpec(ka(), { variants: ['default', kept] });
    render(
      <SetupHarness
        serviceId="ka"
        sections={['variants']}
        initial={latest}
        onChange={(d) => (latest = d)}
      />,
    );

    const [nb] = screen.getAllByLabelText('Navn på bokmål');
    fireEvent.change(nb as HTMLElement, { target: { value: 'Standard' } });

    expect(latest.spec.variants?.[1]).toEqual(kept);
    expect(latest.spec.variants?.[0]).toEqual({ id: 'default', title: { nb: 'Standard', en: '' } });
  });
});

describe('the default instructions in the setup', () => {
  registerStrategies(platformStrategies);
  const ragDefault =
    platformStrategies.find((e) => e.id === 'rag-single-shot')?.defaultInstructions?.text.nb ?? '';
  const rag = (instructions?: string) =>
    applySpec(exampleTemplate('answers'), {
      strategy: {
        id: 'rag-single-shot',
        version: 1,
        config: instructions ? { instructions } : {},
      },
    });
  const shown = () =>
    screen.getByLabelText('Standardinstruksjonene (kan ikke endres her)') as HTMLTextAreaElement;
  const editor = () => screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

  it('shows the default instructions read-only, collapsed, when the service uses them', () => {
    render(<SetupHarness sections={['instructions']} initial={rag()} />);

    const summary = screen.getByText('Se standardinstruksjonene');
    expect(summary.closest('details')?.open).toBe(false);
    fireEvent.click(summary);
    expect(shown().value).toBe(ragDefault);
    expect(shown().readOnly).toBe(true);
    expect(screen.getByText(/plattformen legger til arbeidsinstruksene/)).toBeTruthy();
  });

  it('Bruk som utgangspunkt copies the default instructions into the editor', () => {
    let latest = rag();
    render(
      <SetupHarness sections={['instructions']} initial={latest} onChange={(d) => (latest = d)} />,
    );

    fireEvent.click(screen.getByText('Se standardinstruksjonene'));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk som utgangspunkt' }));

    expect(editor().value).toBe(ragDefault);
    expect(latest.spec.strategy.config.instructions).toBe(ragDefault);
  });

  it('offers the default for comparison, without copying, when the service has its own instructions', () => {
    render(<SetupHarness sections={['instructions']} initial={rag('Svar kort.')} />);

    fireEvent.click(screen.getByText('Sammenlign med standardinstruksjonene'));

    expect(shown().value).toBe(ragDefault);
    expect(editor().value).toBe('Svar kort.');
    expect(screen.queryByRole('button', { name: 'Bruk som utgangspunkt' })).toBeNull();
  });

  it('shows no default for a strategy without one', () => {
    render(<SetupHarness sections={['instructions']} initial={exampleTemplate('answers')} />);

    expect(screen.queryByText('Se standardinstruksjonene')).toBeNull();
  });
});

describe('the sections of the agent instructions in the setup', () => {
  registerStrategies(platformStrategies);
  const sections =
    platformStrategies.find((e) => e.id === 'agent-loop')?.defaultInstructions?.sections ?? [];
  const workflow = sections.find((s) => s.id === 'workflow')?.text ?? '';
  const agent = (config: Record<string, unknown> = {}) =>
    applySpec(exampleTemplate('answers'), {
      strategy: { id: 'agent-loop', version: 1, config },
    });
  const section = (name: string) => screen.getByLabelText(name) as HTMLTextAreaElement;

  it('shows each section with its reason and says that the instructions are added after them', () => {
    render(<SetupHarness sections={['instructions']} initial={agent()} />);

    fireEvent.click(screen.getByText('Se og endre standardinstruksjonene'));

    expect(section('Arbeidsmåte').value).toBe(workflow);
    expect(screen.getByText(/Lar agenten søke, lese og så svare/)).toBeTruthy();
    expect(screen.getByText(/kommer her, etter delene over/)).toBeTruthy();
    expect(screen.getByText(/legges til etter dem/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bruk som utgangspunkt' })).toBeNull();
  });

  it('an edited section is written to promptSections and can be reset', () => {
    let latest = agent({ maxIterations: 8 });
    render(
      <SetupHarness sections={['instructions']} initial={latest} onChange={(d) => (latest = d)} />,
    );

    fireEvent.click(screen.getByText('Se og endre standardinstruksjonene'));
    fireEvent.change(section('Arbeidsmåte'), { target: { value: 'Søk, les, svar.' } });

    expect(latest.spec.strategy.config.promptSections).toEqual({ workflow: 'Søk, les, svar.' });
    expect(latest.spec.strategy.config.instructions).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Tilbakestill Arbeidsmåte' }));

    expect(latest.spec.strategy.config).toEqual({ maxIterations: 8 });
    expect(section('Arbeidsmåte').value).toBe(workflow);
  });

  it('opens the sections when the service has changed one', () => {
    render(
      <SetupHarness
        sections={['instructions']}
        initial={agent({ promptSections: { gate: '' } })}
      />,
    );

    expect(screen.getByText('Se og endre standardinstruksjonene').closest('details')?.open).toBe(
      true,
    );
    expect(section('Kontroll (endret)').value).toBe('');
  });
});
