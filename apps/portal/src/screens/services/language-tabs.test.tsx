// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import { applySpec, type ServiceDefinition } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { LanguageInstructionTabs } from './LanguageInstructionTabs';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';

afterEach(cleanup);
registerStrategies(platformStrategies);

const api = {
  tenantEffectiveSettings: async () => ({
    'answers.languageInstructions.nb': {
      key: 'nb',
      value: 'Svar på bokmål. Skriv klarspråk.',
      source: 'default',
    },
    'answers.languageInstructions.en': {
      key: 'en',
      value: 'Use Lånekassen terms.',
      source: 'tenant',
    },
  }),
} as unknown as ApiClient;

let latest: ServiceDefinition | undefined;

const Harness = ({ initial }: { initial: ServiceDefinition }) => {
  const [definition, setDefinition] = useState(initial);
  latest = definition;
  return (
    <LanguageInstructionTabs
      api={api}
      tenant="991825827"
      definition={definition}
      patch={(edit) => setDefinition((d) => applySpec(d, edit))}
      shared={<p>Felles instruksjoner</p>}
    />
  );
};

const answers = (config: Record<string, unknown> = {}) => {
  const d = exampleTemplate('answers', 'Svar');
  return applySpec(d, { strategy: { ...d.spec.strategy, config } });
};
const configOf = () => latest?.spec.strategy.config;

describe('language tabs in the instructions section', () => {
  it('shows the shared instructions first and the inherited house style read-only per language', async () => {
    render(<Harness initial={answers()} />);
    expect(screen.getByText('Felles instruksjoner')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));
    expect((await screen.findByTestId('house-style-en')).textContent).toBe('Use Lånekassen terms.');
    expect(screen.getByText('Fra virksomheten')).toBeTruthy();
  });

  it('overrides the house style for the service only after Overstyr', async () => {
    render(<Harness initial={answers()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Bokmål' }));
    await screen.findByTestId('house-style-nb');
    fireEvent.click(screen.getByRole('button', { name: 'Overstyr' }));
    fireEvent.change(screen.getByLabelText('Husstil for denne tjenesten'), {
      target: { value: 'Skriv du-form.' },
    });
    expect(latest?.spec.settings).toEqual({
      'answers.languageInstructions.nb': 'Skriv du-form.',
    });
  });

  it('writes the service text per language to the strategy config', () => {
    render(<Harness initial={answers({ instructions: 'Svar kort.' })} />);
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));
    fireEvent.change(
      within(screen.getByTestId('language-panel-en')).getByLabelText(
        'Tekst for tjenesten på dette språket',
      ),
      { target: { value: 'Say "the grant".' } },
    );

    expect(configOf()).toEqual({
      instructions: 'Svar kort.',
      languageInstructions: { en: 'Say "the grant".' },
    });
  });

  it('writes a full prompt per language only after Skriv en egen instruksjon per språk, seeded from the shared text', () => {
    render(<Harness initial={answers({ instructions: 'Svar kort.' })} />);
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skriv en egen instruksjon per språk' }));
    fireEvent.change(
      within(screen.getByTestId('language-panel-en')).getByLabelText(
        'Hele instruksjonen på dette språket',
      ),
      {
        target: { value: 'Be brief.' },
      },
    );

    expect(configOf()?.instructions).toEqual({ nb: 'Svar kort.', en: 'Be brief.' });
  });

  it('goes back to the shared instructions and saves them as one text', () => {
    render(<Harness initial={answers({ instructions: { nb: 'Svar kort.', en: 'Be brief.' } })} />);
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk felles instruksjoner igjen' }));

    expect(configOf()?.instructions).toBe('Be brief.');
  });

  it('marks a language that has no full prompt when the others do', () => {
    render(<Harness initial={answers({ instructions: { nb: 'Svar kort.' } })} />);
    fireEvent.click(screen.getByRole('tab', { name: 'English' }));

    expect(
      within(screen.getByTestId('language-panel-en')).getByText(
        'Dette språket mangler instruksjon.',
      ),
    ).toBeTruthy();
  });
});
