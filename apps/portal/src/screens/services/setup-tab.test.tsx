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
  const agentDefault =
    platformStrategies.find((e) => e.id === 'agent-loop')?.defaultInstructions?.text.nb ?? '';
  const agent = (instructions?: string) =>
    applySpec(exampleTemplate('answers'), {
      strategy: {
        id: 'agent-loop',
        version: 1,
        config: instructions ? { instructions } : {},
      },
    });
  const shown = () =>
    screen.getByLabelText('Standardinstruksjonene (kan ikke endres her)') as HTMLTextAreaElement;
  const editor = () => screen.getByLabelText('Instruksjoner til tjenesten') as HTMLTextAreaElement;

  it('shows the default instructions read-only, collapsed, when the service uses them', () => {
    render(<SetupHarness sections={['instructions']} initial={agent()} />);

    const summary = screen.getByText('Se standardinstruksjonene');
    expect(summary.closest('details')?.open).toBe(false);
    fireEvent.click(summary);
    expect(shown().value).toBe(agentDefault);
    expect(shown().readOnly).toBe(true);
    expect(screen.getByText(/legger plattformen til ferdighetene/)).toBeTruthy();
  });

  it('Bruk som utgangspunkt copies the default instructions into the editor', () => {
    let latest = agent();
    render(
      <SetupHarness sections={['instructions']} initial={latest} onChange={(d) => (latest = d)} />,
    );

    fireEvent.click(screen.getByText('Se standardinstruksjonene'));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk som utgangspunkt' }));

    expect(editor().value).toBe(agentDefault);
    expect(latest.spec.strategy.config.instructions).toBe(agentDefault);
  });

  it('offers the default for comparison, without copying, when the service has its own instructions', () => {
    render(<SetupHarness sections={['instructions']} initial={agent('Svar kort.')} />);

    fireEvent.click(screen.getByText('Sammenlign med standardinstruksjonene'));

    expect(shown().value).toBe(agentDefault);
    expect(editor().value).toBe('Svar kort.');
    expect(screen.queryByRole('button', { name: 'Bruk som utgangspunkt' })).toBeNull();
  });

  it('shows no default for a strategy without one', () => {
    render(<SetupHarness sections={['instructions']} initial={exampleTemplate('answers')} />);

    expect(screen.queryByText('Se standardinstruksjonene')).toBeNull();
  });
});

describe('text recognition in the setup', () => {
  it('offers text recognition only when files can come in', () => {
    render(<SetupHarness sections={['io']} initial={exampleTemplate('answers')} />);
    fireEvent.click(screen.getByRole('button', { name: /Inn og ut/ }));
    expect(screen.queryByLabelText('Tekstgjenkjenning for skannede filer')).toBeNull();

    fireEvent.click(screen.getByLabelText('Filer (PDF, Word)'));
    expect(screen.getByLabelText('Tekstgjenkjenning for skannede filer')).toBeTruthy();
  });
});
